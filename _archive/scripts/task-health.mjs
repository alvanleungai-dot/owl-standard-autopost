// scripts/task-health.mjs — "watch the watchers" + INFRASTRUCTURE SELF-REPAIR. Reads the Windows Task
// Scheduler result of every SCE automation task. For a FAILED task it now does more than alert: if the
// task is in the infra-repair registry (a monitor/infra task with a committed register-*.ps1), it
// RE-REGISTERS it from that script and verifies — deterministic, idempotent, touches NO posts/accounts/
// money — and only escalates what it cannot auto-heal. This closes the 2026-06-28 gap where SCE-Gatekeeper
// was mis-registered (exit 0x1, empty log), task-health CAUGHT it but could only alert, and the OWNER had
// to fix it by hand. task-health stays up when the Gatekeeper is down, so it heals the Gatekeeper.
// task-health is the SINGLE elevated infra-repairer (S4U + RunLevel Highest); the Gatekeeper stays advisory
// (Limited) and just ESCALATES if task-health itself breaks — one narrow elevated surface, not two.
// (To repair, this task must run elevated — see windows/register-task-health.ps1.)
//   node scripts/task-health.mjs            # auto-heal infra failures; escalate (deduped) what's left
//   node scripts/task-health.mjs --report   # also confirm via Telegram when all green
//   node scripts/task-health.mjs --dry      # print only; never repair, never send Telegram
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unhealthyTasks } from "./lib/task-health-core.mjs";
import { planInfraRepair, shouldAttemptRepair, recordRepairAttempt, verifyReregister } from "./lib/infra-repair-core.mjs";
import { escalate, resolve, inform } from "./lib/alert.mjs";
import { runtimePath } from "./lib/paths.mjs";
import { getEnv } from "./lib/env.mjs";

const execFileP = promisify(execFile);
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const REPORT = process.argv.includes("--report");
const DRY = process.argv.includes("--dry");
// ONE brand list → both the Task Scheduler QUERY and the WATCH filter derive from it, so they can never
// diverge (a 2026-06-29 near-miss: BrightDay was added to WATCH but not the query, so it stayed skipped).
const BRANDS = ["BetterLife", "TML", "Sunmood", "SCE", "BrightDay"];
const WATCH = BRANDS;
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }); // HK calendar day (DST-free) — the daily repair cap resets on the HK date, not UTC.

// INFRA_AUTOFIX gates the auto re-register (default ON). Set INFRA_AUTOFIX=off in .env to make task-health
// purely advisory again (it will still detect + escalate, just never re-register).
const readEnvFlag = (k, dflt) => {
  const s = getEnv(k).trim().toLowerCase();
  return s === "" ? dflt : !["0", "false", "off", "no"].includes(s);
};
const INFRA_AUTOFIX = readEnvFlag("INFRA_AUTOFIX", true);

// Per-day repair-attempt cap state (idempotent re-register: try once/day/task, then escalate).
const STATE_PATH = runtimePath("secrets", "infra-repair-state.json");
const loadState = () => { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; } };
const saveState = (s) => { try { mkdirSync(runtimePath("secrets"), { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {} };

const safeName = (n) => /^[A-Za-z0-9_-]+$/.test(String(n || "")); // defend the PS single-quoted task name

// One PowerShell round-trip → JSON rows of {name, state, lastResult} for our tasks.
const PS = `Get-ScheduledTask | Where-Object { $_.TaskName -match '${BRANDS.join("|")}' } | ` +
  "ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ name = $_.TaskName; " +
  "state = $_.State.ToString(); lastResult = $i.LastTaskResult } } | ConvertTo-Json -Compress";

// ── REPAIR EXECUTOR ───────────────────────────────────────────────────────────────────────────────────
// (a) Re-register the task from its OWN committed register-*.ps1. Needs admin — succeeds when this monitor
// runs elevated (S4U + Highest); otherwise throws access-denied and the caller escalates (no worse than before).
async function reregister(scriptRel) {
  const abs = p("../" + scriptRel);
  const { stdout, stderr } = await execFileP(
    "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", abs],
    { timeout: 120000 },
  );
  return ((stdout || "") + (stderr || "")).trim();
}

// (b) Verify the re-register WORKED by re-querying the task — present? enabled? action correctly quoted? —
// NOT by running it and polling LastTaskResult. Run-and-poll was fragile: a slow-but-successful run timed
// out → false failure, and an empty/garbled read parsed to 0x0 → false "healed". Re-registering from the
// committed script IS the repair; success = it's now correctly registered. The next scheduled run + the
// monitor confirm runtime health. queryTask returns { present, state, actionArgs }; verifyReregister judges.
async function queryTask(taskName) {
  if (!safeName(taskName)) throw new Error(`unsafe task name: ${taskName}`);
  const ps = `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; ` +
    `if (-not $t) { '{"present":false}' } else { [pscustomobject]@{ present = $true; ` +
    `state = $t.State.ToString(); actionArgs = (($t.Actions | ForEach-Object { $_.Arguments }) -join ' ') } | ConvertTo-Json -Compress }`;
  const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000 });
  try { return JSON.parse((stdout || "").trim() || '{"present":false}'); } catch { return { present: false }; }
}

