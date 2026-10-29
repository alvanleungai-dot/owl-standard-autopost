import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  contiguousQueueDepth,
  weekManifestHasPosts,
  GENERATION_QUEUE_HORIZON_WEEKS,
  parseQueueFull,
  queueFullLine,
  selectGenerationWeek,
} from "./generation-queue.mjs";
import { ArtifactExistsError, assertArtifactsWritable } from "./artifacts.mjs";

const thursdayRun = new Date("2026-07-30T10:00:00Z");
const pathFor = ({ weekId }) => join("fake", `${weekId}.json`);
const artifactsFor = (week) => [pathFor(week)];

test("automatic generation skips occupied future weeks without producing an alarm outcome", () => {
  const occupied = new Set([
    pathFor({ weekId: "2026-08-03" }),
    pathFor({ weekId: "2026-08-10" }),
    pathFor({ weekId: "2026-08-17" }),
  ]);
  const result = selectGenerationWeek({
    style: "date",
    artifactsFor,
    env: {},
    now: thursdayRun,
    exists: (path) => occupied.has(path),
    read: () => JSON.stringify({ posts: [{ slug: "existing" }] }),
  });

  assert.deepEqual(
    { status: result.status, explicit: result.explicit, weekId: result.weekId, offsetWeeks: result.offsetWeeks },
    { status: "target", explicit: false, weekId: "2026-08-24", offsetWeeks: 3 },
  );
  assert.equal("alarm" in result, false);
});

test("a full bounded queue is a successful no-op with a clear through-date line", () => {
  let probes = 0;
  const result = selectGenerationWeek({
    style: "date",
    artifactsFor,
    env: {},
    now: thursdayRun,
    exists: () => { probes += 1; return true; },
    read: () => JSON.stringify({ posts: [{ slug: "existing" }] }),
  });

  assert.equal(result.status, "full");
  assert.equal(result.through, "2026-10-19");
  assert.equal(probes, GENERATION_QUEUE_HORIZON_WEEKS);
  assert.equal(parseQueueFull(queueFullLine(result.through)), result.through);
});

