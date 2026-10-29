// scripts/poster-qa-sweep.mjs — inspect every UPCOMING poster and stop the broken ones publishing.
//
// Wired as ONE job rather than inside all four generators on purpose: a single integration point is
// far less risky than four edits to live generation paths, and it also covers posters that already
// exist — including everything generated before this check was written.
//
// What it does per post whose date is still ahead:
//   pass            → clear any previous qa error, RECORD the pass, and leave the post alone
//   defect found    → write post.error, so publishable.mjs REFUSES to publish it, and count it
//   not inspected   → leave the post exactly as it was (vision outage must not block four brands)
//
// THE PASS MEMO (added 2026-08-02, after the owner's Anthropic credit hit zero).
//   Until now a pass wrote NOTHING. This job runs daily at 06:00 and skips only booked, owner-
//   skipped, or foreign-errored posts — so every clean upcoming poster was re-inspected from
//   scratch every single morning, paying Sonnet vision prices to re-derive a verdict already
//   reached. Catchup deliberately grows the queue toward 8 weeks, so the waste grew with it.
//   That is a paid call whose result is discarded on a hot schedule.
//
//   Fix: on a pass, store `post.qa = { hash, model, at }` where hash is the SHA-256 of the poster
//   FILE. A later run skips inspection only when the stored hash AND model both still match. Keying
//   on content (not path or mtime) means a regenerated poster re-inspects automatically — the file
//   changes, the hash changes. Keying on the model too means a QA_MODEL upgrade re-inspects
//   everything rather than inheriting verdicts from a weaker judge.
//
//   Only PASSES are memoised. A failure keeps post.error and is deliberately re-inspected every
//   run, because a redraw may have fixed it.
//
// It never deletes, never regenerates and never publishes. Marking `error` is enough to stop a bad
// poster going out, and the review sweep already treats an errored post as broken: it is never
// auto-approved and it raises a broken-content alert to the brand's Telegram.
//
//   node scripts/poster-qa-sweep.mjs            # all brands
//   node scripts/poster-qa-sweep.mjs --dry      # report only, change nothing
//   node scripts/poster-qa-sweep.mjs --brand=tml
//
// TIME-BOXED AND ROTATED (2026-08-04). This job was SIGTERMed at its 20-minute ceiling on 07-31 and
// again on 08-03 — `JOB_MAX_RUNTIME_EXCEEDED job=SCE-PosterQA`. A timeout reads as "the job is slow",
// but with a FIXED brand order it means something much worse and entirely silent: the brands at the
// END of the list were never inspected AT ALL, on any run, while the summary line and the alerts
// spoke only about the brands it did reach. An image check that never looks at bright-day is not a
// slow check, it is an ABSENT one — and it fails open, so nothing downstream notices.
//
// Two changes, both small: start from a rotating cursor so every brand gets to be first, and stop
// VOLUNTARILY before the ceiling so the run ends by saving its work and SAYING what it did not get
// to, instead of being killed mid-week with the tail unexplained.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { companyArtifactPath, companyStatePath, runtimePath, ensureStateParent } from "./lib/paths.mjs";
import { rotateForFairness, advanceCursor } from "./lib/publish-repair-core.mjs";
import { ensureCjkFont } from "./lib/fonts.mjs";
import { askImageJSON } from "./lib/anthropic.mjs";
import { inspectPoster, verdictSummary, QA_MODEL } from "./lib/poster-qa.mjs";
import { hkTodayStr, postDate } from "./lib/watchdog-core.mjs";
import { escalate, resolve as resolveAlert } from "./lib/alert.mjs";
import { regeneratePoster } from "./lib/poster-regen.mjs";
import { MAX_POSTER_ATTEMPTS, shouldRetry } from "./lib/poster-qa.mjs";

if (process.env.SCE_IMPORT_ONLY === "1") process.exit(0);

// Do not rely on the parent having set this. The redraw below spawns a poster generator with THIS
// process's env, so if the font is not configured here every redraw reproduces the garbling it is
// trying to repair — which is exactly what happened on the 2026-08-04 verification run.
{
  const font = ensureCjkFont({ log: console.log });
  if (!font.ok) console.log(`FONTS_UNAVAILABLE: ${font.reason} — redraws cannot fix garbled Chinese text`);
}

const DRY = process.argv.includes("--dry");
const BRANDS = ["owl-standard"];
const only = process.argv.find((a) => a.startsWith("--brand="))?.slice("--brand=".length);

// Stop with 5 minutes to spare against the 20-minute maxRuntimeMs in worker-jobs.mjs, so the run
// ends on its own terms — work saved, tail reported — rather than being SIGTERMed mid-week.
const TIME_BUDGET_MS = Number(process.env.POSTER_QA_BUDGET_MS) || 15 * 60_000;
const startedAt = Date.now();
const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;

