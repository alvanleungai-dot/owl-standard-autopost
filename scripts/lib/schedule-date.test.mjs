import test from "node:test";
import assert from "node:assert/strict";
import { allDateInputsMatch, inputShowsScheduledDate } from "./schedule-date.mjs";

test("date guard recognizes the intended date in common input formats", () => {
  assert.equal(inputShowsScheduledDate("3 August 2026", "2026-08-03"), true);
  assert.equal(inputShowsScheduledDate("Aug 03, 2026", "2026-08-03"), true);
  assert.equal(inputShowsScheduledDate("Aug 04, 2026", "2026-08-03"), false);
});

test("cross-post date guard fails when either channel kept the wrong date", () => {
  assert.equal(allDateInputsMatch(["Aug 03, 2026", "Aug 03, 2026"], "2026-08-03"), true);
  assert.equal(allDateInputsMatch(["Aug 03, 2026", "Aug 04, 2026"], "2026-08-03"), false);
  assert.equal(allDateInputsMatch([], "2026-08-03"), false);
});