// ── MAIN ────────────────────────────────────────────────────────────────────────────────────────────
let rows = [];
let taskQueryError = null;
try {
  const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS], { timeout: 60000 });
  const parsed = JSON.parse((stdout || "").trim() || "[]");
  rows = Array.isArray(parsed) ? parsed : [parsed];
} catch (e) {
  console.error("task-health: could not query Task Scheduler:", e.message);
  taskQueryError = e;
}

const bad = unhealthyTasks(rows, WATCH);
console.log(`task-health: ${rows.length} watched task(s), ${bad.length} unhealthy` +
  (bad.length ? ": " + bad.map((b) => `${b.name} ${b.hex}`).join(", ") : "") +
  ` · infra-autofix=${INFRA_AUTOFIX ? "ON" : "OFF"}${DRY ? " · DRY" : ""}`);

if (DRY) {
  for (const t of bad) {
    const plan = planInfraRepair(t.name);
    console.log(`  ${t.name} ${t.hex} → ` + (plan ? `WOULD auto-repair (re-register ${plan.script})` : "escalate (not infra-repairable)"));
  }
} else {
  let state = loadState();
  const repaired = [], stillBad = []; // repaired = re-registered OK, but runtime health not yet confirmed

  for (const t of bad) {
    const plan = planInfraRepair(t.name);
    const eligible = INFRA_AUTOFIX && plan && shouldAttemptRepair(state, t.name, TODAY, 1);
    if (!eligible) {
      const why = !plan ? "not infra-repairable" : !INFRA_AUTOFIX ? "infra-autofix OFF" : "daily repair cap reached";
      stillBad.push({ ...t, repairTried: false, detail: why });
      continue;
    }
    state = recordRepairAttempt(state, t.name, TODAY);
    saveState(state); // persist BEFORE acting so a crash mid-repair still counts against the cap (no loop)
    try {
      console.log(`  ⚙️ auto-repairing ${t.name} (${t.hex}) — re-register ${plan.script} + verify…`);
      await reregister(plan.script);
      const v = verifyReregister(await queryTask(t.name));
      if (v.ok) { repaired.push({ ...t, plan, detail: v.reason }); continue; }
      stillBad.push({ ...t, repairTried: true, detail: v.reason });
    } catch (e) {
      stillBad.push({ ...t, repairTried: true, detail: `repair error: ${String(e.message).slice(0, 160)}` });
    }
  }

  // Re-registered, but runtime health is NOT yet proven (registration-verify only checks present/enabled/
  // correct quoting — not that the script actually RUNS). So DON'T resolve the alert and DON'T claim "fixed":
  // the task's NEXT scheduled run + this monitor confirm it. A still-broken task re-appears next cycle and,
  // with the daily cap reached, escalates — so a runtime failure can't be silently marked healed.
  for (const r of repaired) {
    await inform(`🔧 已自動重新註冊「${r.plan.label}」（之前失敗 ${r.hex}）。等下一次排程執行自動確認；若下次仍然失敗會升級畀你跟進。`);
  }
  // Escalate only what could NOT be auto-healed.
  for (const t of stillBad) {
    const tried = t.repairTried ? `，已嘗試自動重新註冊但仍未恢復（${t.detail}）→ 需要你跟進` : `（${t.detail}）→ 去 Task Scheduler 睇 History，或手動行一次對應 script`;
    await escalate({
      source: "task-health", kind: t.name, severity: "crucial",
      text: `🔴 排程任務「${t.name}」上次執行失敗（result ${t.hex}）${tried}。`,
    });
  }
  // Clear alerts for tasks that recovered on their own (so the next failure pings immediately).
  const badNames = new Set(bad.map((b) => b.name));
  for (const r of rows) if (!badNames.has(r.name)) resolve("task-health", r.name);
  if (!bad.length && !taskQueryError && REPORT) await inform("✅ 所有排程任務狀態正常（task-health）。");

  console.log(`task-health: ${repaired.length} re-registered (pending confirm), ${stillBad.length} escalated.`);
}


