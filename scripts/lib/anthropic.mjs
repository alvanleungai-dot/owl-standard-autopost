// lib/anthropic.mjs — minimal fetch-based Claude helper (no SDK) for SHORT text/JSON tasks.
// Model: Claude Haiku 4.5. Reads ANTHROPIC_API_KEY from process.env first,
// with the project .env as a local-only convenience.
//
//   import { askText, askJSON } from "./lib/anthropic.mjs";
//   const txt = await askText("…", { system: "…" });
//   const obj = await askJSON("…", schema, { system: "…" });   // schema = strict JSON Schema
//
// Smoke test:  node scripts/lib/anthropic.mjs
import { fileURLToPath } from "node:url";
import { getEnv } from "./env.mjs";
import { AI_TEXT_HTTP_TIMEOUT_MS, fetchWithDeadline } from "./http-deadline.mjs";

const API_KEY = getEnv("ANTHROPIC_API_KEY");
export const MODEL = "claude-haiku-4-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Low-level call. Retries 429 / 5xx with linear backoff. Returns the parsed response JSON.
async function call(body, { retries = 3, model = MODEL } = {}) {
  if (!API_KEY) throw new Error("No ANTHROPIC_API_KEY configured");
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetchWithDeadline(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, ...body }),
    }, { timeoutMs: AI_TEXT_HTTP_TIMEOUT_MS, label: "Anthropic messages" });
    if (r.ok) return r.json();
    last = await r.text();
    if (r.status === 429 || r.status >= 500) { await sleep(1200 * (attempt + 1)); continue; }
    throw new Error(`Anthropic ${r.status}: ${last.slice(0, 300)}`);
  }
  throw new Error(`Anthropic failed after retries: ${String(last).slice(0, 300)}`);
}

function textOf(resp) {
  if (resp.stop_reason === "refusal") throw new Error("Claude refused the request");
  return (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// Plain-text generation.
export async function askText(prompt, { system, maxTokens = 1024 } = {}) {
  const resp = await call({
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: prompt }],
  });
  return textOf(resp);
}

// JSON generation. `schema` = a STRICT JSON Schema (root object, `additionalProperties:false`,
// every key in `required`, no string-length / numeric constraints). Returns the parsed object.
export async function askJSON(prompt, schema, { system, maxTokens = 2048 } = {}) {
  const resp = await call({
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  const raw = textOf(resp);
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/[[{][\s\S]*[\]}]/); // fallback: pull the first JSON value out
    if (m) return JSON.parse(m[0]);
    throw new Error(`Could not parse JSON from Claude: ${raw.slice(0, 200)}`);
  }
}

// Vision + JSON. Used by poster-qa.mjs to LOOK at a finished poster before it is published — the
// image model is the only stochastic component in the engine, and a green exit code cannot see a
// three-handed mascot or a garbled button.
export async function askImageJSON({ prompt, schema, image, system, maxTokens = 1024, model }) {
  const resp = await call({
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    output_config: { format: { type: "json_schema", schema } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
        { type: "text", text: prompt },
      ],
    }],
  }, model ? { model } : {});
  const raw = textOf(resp);
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/[[{][\s\S]*[\]}]/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`Could not parse JSON from Claude vision: ${raw.slice(0, 200)}`);
  }
}

// --- smoke test ---
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log("MODEL:", MODEL, "| key:", API_KEY ? "present" : "MISSING");
  console.log("text →", await askText("用一句簡單廣東話講『你好』，唔好任何解釋。"));
  const j = await askJSON(
    "Propose 3 short Hong Kong divorce-consultancy social post topic ideas.",
    {
      type: "object", additionalProperties: false, required: ["topics"],
      properties: {
        topics: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } },
        },
      },
    },
  );
  console.log("json →", JSON.stringify(j));
}
