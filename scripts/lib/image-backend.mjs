// lib/image-backend.mjs — where poster artwork comes from. One prompt in, image bytes out.
//
// TWO BACKENDS, selected by IMAGE_BACKEND (default "higgsfield"):
//   higgsfield — the owner's existing Higgsfield account (no separate OpenAI image spend)
//   openai     — gpt-image-2, the original path, kept as a fallback
//
// WHY BOTH, RATHER THAN A STRAIGHT SWAP:
//   These posters render Traditional Chinese INSIDE the image (headline, four card labels, a
//   pull-quote). gpt-image-2 was chosen upstream precisely because its Chinese glyph accuracy is high
//   where DALL-E-class models garbled it. Higgsfield's Chinese accuracy is UNVERIFIED as of 2026-08-25
//   — the owner is testing it by hand. Keeping both behind one interface means a bad result is one env
//   var away from reverting rather than a rewrite, and the two can be compared on identical prompts.
//
// SHAPE DIFFERENCE the caller does not have to care about:
//   OpenAI is synchronous and returns base64. Higgsfield is asynchronous — POST returns a request id,
//   you poll until a terminal state, then download the result URL. Both normalise to:
//     await generateImage(...) -> { buffer, model }
import { getEnv } from "./env.mjs";
import { AI_IMAGE_HTTP_TIMEOUT_MS, MEDIA_HTTP_TIMEOUT_MS, fetchWithDeadline } from "./http-deadline.mjs";

export const DEFAULT_BACKEND = "higgsfield";
export const backendName = () => (getEnv("IMAGE_BACKEND") || DEFAULT_BACKEND).trim().toLowerCase();

export class ImageBackendError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ImageBackendError";
    this.kind = "image_backend";
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────────────────────────
const OPENAI_CHAIN = ["gpt-image-2", "gpt-image-2-2026-04-21", "gpt-image-1"];

async function generateOpenAI({ prompt, size, label, modelOverride, log }) {
  const key = getEnv("OPENAI_API_KEY");
  if (!key) throw new ImageBackendError("IMAGE_BACKEND=openai but OPENAI_API_KEY is not configured");
  const chain = modelOverride ? [modelOverride] : OPENAI_CHAIN;
  let status, txt;
  for (const model of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      log(`Generating [${label}] via openai/${model} (attempt ${attempt})...`);
      const r = await fetchWithDeadline("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, size, n: 1, quality: getEnv("IMG_QUALITY") || "high" }),
      }, { timeoutMs: AI_IMAGE_HTTP_TIMEOUT_MS, label: `OpenAI image generation ${label}` });
      status = r.status; txt = await r.text();
      if (status === 200) {
        const b64 = JSON.parse(txt)?.data?.[0]?.b64_json;
        if (!b64) throw new ImageBackendError(`openai/${model} returned 200 with no image data`);
        return { buffer: Buffer.from(b64, "base64"), model: `openai/${model}` };
      }
      log(`  openai/${model} -> HTTP ${status}: ${txt.slice(0, 160).replace(/\s+/g, " ")}`);
      if (status < 500) break; // a 4xx will not fix itself on retry
    }
  }
  throw new ImageBackendError(`all OpenAI image models failed (last HTTP ${status})`);
}

// ── Higgsfield ────────────────────────────────────────────────────────────────────────────────────
// Docs: https://docs.higgsfield.ai/docs (openapi.json + quickstart)
//   POST  https://api.higgsfield.ai<endpoint>   -> { request_id }
//   Auth  Authorization: Key <HIGGSFIELD_API_KEY_ID>:<HIGGSFIELD_API_KEY_SECRET>
//   Poll  GET /requests/{request_id}/status until terminal (completed | failed | nsfw | canceled)
//
// ENDPOINT IS CONFIGURABLE, AND SETTING IT CORRECTLY MATTERS MORE THAN ANYTHING ELSE HERE.
// Higgsfield hosts 15+ image models including GPT Image 2 — which is the one this pipeline wants,
// because these posters render Traditional Chinese INSIDE the image and GPT Image is what the upstream
// project chose for exactly that reason. But the endpoint path per model is account-dependent and the
// public docs only spell out two: `flux-pro/kontext/max/text-to-image` and `/v1/text2image/soul`
// (official Node SDK + openapi.json). The GPT Image path is not published, so it must come from the
// account dashboard or Higgsfield support — do not guess it. The default below is Flux Pro purely
// because it is the one documented text-to-image path; it is NOT the intended production model.
// Set HIGGSFIELD_ENDPOINT to the GPT Image path once you have it.
const HF_BASE = "https://api.higgsfield.ai";
const HF_GENERATE_PATH = () => getEnv("HIGGSFIELD_ENDPOINT") || "/flux-pro/kontext/max/text-to-image";
const HF_STATUS_PATH = (id) => `/requests/${encodeURIComponent(id)}/status`;
const HF_TERMINAL = new Set(["completed", "failed", "nsfw", "canceled", "cancelled"]);
const HF_POLL_INTERVAL_MS = 5_000;
const HF_POLL_TIMEOUT_MS = AI_IMAGE_HTTP_TIMEOUT_MS; // same overall ceiling as the OpenAI path

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Aspect ratios the documented API accepts. Anything else is rejected, so map to the NEAREST
// supported ratio rather than passing an unsupported one through.
const HF_RATIOS = { "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1, "3:4": 3 / 4, "9:16": 9 / 16,
  "2:3": 2 / 3, "1:2": 1 / 2, "2:1": 2, "4:5": 4 / 5, "3:2": 3 / 2 };
