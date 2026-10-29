// Tests for poster-qa.mjs — the check that LOOKS at a poster before it publishes.
// All decision logic is pure, so none of this touches the network or a real image.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFECT_CHECKS,
  MAX_POSTER_ATTEMPTS,
  buildPrompt,
  inspectPoster,
  shouldRetry,
  toVerdict,
  verdictSummary,
} from "./poster-qa.mjs";

const answer = (id, present, evidence = "") => ({ id, present, evidence });

test("a clean poster passes", () => {
  const v = toVerdict({ defects: DEFECT_CHECKS.map((c) => answer(c.id, false, "not present")) });
  assert.equal(v.pass, true);
  assert.equal(v.inspected, true);
  assert.deepEqual(v.defects, []);
});

test("the owner's three-handed bear fails, and says where", () => {
  const v = toVerdict({
    defects: [answer("anatomy", true, "the bear has a third paw near its chest")],
  });
  assert.equal(v.pass, false);
  assert.equal(v.defects[0].id, "anatomy");
  assert.match(verdictSummary(v), /third paw/);
});

test("garbled button text fails — the defect seen on every TML mascot poster", () => {
  const v = toVerdict({ defects: [answer("garbled_text", true, "nonsense glyphs inside the WhatsApp button")] });
  assert.equal(v.pass, false);
  assert.equal(v.defects[0].id, "garbled_text");
});

test("every observed 2026-07-31 defect class has a check", () => {
  const ids = DEFECT_CHECKS.map((c) => c.id);
  for (const id of ["anatomy", "garbled_text", "clipped_text", "placeholder"]) {
    assert.ok(ids.includes(id), `missing check for ${id}`);
  }
});

test("an unanswered check is NOT counted as a defect", () => {
  // Missing coverage is a checker problem, not a poster problem. Inventing a failure here would
  // burn a paid regeneration on a poster that may be perfectly good.
  const v = toVerdict({ defects: [answer("anatomy", false)] });
  assert.equal(v.pass, true);
});

test("a malformed or empty answer does not crash and does not invent defects", () => {
  assert.equal(toVerdict(null).pass, true);
  assert.equal(toVerdict({}).pass, true);
  assert.equal(toVerdict({ defects: "nonsense" }).pass, true);
});

test("the prompt names every check and tells the model not to guess", () => {
  const p = buildPrompt();
  for (const c of DEFECT_CHECKS) assert.ok(p.includes(`[${c.id}]`), `prompt missing ${c.id}`);
  assert.match(p, /when in doubt/i);
  assert.match(p, /two limbs/i, "must not flag a normal two-paw pose");
});

// ── retry policy ──────────────────────────────────────────────────────────────

test("a real defect retries while attempts remain, then stops", () => {
  const bad = { pass: false, inspected: true, defects: [{ id: "anatomy", evidence: "x" }] };
  assert.equal(shouldRetry(bad, 1), true);
  assert.equal(shouldRetry(bad, MAX_POSTER_ATTEMPTS - 1), true);
  assert.equal(shouldRetry(bad, MAX_POSTER_ATTEMPTS), false, "must be bounded — regeneration costs money");
});

test("a clean poster is never regenerated", () => {
  assert.equal(shouldRetry({ pass: true, inspected: true, defects: [] }, 1), false);
});

test("an UNINSPECTED poster is never retried — a checker outage must not cause a regeneration storm", () => {
  assert.equal(shouldRetry({ pass: true, inspected: false, defects: [] }, 1), false);
});

// ── I/O boundary ──────────────────────────────────────────────────────────────

test("a missing poster file is a REAL defect, not an inspection outage", async () => {
  const v = await inspectPoster("/nope.png", {
    ask: async () => { throw new Error("should not be called"); },
    read: () => { throw new Error("ENOENT"); },
  });
  assert.equal(v.pass, false);
  assert.equal(v.inspected, true);
  assert.equal(v.defects[0].id, "missing_file");
});

test("a vision API failure fails OPEN — four brands must not stop publishing because the checker is down", async () => {
  const v = await inspectPoster("poster.png", {
    ask: async () => { throw new Error("503 upstream"); },
    read: () => Buffer.from("fake"),
  });
  assert.equal(v.pass, true);
  assert.equal(v.inspected, false, "must be recorded as uninspected, never as clean");
  assert.match(v.error, /503/);
});

test("the image actually reaches the model as base64", async () => {
  let sent = null;
  await inspectPoster("poster.png", {
    ask: async (req) => { sent = req; return { defects: [] }; },
    read: () => Buffer.from("hello"),
  });
  assert.equal(sent.image.base64, Buffer.from("hello").toString("base64"));
  assert.equal(sent.image.mediaType, "image/png");
  assert.ok(sent.schema, "must request structured output, not free text");
});
