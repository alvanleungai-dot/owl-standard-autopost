// Tests for poster-regen.mjs — redrawing one poster from the concept already on disk.
import test from "node:test";
import assert from "node:assert/strict";
import { RegenUnsupportedError, regenCommand, regeneratePoster, planTmlRegen, regenerateTmlPoster } from "./poster-regen.mjs";

const post = (extra = {}) => ({ slug: "2026-08-24-01", ...extra });

// Was three divorce brands; pruned to Owl Standard, which inherited better-life's gen-poster-v4.mjs
// argument shape when that script was retargeted to Owl Standard's paths.
test("each wired brand gets its own verified argument shape", () => {
  const os = regenCommand("owl-standard", post({ direction: "infographic" }), { conceptPath: "C.txt" });
  assert.ok(os[0].endsWith("gen-poster-v4.mjs"));
  assert.deepEqual(os.slice(1), ["infographic", "2026-08-24-01", "tl", "C.txt", "--no-report", "--force"]);
});

test("every wired brand forces the overwrite — a redraw that refuses to overwrite is a no-op", () => {
  for (const [brand, extra] of [["owl-standard", { direction: "flat" }]]) {
    assert.ok(regenCommand(brand, post(extra), { conceptPath: "C.txt" }).includes("--force"), brand);
  }
});

test("regenCommand rejects unknown brands", () => {
  // The tml case (in-process redraw, not a script) went with the tml deletion.
  assert.throws(() => regenCommand("nope", post(), { conceptPath: "C.txt" }), RegenUnsupportedError);
});

test("an unknown brand is reported, not thrown — one brand must not kill a sweep over all four", async () => {
  const r = await regeneratePoster("nope", post(), { exists: () => true, run: () => { throw new Error("unreachable"); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown brand/);
});

// ── tml, WIRED 2026-08-04 ─────────────────────────────────────────────────────────────────────────
// Declared unsupported for a good reason (its poster is a function call, not a <slug> <concept>
// script) — but that meant three withheld tml posters could NEVER self-heal, one of them garbled by
// the missing CJK font that a redraw now fixes. "It cannot fix itself" is a finding to close.

test("tml routes to the in-process redraw, never to a spawned script", async () => {
  let spawned = false;
  let got = null;
  const r = await regeneratePoster("tml", post({ type: "edu", topic: "濕疹與食物" }), {
    run: () => { spawned = true; },
    tmlRegen: async (p) => { got = p; return { ok: true, reason: "redrawn" }; },
  });
  assert.equal(spawned, false, "tml has no script to spawn — spawning one would silently no-op");
  assert.equal(r.ok, true);
  assert.equal(got.topic, "濕疹與食物");
});

test("planTmlRegen reads what each post TYPE actually needs", () => {
  assert.deepEqual(planTmlRegen({ slug: "s", type: "edu", topic: "T" }), { ok: true, kind: "edu", topic: "T" });
  const caseData = { name: "A", bodyPartChinese: "手" };
  assert.deepEqual(planTmlRegen({ slug: "s", type: "case", caseData }), { ok: true, kind: "case", caseData });
});

test("NEGATIVE: planTmlRegen refuses to invent what the record does not carry", () => {
  // Same rule as the missing-concept guard: never manufacture content to fix a drawing defect.
  assert.equal(planTmlRegen({ slug: "s", type: "edu" }).ok, false);
  assert.match(planTmlRegen({ slug: "s", type: "edu" }).reason, /refusing to invent one/);
  assert.equal(planTmlRegen({ slug: "s", type: "case" }).ok, false);
  assert.match(planTmlRegen({ slug: "s", type: "case" }).reason, /refusing to invent one/);
  assert.equal(planTmlRegen({ slug: "s", type: "mystery" }).ok, false);
  assert.equal(planTmlRegen({}).ok, false);
  assert.equal(planTmlRegen(null).ok, false);
});

test("tml edu redraws FORCE the overwrite and stay silent on the review channel", async () => {
  const calls = [];
  const r = await regenerateTmlPoster({ slug: "2026-09-14-01", type: "edu", topic: "T" }, {
    genEduPoster: async (...args) => { calls.push(args); },
    genImage: async () => { throw new Error("wrong path"); },
  });
  assert.equal(r.ok, true);
  const [topic, slug, , opts] = calls[0];
  assert.equal(topic, "T");
  assert.equal(slug, "2026-09-14-01");
  assert.equal(opts.force, true, "a redraw that refuses to overwrite the defective poster is a no-op");
  assert.equal(opts.report, false, "a repair must not re-notify the owner about a post he already reviewed");
});

test("tml case redraws go to the Gemini path with the stored case data", async () => {
  let seen = null;
  const caseData = { name: "A" };
  const r = await regenerateTmlPoster({ slug: "s", type: "case", caseData }, {
    genEduPoster: async () => { throw new Error("wrong path"); },
    genImage: async (c, path, opts) => { seen = { c, path, opts }; },
    posterPath: "/x/s.png",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.c, caseData);
  assert.equal(seen.path, "/x/s.png");
  assert.equal(seen.opts.force, true);
});

test("a tml generator failure is reported, not thrown", async () => {
  const r = await regenerateTmlPoster({ slug: "s", type: "edu", topic: "T" }, {
    genEduPoster: async () => { throw new Error("gpt-image 500"); },
    genImage: async () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /gpt-image 500/);
});

test("a missing concept stops the redraw instead of rewriting reviewed copy", async () => {
  let ran = false;
  const r = await regeneratePoster("owl-standard", post({ direction: "infographic" }), { exists: () => false, run: () => { ran = true; } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no concept file/);
  assert.equal(ran, false, "must not invent a concept to fix a drawing defect");
});

test("a generator failure is reported, not thrown", async () => {
  const r = await regeneratePoster("owl-standard", post({ direction: "infographic" }), {
    exists: () => true,
    run: () => { throw new Error("image API 500"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /image API 500/);
});

test("a successful redraw reports ok", async () => {
  let argv = null;
  const r = await regeneratePoster("owl-standard", post({ direction: "infographic" }), { exists: () => true, run: (a) => { argv = a; } });
  assert.equal(r.ok, true);
  assert.ok(argv.includes("--force"));
});