export function aspectRatio(width, height) {
  const target = width / height;
  let best = "2:3", bestGap = Infinity;
  for (const [name, value] of Object.entries(HF_RATIOS)) {
    const gap = Math.abs(value - target);
    if (gap < bestGap) { best = name; bestGap = gap; }
  }
  return best;
}

// Escape hatch for model-specific fields (seed, safety_tolerance, ...) without a code change.
function parseExtraParams() {
  const raw = getEnv("HIGGSFIELD_PARAMS");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed;
  } catch (e) {
    throw new ImageBackendError(`HIGGSFIELD_PARAMS is not a valid JSON object: ${e.message}`);
  }
}

function hfAuth() {
  const id = getEnv("HIGGSFIELD_API_KEY_ID"), secret = getEnv("HIGGSFIELD_API_KEY_SECRET");
  if (!id || !secret) {
    throw new ImageBackendError(
      "IMAGE_BACKEND=higgsfield but HIGGSFIELD_API_KEY_ID / HIGGSFIELD_API_KEY_SECRET are not both set. " +
      "Get them from cloud.higgsfield.ai -> API. A web-app subscription alone does not include API access.",
    );
  }
  return `Key ${id}:${secret}`;
}

// The status payload shape is not fully pinned in the public quickstart, so read defensively across
// the plausible shapes. An unrecognised shape must FAIL LOUDLY below, never silently yield no poster.
export const firstUrl = (job) => {
  const pools = [job?.images, job?.results, job?.result?.images, job?.output, job?.data];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const item of pool) {
      const url = typeof item === "string" ? item : (item?.url || item?.image_url || item?.raw?.url);
      if (typeof url === "string" && /^https?:\/\//.test(url)) return url;
    }
  }
  const direct = job?.url || job?.image_url;
  return typeof direct === "string" && /^https?:\/\//.test(direct) ? direct : null;
};
export const statusOf = (job) => String(job?.status ?? job?.state ?? "").toLowerCase();

async function hfJson(url, init, label, fetcher) {
  const r = await fetcher(url, init, { timeoutMs: AI_IMAGE_HTTP_TIMEOUT_MS, label });
  const txt = await r.text();
  if (r.status < 200 || r.status >= 300) {
    throw new ImageBackendError(`Higgsfield ${label} -> HTTP ${r.status}: ${txt.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  try { return JSON.parse(txt); }
  catch { throw new ImageBackendError(`Higgsfield ${label} returned non-JSON: ${txt.slice(0, 200)}`); }
}

export async function generateHiggsfield({
  prompt, width, height, label, log = console.log,
  now = () => Date.now(), wait = sleep, fetcher = fetchWithDeadline,
}) {
  const headers = { authorization: hfAuth(), "content-type": "application/json" };
  const model = getEnv("HIGGSFIELD_MODEL");

  // The documented API takes an aspect_ratio ENUM, not pixel dimensions — sending width/height would
  // be rejected or silently ignored. Callers still think in pixels (the composite step needs exact
  // sizes), so convert here and let sharp resize the returned image to the exact canvas.
  const ratio = aspectRatio(width, height);
  const extra = parseExtraParams();

  log(`Generating [${label}] via higgsfield (${ratio}, from ${width}x${height})...`);
  const created = await hfJson(`${HF_BASE}${HF_GENERATE_PATH()}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, aspect_ratio: ratio, ...(model ? { model } : {}), ...extra }),
  }, `create ${label}`, fetcher);

  const id = created?.request_id || created?.id || created?.job_id;
  if (!id) {
    throw new ImageBackendError(
      `Higgsfield accepted the request but returned no request id: ${JSON.stringify(created).slice(0, 200)}`,
    );
  }

  const deadline = now() + HF_POLL_TIMEOUT_MS;
  let job = created, state = statusOf(created);
  while (!HF_TERMINAL.has(state)) {
    if (now() > deadline) {
      throw new ImageBackendError(
        `Higgsfield job ${id} did not reach a terminal state within ${HF_POLL_TIMEOUT_MS / 1000}s ` +
        `(last status: ${state || "unknown"})`,
      );
    }
    await wait(HF_POLL_INTERVAL_MS);
    job = await hfJson(`${HF_BASE}${HF_STATUS_PATH(id)}`, { headers }, `poll ${label}`, fetcher);
    state = statusOf(job);
  }
  if (state !== "completed") {
    throw new ImageBackendError(`Higgsfield job ${id} ended as "${state}" — no image produced`);
  }

  const url = firstUrl(job);
  if (!url) {
    throw new ImageBackendError(
      `Higgsfield job ${id} completed but no image URL was found: ${JSON.stringify(job).slice(0, 300)}`,
    );
  }

  const img = await fetcher(url, {}, { timeoutMs: MEDIA_HTTP_TIMEOUT_MS, label: `Higgsfield download ${label}` });
  if (!img.ok) throw new ImageBackendError(`Higgsfield result download failed: HTTP ${img.status}`);
  return { buffer: Buffer.from(await img.arrayBuffer()), model: `higgsfield/${model || "soul-v2-standard"}` };
}

// ── public API ────────────────────────────────────────────────────────────────────────────────────
/** Generate one poster image. Returns { buffer, model }. Throws ImageBackendError on any failure. */
export async function generateImage({ prompt, width, height, label, modelOverride, log = console.log }) {
  const backend = backendName();
  if (backend === "openai") {
    return generateOpenAI({ prompt, size: `${width}x${height}`, label, modelOverride, log });
  }
  if (backend === "higgsfield") {
    return generateHiggsfield({ prompt, width, height, label, log });
  }
  throw new ImageBackendError(`unknown IMAGE_BACKEND "${backend}" — expected "higgsfield" or "openai"`);
}
