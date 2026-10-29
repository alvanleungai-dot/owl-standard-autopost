// Tests for the pluggable image backend. The Higgsfield path is asynchronous (create -> poll ->
// download), which is three more failure modes than the OpenAI path had — so each one is pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  backendName, DEFAULT_BACKEND, firstUrl, statusOf, generateHiggsfield, ImageBackendError, aspectRatio,
} from "./image-backend.mjs";

const original = { ...process.env };
test.afterEach(() => {
  for (const k of ["IMAGE_BACKEND", "HIGGSFIELD_API_KEY_ID", "HIGGSFIELD_API_KEY_SECRET", "HIGGSFIELD_MODEL", "HIGGSFIELD_PARAMS", "HIGGSFIELD_ENDPOINT"]) {
    if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k];
  }
});

const withCreds = () => {
  process.env.HIGGSFIELD_API_KEY_ID = "id";
  process.env.HIGGSFIELD_API_KEY_SECRET = "secret";
};
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const png = (bytes) => ({ status: 200, ok: true, arrayBuffer: async () => new Uint8Array(bytes).buffer });
const base = { prompt: "p", width: 1024, height: 1536, label: "t", log: () => {}, wait: async () => {} };

test("higgsfield is the default backend", () => {
  delete process.env.IMAGE_BACKEND;
  assert.equal(DEFAULT_BACKEND, "higgsfield");
  assert.equal(backendName(), "higgsfield");
});

test("IMAGE_BACKEND is case/whitespace tolerant", () => {
  process.env.IMAGE_BACKEND = "  OpenAI ";
  assert.equal(backendName(), "openai");
});

test("missing Higgsfield credentials fail closed and name BOTH variables", async () => {
  delete process.env.HIGGSFIELD_API_KEY_ID;
  delete process.env.HIGGSFIELD_API_KEY_SECRET;
  await assert.rejects(() => generateHiggsfield({ ...base }), (e) => {
    assert.ok(e instanceof ImageBackendError);
    assert.match(e.message, /HIGGSFIELD_API_KEY_ID/);
    assert.match(e.message, /HIGGSFIELD_API_KEY_SECRET/);
    return true;
  });
});

test("a completed job downloads the image and reports the model", async () => {
  withCreds();
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(url);
    if (calls.length === 1) return res(200, { request_id: "req-1", status: "queued" });
    if (calls.length === 2) return res(200, { status: "completed", images: [{ url: "https://cdn.test/a.png" }] });
    return png([1, 2, 3]);
  };
  const out = await generateHiggsfield({ ...base, fetcher });
  assert.deepEqual([...out.buffer], [1, 2, 3]);
  assert.match(out.model, /^higgsfield\//);
  assert.match(calls[0], /text-to-image$/, "must POST the generate endpoint");
  assert.match(calls[1], /\/requests\/req-1\/status$/, "must poll the documented status path");
});

test("it keeps polling through non-terminal states", async () => {
  withCreds();
  const states = ["queued", "in_progress", "in_progress"];
  let n = 0;
  const fetcher = async () => {
    n++;
    if (n === 1) return res(200, { request_id: "r", status: "queued" });
    const s = states[n - 2];
    if (s) return res(200, { status: s });
    if (n === 5) return res(200, { status: "completed", images: ["https://cdn.test/b.png"] });
    return png([9]);
  };
  const out = await generateHiggsfield({ ...base, fetcher });
  assert.deepEqual([...out.buffer], [9]);
});

test("a failed/nsfw/canceled job THROWS rather than yielding no poster", async () => {
  withCreds();
  for (const state of ["failed", "nsfw", "canceled"]) {
    const fetcher = async (_u, _i) => res(200, { request_id: "r", status: state });
    await assert.rejects(
      () => generateHiggsfield({ ...base, fetcher }),
      (e) => { assert.match(e.message, new RegExp(state)); return true; },
      `${state} must throw`,
    );
  }
});

test("a create response with no request id throws instead of polling nothing", async () => {
  withCreds();
  const fetcher = async () => res(200, { ok: true });
  await assert.rejects(() => generateHiggsfield({ ...base, fetcher }), /no request id/);
});

test("a completed job with an unrecognised payload shape throws loudly", async () => {
  withCreds();
  let n = 0;
  const fetcher = async () => (++n === 1
    ? res(200, { request_id: "r", status: "queued" })
    : res(200, { status: "completed", something_unexpected: true }));
  await assert.rejects(() => generateHiggsfield({ ...base, fetcher }), /no image URL was found/);
});

