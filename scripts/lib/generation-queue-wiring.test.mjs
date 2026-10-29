import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCHEDULED_JOBS } from "./worker-jobs.mjs";

// Was four (brand, generator, runner) triples — one per divorce tenant. Pruned to Owl Standard on
// 2026-08-25. The anti-vacuity test below keeps this list honest against the scheduled-jobs table.
const pairs = [
  ["owl-standard", "scripts/owl-standard/gen-week.mjs", "scripts/owl-standard/weekly-run.mjs"],
];

test("every scheduled weekly-run has a generator pair listed here (no vacuous wiring checks)", () => {
  const scheduled = SCHEDULED_JOBS
    .filter((job) => job.entry.endsWith("/weekly-run.mjs"))
    .map((job) => job.entry)
    .sort();
  assert.deepEqual(
    pairs.map(([, , runner]) => runner).sort(),
    scheduled,
    "a weekly-run is scheduled but has no generator pair here — the queue-wiring checks below would skip it",
  );
});

test("every weekly generator pair shares queue selection, full-queue no-op, and failure escalation", () => {
  for (const [brand, generatorPath, runnerPath] of pairs) {
    const generator = readFileSync(resolve(generatorPath), "utf8");
    const runner = readFileSync(resolve(runnerPath), "utf8");
    assert.match(generator, /selectGenerationWeek/, `${brand} generator must auto-select a queue gap`);
    assert.match(generator, /queueFullLine/, `${brand} generator must log a bounded full-queue no-op`);
    assert.match(runner, /parseQueueFull/, `${brand} runner must accept a full queue without parseWrote failure`);
    assert.match(
      runner,
      /reportWeeklyError/,
      `${brand} runner must distinguish no-op completion from a failed error report`,
    );
  }
});
