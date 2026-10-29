// scripts/lib/poster-qa-memo.test.mjs — the pass memo, proven in BOTH directions, offline.
//
// Why this file exists: until 2026-08-02 the sweep wrote nothing when a poster passed, so the
// daily 06:00 job re-inspected every clean upcoming poster forever — a paid Sonnet vision call
// re-deriving a verdict it already had. The memo fixes that. A memo that is too eager is far
// worse than the waste it replaces: it would wave a BROKEN poster through to four live client
// accounts. So the skip predicate is asserted to say NO in every case where it must.
//
//   node --test scripts/lib/poster-qa-memo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// The predicate exactly as poster-qa-sweep.mjs applies it. Kept in lockstep by the guard test at
// the bottom, which reads the sweep source and fails if the shapes drift apart.
const shouldSkip = (post, hash, model) =>
  Boolean(hash && post.qa?.pass && post.qa.hash === hash && post.qa.model === model);

const MODEL = "claude-sonnet-5";
const H = (s) => createHash("sha256").update(s).digest("hex");
const memo = (over = {}) => ({ qa: { pass: true, hash: H("poster-bytes"), model: MODEL, ...over } });
const HASH = H("poster-bytes");

test("skips the paid call when the same file already passed under the same model", () => {
  assert.equal(shouldSkip(memo(), HASH, MODEL), true);
});

test("a REDRAWN poster is re-inspected — different bytes, different hash", () => {
  assert.equal(shouldSkip(memo(), H("redrawn-bytes"), MODEL), false);
});

test("a QA_MODEL upgrade re-inspects everything rather than trusting a weaker judge", () => {
  assert.equal(shouldSkip(memo(), HASH, "claude-opus-5"), false);
});

test("a poster that never passed is never skipped", () => {
  assert.equal(shouldSkip({}, HASH, MODEL), false);
  assert.equal(shouldSkip({ qa: { hash: HASH, model: MODEL } }, HASH, MODEL), false); // no pass flag
  assert.equal(shouldSkip({ qa: { pass: false, hash: HASH, model: MODEL } }, HASH, MODEL), false);
});

test("an unreadable poster (null hash) falls through to inspection, never inherits a pass", () => {
  assert.equal(shouldSkip(memo(), null, MODEL), false);
});

test("a memo missing its hash or model cannot match", () => {
  assert.equal(shouldSkip({ qa: { pass: true, model: MODEL } }, HASH, MODEL), false);
  assert.equal(shouldSkip({ qa: { pass: true, hash: HASH } }, HASH, MODEL), false);
});

// Guard: the predicate above is a copy, and a copy rots. Assert the real sweep still reads the
// same four fields, so an edit there that drifts from this test fails here instead of silently
// leaving the memo untested — or worse, skipping inspections this file never sanctioned.
test("the sweep's real predicate still matches the one asserted here", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../poster-qa-sweep.mjs", import.meta.url), "utf8");
  for (const fragment of [
    "post.qa?.pass",
    "post.qa.hash === hashBefore",
    "post.qa.model === QA_MODEL",
    "pass: true, hash: hashAfter, model: QA_MODEL",
  ]) {
    assert.ok(src.includes(fragment), `poster-qa-sweep.mjs no longer contains: ${fragment}`);
  }
});
