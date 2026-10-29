// scripts/catchup.mjs — autonomous recovery. If an autopilot brand's UPCOMING week wasn't generated
// (e.g. the Thursday run failed on billing), regenerate it AS SOON AS the providers are healthy —
// without the owner re-triggering. Only acts Fri–Sun (after Thu generation, before Mon posting),
// only when the week file is missing AND Anthropic + OpenAI are alive. Otherwise a no-op.
// Scheduled every ~2h (SCE-Catchup). Once the week exists, it skips.
//   node scripts/catchup.mjs
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { askText } from "./lib/anthropic.mjs";
import { companyStatePath } from "./lib/paths.mjs";
import { contiguousQueueDepth, GENERATION_QUEUE_HORIZON_WEEKS, weekManifestHasPosts } from "./lib/generation-queue.mjs";
import { getEnv } from "./lib/env.mjs";
import { AI_TEXT_HTTP_TIMEOUT_MS, fetchWithDeadline } from "./lib/http-deadline.mjs";
import { backendName } from "./lib/image-backend.mjs";

const exec = promisify(execFile);
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const node = process.execPath;
const OPENAI = getEnv("OPENAI_API_KEY");
if (process.env.SCE_IMPORT_ONLY === "1") process.exit(0);

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hkNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
function upcomingMonday() { const d = hkNow(); const add = ((8 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + add); d.setHours(0, 0, 0, 0); return d; }
function isoWeekId(hk) {
  const t = new Date(Date.UTC(hk.getFullYear(), hk.getMonth(), hk.getDate()));
  const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const dow = hkNow().getDay(); // 0=Sun … 6=Sat
if (![5, 6, 0].includes(dow)) { console.log(`catchup: outside the Fri–Sun catch-up window (dow=${dow}); no-op.`); process.exit(0); }

const mon = upcomingMonday();
// 2026-07-25: sunmood + bright-day added (owner decision — both now automated WITH the Telegram approval
// gate). weekly-run only GENERATES + sends for review; nothing publishes here, and each brand's
// api-schedule refuses any post that is not status=approved (scripts/lib/publishable.mjs).
// Pruned to Owl Standard only. `run` points at scripts/owl-standard/weekly-run.mjs, which DOES NOT
// EXIST YET — catchup will fail for this brand until it is built. That is deliberate and visible rather
// than silently skipping the brand.
const BRANDS = [
  { id: "owl-standard", iso: true, run: p("./owl-standard/weekly-run.mjs") },
];

// HOW MANY WEEKS OF CONTENT TO KEEP READY. Before 2026-07-31 catchup only ever filled the SINGLE
// upcoming Monday, so the content queue never grew past whatever the Thursday autopilot had built —
// content simply stopped a few weeks out and nothing was pulling it forward. gen-week has always been
// able to target any of the next GENERATION_QUEUE_HORIZON_WEEKS (12) weeks; nothing ever asked it to.
// Now catchup tops the queue up to TARGET_WEEKS, one week per brand per run, so the pipeline stays
// weeks ahead on its own and never has to be refilled by hand.
// Owl Standard default: 5 weeks. Review is a MONTHLY batch (lib/monthly-review.mjs), so the next
// month must already exist on the 1st — fewer weeks and most posters would trickle in one by one via
// the 7-day safety net instead. More weeks only means older, staler content (dates and fees change).
const TARGET_WEEKS = Math.min(
  Number(process.env.CATCHUP_QUEUE_WEEKS || 5) || 5,
  GENERATION_QUEUE_HORIZON_WEEKS,
);

const weekFileFor = (brand, monday) =>
  companyStatePath(brand.id, "weeks", `${brand.iso ? isoWeekId(monday) : fmt(monday)}.json`);

// Depth uses the SAME "is this week done" predicate the generator uses (weekManifestHasPosts).
// When these two disagreed, the disagreement was invisible and permanent: on 2026-07-31 catchup
// counted Sun Mood's empty week files and reported 7/8 weeks deep while three of them held no posts
// at all, so it stopped topping the brand up and the gaps could never close.
const depthOf = (brand) => contiguousQueueDepth({
  firstMonday: mon,
  horizonWeeks: TARGET_WEEKS,
  artifactsFor: ({ monday }) => [weekFileFor(brand, monday)],
  exists: (path) => weekManifestHasPosts(path),
});

// ONE week per brand per run, deliberately. Each weekly-run is allowed 25 minutes and this job's
// supervisor kills it at 55; four brands x one week already fits that budget with room to spare,
// while four brands x several weeks would not. Catchup runs every 2 hours, so a queue that is
// several weeks short still refills within a day without ever risking a mid-generation kill.
const behind = BRANDS.map((b) => ({ ...b, depth: depthOf(b) })).filter((b) => b.depth < TARGET_WEEKS);
console.log(`catchup: queue target ${TARGET_WEEKS} week(s) — ` +
  BRANDS.map((b) => `${b.id}=${depthOf(b)}`).join(" "));
if (!behind.length) { console.log(`catchup: every brand is ${TARGET_WEEKS} weeks deep; no-op.`); process.exit(0); }
console.log(`catchup: topping up → ${behind.map((b) => `${b.id}(${b.depth})`).join(", ")}`);
const missing = behind;

// PROVIDER READINESS. Anthropic is always required (captions). The IMAGE provider depends on
// IMAGE_BACKEND — probing OpenAI unconditionally would block generation on a provider this pipeline
// may not use at all. Higgsfield has no cheap health endpoint, so for that backend we check only that
// its credentials are present; a real failure then surfaces per-poster with a named cause.
let anthropicOk = false, imagesOk = false;
try { await askText("hi", { maxTokens: 1 }); anthropicOk = true; } catch { anthropicOk = false; }
const imageBackend = backendName();
if (imageBackend === "openai") {
  try {
    const r = await fetchWithDeadline("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${OPENAI}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    }, { timeoutMs: AI_TEXT_HTTP_TIMEOUT_MS, label: "OpenAI catchup health probe" });
    imagesOk = r.status === 200;
  } catch { imagesOk = false; }
} else {
  imagesOk = !!(getEnv("HIGGSFIELD_API_KEY_ID") && getEnv("HIGGSFIELD_API_KEY_SECRET"));
}

if (!(anthropicOk && imagesOk)) { console.log(`catchup: providers not ready (anthropic=${anthropicOk} images[${imageBackend}]=${imagesOk}); will retry next run.`); process.exit(0); }

// KEEP GENERATING UNTIL THE QUEUE IS FULL OR THE CLOCK RUNS OUT.
//
// This used to do exactly one week per brand per run. That was sized against weekly-run's 12-minute
// per-brand timeout, which turned out to be wildly pessimistic: measured on the Render worker
// 2026-07-31, a full brand-week (topic, caption, gpt-image-2 poster) completed in 98 SECONDS. At one
// week per run every 2 hours, filling a queue five weeks short took ten hours; time-boxed instead, it
// finishes in a single run.
//
// The budget — not a week count — is the safety property. SCE-Catchup's supervisor kills the job at
// 55 minutes (scripts/lib/worker-jobs.mjs), and a kill mid-generation leaves a half-written week, so
// we stop well before that and let the next scheduled run continue.
// 25 minutes, so the LAST week started still ends inside the 55-minute ceiling even at weekly-run's
// worst case (its generator may take up to 20 minutes, see the 25-minute exec timeout below).
const BUDGET_MS = Number(process.env.CATCHUP_RUN_BUDGET_MS || 25 * 60 * 1000) || 25 * 60 * 1000;
const startedAt = Date.now();
const msLeft = () => BUDGET_MS - (Date.now() - startedAt);

const dropped = new Set(); // brands that failed or made no progress — never retried within this run
let generated = 0;

while (true) {
  const behindNow = BRANDS
    .map((b) => ({ ...b, depth: depthOf(b) }))
    .filter((b) => b.depth < TARGET_WEEKS && !dropped.has(b.id));
  if (!behindNow.length) break;
  if (msLeft() <= 0) { console.log(`catchup: run budget spent after ${generated} week(s); next run continues.`); break; }

  for (const b of behindNow) {
    if (msLeft() <= 0) break;
    console.log(`catchup: ${b.id} at ${b.depth}/${TARGET_WEEKS} weeks — generating…`);
    try {
      await exec(node, [b.run], { cwd: p(".."), timeout: 25 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      // PRINT THE CHILD'S OWN OUTPUT, not just "Command failed".
      // 2026-07-31: sunmood failed here and the log said only
      //   catchup: sunmood FAILED: Command failed: /usr/bin/node .../sunmood/weekly-run.mjs
      // because this used e.message sliced to 200 chars. exec() CAPTURES the child's streams rather
      // than inheriting them, so the generator's own diagnosis ("!! <slug> failed: …", the API error,
      // the missing asset) existed on e.stdout/e.stderr and was thrown away — leaving a failing brand
      // undiagnosable from the only place anyone can look, the worker log. Tails, because the head of
      // a generator run is boilerplate and the cause is always at the end.
      const tail = (text, n) => {
        const lines = String(text ?? "").trimEnd().split("\n").filter((l) => l.trim());
        return lines.slice(-n).join(" | ").slice(0, 1200);
      };
      console.log(`catchup: ${b.id} FAILED: ${String(e?.message || e).split("\n")[0].slice(0, 200)}`);
      if (e?.stdout) console.log(`catchup: ${b.id} stdout tail: ${tail(e.stdout, 12)}`);
      if (e?.stderr) console.log(`catchup: ${b.id} stderr tail: ${tail(e.stderr, 12)}`);
      dropped.add(b.id); // a failing brand must not spin the loop for the whole budget
      continue;
    }
    // Progress is measured by the QUEUE, not by a zero exit code. A run that exits clean without
    // deepening the queue (gen-week reporting "queue already full", a duplicate-guard no-op) would
    // otherwise loop until the budget was gone, generating nothing.
    const after = depthOf(b);
    if (after <= b.depth) {
      console.log(`catchup: ${b.id} produced no new week (still ${after}); leaving it for the next run.`);
      dropped.add(b.id);
      continue;
    }
    generated += 1;
    console.log(`catchup: ${b.id} done — now ${after}/${TARGET_WEEKS} weeks (${generated} generated this run).`);
  }
}

console.log(`catchup done: ${generated} week(s) generated — ` +
  BRANDS.map((b) => `${b.id}=${depthOf(b)}`).join(" "));
