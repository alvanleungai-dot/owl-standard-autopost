import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(`${repoRoot}${path}`, "utf8");

// Originally also covered the four divorce tenants' per-brand bridges/notifiers (tml/sunmood/bright-day).
// This checkout was pruned to Owl Standard only — those files no longer exist. The shared top-level
// scripts/tg-bridge.mjs + scripts/lib/notify.mjs remain and are what Owl Standard's own bridge will use.
const bridges = [
  "scripts/tg-bridge.mjs",
];
const notifiers = [
  "scripts/lib/notify.mjs",
];

test("the shared review bot uses the deadline, sweep, and watchdog runtime", () => {
  for (const path of bridges) {
    const source = read(path);
    assert.match(source, /import \{ runTelegramReviewBot \}/, path);
    assert.match(source, /await runTelegramReviewBot\(\{/, path);
    assert.match(source, /async function runSweep\(nowMs, signal, liveness\)/, path);
    // Every bot must sweep ALL reviewable weeks, not just the active one. Sweeping only the
    // active week stranded undecided posts each time weekly-run moved the pointer, so timed
    // auto-approval never fired in production (2026-07-31). See scripts/lib/review-weeks.mjs.
    assert.match(source, /import \{[^}]*\bsweepReviewWeeks\b[^}]*\} from "\.{1,2}\/lib\/review-weeks\.mjs"/, path);
    // `list` and `keep all` must span every reviewable week too. With catchup keeping ~8 weeks
    // ready, active-week.json points at the FURTHEST week — so a single-week `keep all` would
    // approve a far-future week while next Monday's post stayed undecided.
    assert.match(source, /import \{[^}]*\bloadReviewableWeeks\b[^}]*\} from "\.{1,2}\/lib\/review-weeks\.mjs"/, path);
    assert.match(source, /async function approveAll\(\) \{[\s\S]*?loadReviewableWeeks\(/, path);
    assert.match(source, /async function cmdList\(\) \{[\s\S]*?loadReviewableWeeks\(/, path);
    assert.doesNotMatch(source, /async function approveAll\(\) \{[\s\S]*?activeWeekId\(\)/, path);
    assert.match(source, /sweepReviewWeeks\(\{ brand: "[a-z-]+", nowMs, liveness, weeksDir, loadWeek, saveWeek \}\)/, path);
    assert.doesNotMatch(source, /planSweep\(/, path);
    assert.doesNotMatch(source, /const week = loadWeek\(activeWeekId\(\)\)/, path);
    assert.match(source, /review-liveness-gap:/, path);
    // The redo button must overwrite the old poster: without --force gen-poster refuses (exit 75),
    // which is how the 🔁 button silently never worked before 2026-09-18.
    assert.match(source, /\[genPoster,[^\]]*"--force"\]/, path);
    // Buttons are honoured only in the configured review chat (a forwarded poster keeps them).
    assert.match(source, /String\(cq\.message\?\.chat\?\.id\) !== String\(TG_CHAT\)/, path);
    assert.match(source, /livenessBlocked\.length/, path);
    assert.doesNotMatch(source, /while \(true\)/, path);
    assert.doesNotMatch(source, /tg\("getUpdates"/, path);
  }
});

test("the bot transport uses the bounded Telegram request helper", () => {
  for (const path of notifiers) {
    const source = read(path);
    assert.match(source, /import \{ telegramRequest \}/, path);
    assert.match(source, /return telegramRequest\(\{/, path);
    assert.doesNotMatch(source, /\bfetch\(/, path);
  }
});