test("an explicit colliding --week target still reaches the overwrite guard and refuses", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-generation-queue-"));
  const existing = join(root, "2026-08-03.json");
  try {
    writeFileSync(existing, "approved");
    const explicitArtifactsFor = ({ weekId }) => [join(root, `${weekId}.json`)];
    const result = selectGenerationWeek({
      style: "date",
      artifactsFor: explicitArtifactsFor,
      explicitWeek: "2026-08-03",
      env: {},
      now: thursdayRun,
      exists: () => true,
    });

    assert.equal(result.explicit, true);
    assert.equal(result.weekId, "2026-08-03");
    assert.throws(
      () => assertArtifactsWritable(explicitArtifactsFor(result)),
      (error) => error instanceof ArtifactExistsError && error.paths.includes(resolve(existing)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicitly set WEEK_OFFSET wins over automatic gap selection", () => {
  const result = selectGenerationWeek({
    style: "iso",
    artifactsFor,
    env: { WEEK_OFFSET: "2" },
    now: thursdayRun,
    exists: () => false,
  });

  assert.equal(result.explicit, true);
  assert.equal(result.weekId, "2026-W34");
  assert.equal(result.offsetWeeks, 2);
});

// ── contiguousQueueDepth ──────────────────────────────────────────────────────
// Added 2026-07-31. Catchup used to fill only the single upcoming week, so the content queue never
// grew and content stopped dead a few weeks out. This is the measurement that lets it top up.

const MONDAY = new Date(2026, 7, 3); // 2026-08-03, a Monday
const mondayOffset = (offsetWeeks) => {
  const d = new Date(MONDAY);
  d.setDate(d.getDate() + offsetWeeks * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const depthWith = (present, horizonWeeks = 8) => contiguousQueueDepth({
  firstMonday: MONDAY,
  horizonWeeks,
  artifactsFor: ({ monday }) => [
    `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`,
  ],
  exists: (id) => present.includes(id),
});

test("contiguousQueueDepth counts weeks forward from the upcoming Monday", () => {
  assert.equal(depthWith([mondayOffset(0), mondayOffset(1), mondayOffset(2)]), 3);
});

test("contiguousQueueDepth returns 0 when the very next week is missing", () => {
  assert.equal(depthWith([]), 0);
});

test("a HOLE stops the count — a gap must not read as a healthy queue", () => {
  // 08-03 exists, 08-10 missing, 08-17 exists. Depth is 1, not 2: the queue is one week deep,
  // and the week after it has nothing to publish. This is the exact shape three brands were in.
  assert.equal(depthWith([mondayOffset(0), mondayOffset(2)]), 1);
});

test("contiguousQueueDepth never counts past its horizon", () => {
  const all = Array.from({ length: 12 }, (_, i) => mondayOffset(i));
  assert.equal(depthWith(all, 8), 8);
});

test("contiguousQueueDepth rejects a nonsense horizon", () => {
  assert.throws(() => depthWith([], 0), /horizonWeeks must be a positive integer/);
});

// ── incomplete weeks (2026-07-31 Sun Mood stall) ──────────────────────────────
// A failed generation writes a caption, then dies before the poster and the manifest. Selection used
// to treat ANY surviving artifact as "week done" and skip it forever, generating later weeks while
// the hole stayed open — and catchup, which counts manifests, saw no progress and gave up. The two
// measures disagreed permanently, so the brand could never be filled and never reported an error.

const CAPTION = "captions/2026-08-24-01.txt";
const artifactsForWeek = ({ weekId }) => [`weeks/${weekId}.json`, `captions/${weekId}-01.txt`];
const selectWith = (present) => selectGenerationWeek({
  style: "date",
  artifactsFor: artifactsForWeek,
  now: new Date(2026, 6, 31),          // Fri 2026-07-31 → first Monday is 2026-08-03
  exists: (p) => present.includes(p),
  read: () => JSON.stringify({ posts: [{ slug: "existing" }] }),
});

test("a week whose manifest exists is finished and is skipped", () => {
  const result = selectWith(["weeks/2026-08-03.json"]);
  assert.equal(result.weekId, "2026-08-10", "the finished week must not be regenerated");
});

test("REGRESSION: debris without a manifest is INCOMPLETE and gets targeted, not skipped", () => {
  const result = selectWith(["weeks/2026-08-03.json", "weeks/2026-08-10.json", "weeks/2026-08-17.json", CAPTION]);
  assert.equal(result.weekId, "2026-08-24", "the half-written week must be retried, not stepped over");
  assert.equal(result.incomplete, true, "caller must be told to overwrite the debris");
});

test("an untouched week is targeted and is NOT flagged incomplete", () => {
  const result = selectWith(["weeks/2026-08-03.json"]);
  assert.equal(result.weekId, "2026-08-10");
  assert.notEqual(result.incomplete, true, "a clean week must not force-overwrite anything");
});

test("a later week is never reached while an earlier week is only half-written", () => {
  // The exact Sun Mood shape: 08-24 half-written, 08-31 complete. Selection must go BACK to 08-24.
  const result = selectWith([
    "weeks/2026-08-03.json", "weeks/2026-08-10.json", "weeks/2026-08-17.json",
    CAPTION, "weeks/2026-08-31.json",
  ]);
  assert.equal(result.weekId, "2026-08-24");
  assert.equal(result.incomplete, true);
  assert.notEqual(result.weekId, "2026-09-07", "generating past the hole is what kept the hole open");
});

// ── empty manifests (2026-07-31, second Sun Mood stall) ───────────────────────
// A failed run left week files with an EMPTY posts array. catchup counted those files and reported
// the brand 7/8 weeks deep while three of those weeks held nothing — so it stopped topping the brand
// up and the gaps could never close. Both callers now share weekManifestHasPosts.

const fakeFs = (files) => ({
  exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
  read: (p) => files[p],
});

test("a manifest with posts is done", () => {
  const fs = fakeFs({ "w.json": JSON.stringify({ posts: [{ slug: "a" }] }) });
  assert.equal(weekManifestHasPosts("w.json", fs), true);
});

test("REGRESSION: an EMPTY manifest is not a finished week", () => {
  const fs = fakeFs({ "w.json": JSON.stringify({ posts: [] }) });
  assert.equal(weekManifestHasPosts("w.json", fs), false, "an empty week file must not count as content");
});

test("a missing or unreadable manifest is not a finished week", () => {
  assert.equal(weekManifestHasPosts("nope.json", fakeFs({})), false);
  assert.equal(weekManifestHasPosts("bad.json", fakeFs({ "bad.json": "{ not json" })), false);
});

test("selection retargets a week whose manifest exists but is empty", () => {
  const files = {
    "weeks/2026-08-03.json": JSON.stringify({ posts: [{ slug: "a" }] }),
    "weeks/2026-08-10.json": JSON.stringify({ posts: [] }),          // failed run left this behind
  };
  const result = selectGenerationWeek({
    style: "date",
    artifactsFor: ({ weekId }) => [`weeks/${weekId}.json`],
    now: new Date(2026, 6, 31),
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    manifestComplete: (p) => weekManifestHasPosts(p, fakeFs(files)),
  });
  assert.equal(result.weekId, "2026-08-10", "the empty week must be regenerated, not counted as done");
});