const CURSOR_FILE = runtimePath("secrets", "poster-qa-cursor.json");
const readCursor = () => {
  try { return Number(JSON.parse(readFileSync(CURSOR_FILE, "utf8")).cursor) || 0; } catch { return 0; }
};
const writeCursor = (value) => {
  try { writeFileSync(ensureStateParent(CURSOR_FILE), JSON.stringify({ cursor: value }), "utf8"); } catch {}
};

const cursor = only ? 0 : readCursor();
const brands = only ? BRANDS.filter((b) => b === only) : rotateForFairness(BRANDS, cursor);
const unreached = [];
let brandsCompleted = 0;

const QA_ERROR_PREFIX = "poster-qa:";
const ask = (req) => askImageJSON({ ...req, model: QA_MODEL, maxTokens: 1500 });
const now = Date.now();
const today = hkTodayStr(now);

let checked = 0, failed = 0, cleared = 0, skipped = 0, regenerated = 0, memoed = 0, uninspected = 0;
const broken = [];
const notInspected = [];

// SHA-256 of the poster file, or null when it cannot be read. null NEVER matches a stored hash,
// so an unreadable poster falls through to inspection rather than inheriting a stale pass.
const posterHash = (path) => {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
};

for (const brand of brands) {
  if (outOfTime()) { unreached.push(brand); continue; }
  const weeksDir = companyStatePath(brand, "weeks");
  if (!existsSync(weeksDir)) { brandsCompleted += 1; continue; }

  let brandFinished = true;
  for (const file of readdirSync(weeksDir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()) {
    // Checked between WEEKS, not between posts: a week is written as a unit, so stopping here never
    // loses a partially-judged week's work.
    if (outOfTime()) { brandFinished = false; break; }
    const weekPath = `${weeksDir}/${file}`;
    let week;
    try { week = JSON.parse(readFileSync(weekPath, "utf8")); } catch { continue; }
    let changed = false;

    for (const post of week.posts || []) {
      const date = postDate(post, now);
      if (!date || date < today) continue;                       // upcoming work only
      // Never re-judge a post the owner already decided against, and never touch one already booked:
      // rewriting a booked post's error would not unbook it and would only confuse the ledger.
      if (post.status === "skip" || post.fbPostId) { skipped += 1; continue; }
      // An error from somewhere ELSE (failed generation) is not ours to clear or re-litigate.
      if (post.error && !String(post.error).startsWith(QA_ERROR_PREFIX)) { skipped += 1; continue; }

      const posterRef = post.poster || `companies/${brand}/posters/${post.slug}.png`;
      // Media type from the EXTENSION, never assumed. Two posters were skipped on the first live
      // sweep because inspectPoster's image/png default was sent for a .jpg file and the API
      // rejected the mismatch — an uninspected poster is a poster that could publish broken.
      const posterPath = companyArtifactPath(brand, posterRef);
      const ext = posterPath.toLowerCase().split(".").pop();
      const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      // ── the pass memo ────────────────────────────────────────────────────────────────────────
      // Skip the paid call when THIS EXACT FILE already passed under THIS EXACT MODEL. Both must
      // match: content, so a redraw re-inspects; model, so a judge upgrade re-inspects.
      const hashBefore = posterHash(posterPath);
      if (hashBefore && post.qa?.pass && post.qa.hash === hashBefore && post.qa.model === QA_MODEL) {
        memoed += 1;
        continue;
      }

      // JUDGE → REDRAW → JUDGE AGAIN, bounded. Telling the owner a poster is broken still leaves
      // him to fix it, which is the thing he asked not to be. Only a REAL inspected defect triggers
      // a redraw (shouldRetry refuses on an uninspected poster), so a vision outage can never cause
      // a regeneration storm on four brands.
      let verdict = await inspectPoster(posterPath, { ask, mediaType });
      checked += 1;

      for (let attempt = 1; shouldRetry(verdict, attempt, MAX_POSTER_ATTEMPTS) && !DRY; attempt += 1) {
        console.log(`  ↻  ${brand}/${post.slug} — ${verdictSummary(verdict).slice(0, 90)} → redraw ${attempt}/${MAX_POSTER_ATTEMPTS - 1}`);
        const regen = await regeneratePoster(brand, post);
        if (!regen.ok) { console.log(`  ↻  ${brand}/${post.slug} — redraw unavailable: ${regen.reason}`); break; }
        regenerated += 1;
        verdict = await inspectPoster(posterPath, { ask, mediaType });
      }

      if (!verdict.inspected) {
        // FAIL-OPEN, DELIBERATELY: an un-inspected poster stays publishable so a vision outage
        // cannot freeze four brands. But silence about it is the defect — during the 2026-08-02
        // credit outage this gate was off for days and said so only to a console nobody reads.
        // Counted here and alerted below.
        uninspected += 1;
        notInspected.push(`${brand}/${post.slug}: ${verdict.error ?? "unknown"}`);
        console.log(`  ?  ${brand}/${post.slug} — not inspected (${verdict.error ?? "unknown"}); left unchanged`);
        continue;
      }
      if (verdict.pass) {
        if (post.error?.startsWith(QA_ERROR_PREFIX)) {           // a redrawn poster now passes
          delete post.error;
          cleared += 1;
          console.log(`  ✅ ${brand}/${post.slug} — clean, qa error cleared`);
        }
        // Record the pass against the file AS IT NOW STANDS — re-hashed after any redraw above,
        // never reusing hashBefore, or a redrawn poster would memoise its pre-redraw bytes.
        const hashAfter = posterHash(posterPath);
        if (hashAfter && !DRY) {
          // `pass: true` is load-bearing, not decorative — the skip test above reads post.qa.pass.
          // Omitting it makes the memo never match and the whole fix silently a no-op.
          post.qa = { pass: true, hash: hashAfter, model: QA_MODEL, at: new Date(now).toISOString() };
          changed = true;
        }
        continue;
      }

      const summary = verdictSummary(verdict);
      failed += 1;
      broken.push(`${brand}/${post.slug} (${date}): ${summary}`);
      console.log(`  ❌ ${brand}/${post.slug} ${date} — still bad after redraws — ${summary}`);
      if (!DRY) {
        post.error = `${QA_ERROR_PREFIX} ${summary}`.slice(0, 300);
        changed = true;
      }
    }

    if (changed && !DRY) writeFileSync(weekPath, JSON.stringify(week, null, 2), "utf8");
  }
  if (brandFinished) brandsCompleted += 1; else unreached.push(brand);
}

// Hand the next run a different starting point, so the brand this run ran out of time on is the one
// the next run looks at FIRST. Without this the same tail is skipped every single day, silently.
//
// ALWAYS MOVE AT LEAST ONE (measured 2026-08-04): the first live run reported
// "completed 0/4 · OUT OF TIME before: better-life, tml, sunmood, bright-day" — it exhausted the
// whole budget inside the FIRST brand. Advancing by brandsCompleted alone would leave the cursor at
// 0 forever and reproduce the exact starvation this rotation exists to end, just more visibly.
// Forward motion is what guarantees every brand eventually gets to go first.
if (!only && !DRY) {
  const step = unreached.length ? Math.max(brandsCompleted, 1) : brandsCompleted;
  writeCursor(advanceCursor(cursor, step, BRANDS.length));
}

console.log(`poster-qa sweep: ${checked} inspected · ${memoed} already-passed (no API call) · ${regenerated} redrawn · ${cleared} recovered · ${failed} withheld · ${uninspected} NOT inspected · ${skipped} skipped${DRY ? " (dry)" : ""}`);
console.log(`poster-qa order: started at ${brands[0]} (cursor ${cursor}) · completed ${brandsCompleted}/${brands.length} brand(s)${unreached.length ? ` · OUT OF TIME before: ${unreached.join(", ")}` : ""}`);

// One deduped alert naming every withheld poster, so the owner learns from Telegram rather than
// from an empty page on a Monday morning.
if (!DRY) {
  if (broken.length) {
    await escalate({
      source: "poster-qa",
      kind: `poster-qa:${broken.length}`,
      severity: "crucial",
      text: `🔴 ${broken.length} poster(s) held back by the image check — they will NOT publish until regenerated:\n${broken.join("\n")}`,
    });
  } else {
    resolveAlert("poster-qa", "poster-qa:cleared");
  }

  // THE GATE ITSELF GOING QUIET IS THE THING WORTH TELLING HIM. A withheld poster is the check
  // working; posters the check could not look at are the check being ABSENT while publishing
  // continues — and it fails open by design, so nothing else downstream will notice.
  if (uninspected) {
    await escalate({
      source: "poster-qa",
      kind: `poster-qa:uninspected:${uninspected}`,
      severity: "crucial",
      text: `⚠️ The poster image check could NOT inspect ${uninspected} upcoming poster(s) — they are NOT blocked and may publish unchecked. Usually this means the AI provider is down or out of credit.\n${notInspected.slice(0, 10).join("\n")}`,
    });
  } else {
    resolveAlert("poster-qa", "poster-qa:uninspected:cleared");
  }

  // RUNNING OUT OF TIME IS ITSELF A FINDING. Before 2026-08-04 this condition was a SIGTERM, and a
  // SIGTERM says nothing about WHICH brands went unchecked — so "the job timed out" was read as
  // slowness for two weeks while a brand's posters were never looked at. The rotation above means a
  // single short run is self-correcting, so this only alarms when it keeps happening.
  if (unreached.length) {
    await escalate({
      source: "poster-qa",
      kind: `poster-qa:out-of-time:${unreached.join(",")}`,
      severity: "crucial",
      text:
        `⏱️ The poster image check ran out of time before reaching: ${unreached.join(", ")}. ` +
        "Those posters were NOT inspected this run. The next run starts with them, so one occurrence " +
        "is self-correcting — repeated ones mean the sweep no longer fits its 20-minute ceiling.",
    });
  } else {
    resolveAlert("poster-qa", "poster-qa:out-of-time:cleared");
  }
}