// ── PUBLISHER GATE ASSERTION ────────────────────────────────────────────────
// Every publisher must consult lib/publishable.mjs. This is a STATIC check, not a
// runtime one: the 2026-07-20 approval fix was applied to the manual scripts and
// not to their cron twins, so the reviewed path looked correct while the unattended
// path published `pending` and even `skip` posts to live client accounts for a day.
// Discipline did not survive; a check does. A new publisher that forgets the gate
// fails here, loudly, on the next 6-hourly run.
// v2, after Codex review 2026-07-21. v1 was substring-based and produced FALSE
// PASSES three ways: an unused import contains "isPublishable"; a stale comment
// contains `=== "approved"`; a comment mentioning publishable.mjs satisfied the
// freeze test. A check that cannot fail is the thing this file exists to catch,
// so v1 was itself an instance of the disease. v2 strips comments and requires
// CALL-SHAPED matches. It also discovers publishers by what they DO (live commit
// signatures) rather than by filename, because Codex found six live-account
// publishers outside the api-*.mjs pattern.
{
  const { readdirSync, existsSync, statSync: st, readFileSync: rf } = await import("node:fs");
  const { publisherGateFailures } = await import("./lib/publisher-gate.mjs");
  const offenders = [];
  const publishers = [];
  const scriptsDir = p("../scripts");
  // Final-tree count on 2026-07-29 is 16, including lib/fb-post.mjs now that lib/
  // is part of the walk. A lower count means the detector lost surface coverage.
  const MIN_PUBLISHERS = 16;

  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // A file is a PUBLISHER if it can commit to a live account: a Graph write, or a
  // browser automation that clicks Post/Schedule. Filename patterns miss too much.
  // WRITE signatures only. v2's first cut matched any `graph.facebook.com` and so
  // flagged read-only diagnostics (fb-diag, fb-getpage, fb-ig-check) and this file
  // itself — 14 false positives. A gate that cries wolf gets switched off, which is
  // the same end state as no gate. Reading page state is harmless; only committing
  // content is not.
  // v3, adversarial verify pass 2026-07-21. v2 was wrong in BOTH directions and the
  // two errors hid each other: it screamed about files that cannot publish while
  // staying silent about files that do.
  //
  //   FALSE POSITIVES (3) — `scheduled_publish_time` and `media_publish` are also
  //   READ fields. better-life/fb-verify-scheduled.mjs, diag-double-post-check.mjs and
  //   sunmood/fb-state.mjs only GET `…/scheduled_posts?fields=scheduled_publish_time`.
  //   They were flagged as ungated live publishers on every run, so task-health exited
  //   2 permanently — a red that means nothing is a red everyone learns to ignore.
  //
  //   FALSE NEGATIVES (4) — the three <brand>/schedule-week.mjs browser publishers and
  //   fb-postdebug.mjs drive Meta Business Suite through role-based Playwright locators
  //   ("Add photo", "Set date and time", filechooser) and never contain the literal
  //   token `click(Post`. They are the ORIGINAL manual publishers from the 2026-07-20
  //   incident, they were carrying their own fail-open copy of the freeze check, and
  //   the assertion written to prevent exactly that could not see them.
  //
  // A Graph WRITE is now a POST/DELETE method plus a publishing edge — never a field
  // name on its own. A BROWSER write is a Playwright session plus composer-shaped UI.
  const POST_METHOD = /method\s*:\s*["'`](?:POST|DELETE)["'`]/i;
  const PUBLISH_EDGE = /media_publish|scheduled_publish_time|\/(?:feed|photos|videos|media)\b/;
  const BROWSER_SESSION = /chromium\.(?:launch|launchPersistentContext|connectOverCDP)\s*\(|openContext\s*\(/;
  // The SUBMIT control, not the composer. Opening a composer is not publishing:
  // tml/bs-*-probe.mjs, fb-probe.mjs and copilot/fb-dress-page.mjs drive the same UI
  // to dump its controls and post nothing, while sunmood/delete-scheduled.mjs and
  // sunmood/cleanup-crosspost.mjs only REMOVE content (a posting freeze must never
  // block a takedown). Every real publisher ends at `name: /^Schedule$/` or an
  // equivalent commit click; no probe contains one — verified file by file 2026-07-21.
  const COMPOSER_UI =
    /getByRole\([^)]{0,80}(?:\^Post\$|\^Schedule\$|發佈|排程)|click\([^)]{0,80}(?:Post|Schedule|發佈|排程)/i;
  const COMMITS_LIVE = [
    (src) => POST_METHOD.test(src) && PUBLISH_EDGE.test(src), // Graph write to a publishing edge
    (src) => /\bpostOne\s*\(|\bpostToPage\s*\(/.test(src),    // shared FB posting helpers
    (src) => BROWSER_SESSION.test(src) && COMPOSER_UI.test(src), // browser composer commit
    (src) => /click\([^)]{0,80}(?:Post|Schedule|發佈|排程)/i.test(src),
  ];

  // Curated-batch publishers: they post a hand-written .md batch that has no per-post
  // `status` field, so there is no record for isApproved() to read. Their consent is
  // the operator typing the command, and they are NOT scheduled tasks (verified against
  // _ops/projects.json). They must still honour the freeze switch — the exemption below
  // covers the approval predicate ONLY, and any file not on this list still needs both.
  const CURATED_BATCH = new Set([
    "publish-fb.mjs",          // Better Life launch/batch-2 markdown batches
    "publish-fb-sunmood.mjs",  // Sunmood markdown batch
    "fb-postdebug.mjs",        // single-post debug flow, operator-driven
    // companies/better-life/ig-fill.json holds 40 records with keys i,slug,poster,
    // caption,date,time and NO status field — they are posts ALREADY approved and live
    // on Facebook, being back-filled to Instagram. Verified 2026-07-21.
    "ig-fill.mjs",
  ]);
  const SELF = `${scriptsDir}/task-health.mjs`;
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full, out); }
      else if (e.name.endsWith(".mjs") && !e.name.endsWith(".test.mjs") && !e.name.endsWith(".worker.mjs")) out.push(full);
    }
    return out;
  };

  for (const full of walk(scriptsDir)) {
    if (!existsSync(full) || full === SELF) continue; // never flag the checker itself
    const raw = rf(full, "utf8");
    const src = stripComments(raw);
    if (!COMMITS_LIVE.some((test) => test(src))) continue; // not a publisher
    const rel = full.slice(scriptsDir.length + 1);
    publishers.push(rel);
    const failures = publisherGateFailures({
      source: raw,
      relativePath: rel,
      approvalExempt: CURATED_BATCH.has(rel.replace(/^.*\//, "")),
    });
    if (failures.length) offenders.push(`${rel} [${failures.join("] [")}]`);
  }

  if (publishers.length < MIN_PUBLISHERS) {
    const msg =
      `🔴 PUBLISHER-GATE CHECK IS BLIND — it found only ${publishers.length} live-account ` +
      `publisher(s), fewer than the ${MIN_PUBLISHERS} known to exist. The detection signatures, ` +
      `not the publishers, are what changed. Found: ${publishers.join(", ") || "(none)"}`;
    console.error(msg);
    if (!DRY) await escalate({ source: "task-health", kind: "publisher-gate", severity: "crucial", text: msg });
    process.exitCode = 2;
  } else if (offenders.length) {
    const msg = "🔴 PUBLISHER GATE MISSING — these can commit to a live account without approval:\n" + offenders.join("\n");
    console.error(msg);
    // --dry must stay side-effect free: this file promises "never repair, never
    // send Telegram" under --dry, and resolve() persists alert state.
    if (!DRY) await escalate({ source: "task-health", kind: "publisher-gate", severity: "crucial", text: msg });
    process.exitCode = 2;
  } else {
    console.log(
      `publisher-gate: OK — all ${publishers.length} live-account publishers carry freeze + approval + claim boundaries`
    );
    if (!DRY) resolve("task-health", "publisher-gate");
  }
}

process.exitCode = taskQueryError || bad.length || process.exitCode === 2 ? 2 : 0;