test("polling stops at the deadline instead of looping forever", async () => {
  withCreds();
  let t = 0;
  const fetcher = async () => (t === 0 ? res(200, { request_id: "r", status: "queued" }) : res(200, { status: "queued" }));
  await assert.rejects(
    () => generateHiggsfield({ ...base, fetcher, now: () => (t += 60_000) }),
    /did not reach a terminal state/,
  );
});

test("an HTTP error from the API surfaces the status and body", async () => {
  withCreds();
  const fetcher = async () => res(402, { error: "insufficient credits" });
  await assert.rejects(() => generateHiggsfield({ ...base, fetcher }), /HTTP 402.*insufficient credits/);
});

test("firstUrl reads every documented-plausible result shape, and rejects non-URLs", () => {
  const u = "https://cdn.test/x.png";
  assert.equal(firstUrl({ images: [{ url: u }] }), u);
  assert.equal(firstUrl({ images: [u] }), u);
  assert.equal(firstUrl({ results: [{ image_url: u }] }), u);
  assert.equal(firstUrl({ result: { images: [{ raw: { url: u } }] } }), u);
  assert.equal(firstUrl({ url: u }), u);
  assert.equal(firstUrl({ images: [{ url: "not-a-url" }] }), null);
  assert.equal(firstUrl({}), null);
});

test("statusOf tolerates status/state and is case-insensitive", () => {
  assert.equal(statusOf({ status: "COMPLETED" }), "completed");
  assert.equal(statusOf({ state: "Failed" }), "failed");
  assert.equal(statusOf({}), "");
});

// The documented API takes an aspect_ratio ENUM, not pixel dimensions. Sending width/height would be
// rejected or ignored, so the conversion is part of the contract.
test("pixel dimensions are converted to the nearest supported aspect_ratio", () => {
  assert.equal(aspectRatio(1024, 1536), "2:3", "the poster canvas");
  assert.equal(aspectRatio(1920, 1080), "16:9");
  assert.equal(aspectRatio(1000, 1000), "1:1");
  assert.equal(aspectRatio(1080, 1920), "9:16");
  assert.equal(aspectRatio(1030, 1540), "2:3", "near-misses snap to the nearest supported ratio");
});

test("the request body sends aspect_ratio, never width/height", async () => {
  withCreds();
  let body;
  let n = 0;
  const fetcher = async (_u, init) => {
    if (++n === 1) { body = JSON.parse(init.body); return res(200, { request_id: "r", status: "queued" }); }
    if (n === 2) return res(200, { status: "completed", images: ["https://cdn.test/c.png"] });
    return png([7]);
  };
  await generateHiggsfield({ ...base, fetcher });
  assert.equal(body.aspect_ratio, "2:3");
  assert.equal(body.width, undefined, "width must not be sent — the API does not accept it");
  assert.equal(body.height, undefined, "height must not be sent — the API does not accept it");
  assert.equal(body.prompt, "p");
});

test("HIGGSFIELD_PARAMS merges model-specific fields, and rejects malformed JSON", async () => {
  withCreds();
  process.env.HIGGSFIELD_PARAMS = '{"seed":42,"safety_tolerance":3}';
  let body;
  let n = 0;
  const fetcher = async (_u, init) => {
    if (++n === 1) { body = JSON.parse(init.body); return res(200, { request_id: "r", status: "queued" }); }
    if (n === 2) return res(200, { status: "completed", images: ["https://cdn.test/d.png"] });
    return png([5]);
  };
  await generateHiggsfield({ ...base, fetcher });
  assert.equal(body.seed, 42);
  assert.equal(body.safety_tolerance, 3);

  process.env.HIGGSFIELD_PARAMS = "not json";
  await assert.rejects(() => generateHiggsfield({ ...base, fetcher }), /HIGGSFIELD_PARAMS is not a valid JSON object/);
});

test("HIGGSFIELD_ENDPOINT overrides the guessed default", async () => {
  withCreds();
  process.env.HIGGSFIELD_ENDPOINT = "/some/other/model/text-to-image";
  const calls = [];
  let n = 0;
  const fetcher = async (url) => {
    calls.push(url);
    if (++n === 1) return res(200, { request_id: "r", status: "queued" });
    if (n === 2) return res(200, { status: "completed", images: ["https://cdn.test/e.png"] });
    return png([3]);
  };
  await generateHiggsfield({ ...base, fetcher });
  assert.match(calls[0], /\/some\/other\/model\/text-to-image$/);
});
