// scripts/lib/gatekeeper-core.mjs — PURE triage logic for the Gatekeeper. No I/O (no fs, no network,
// no Task Scheduler). Everything here is a deterministic function of the signals handed in, so it can
// be unit-tested (gatekeeper-core.test.mjs) and the same triage runs identically in --dry and live.
//
// THE PRINCIPLE (encoded here, enforced everywhere):
//   The owner is the CEO. They get ONE proactive, already-triaged report with a recommendation per
//   issue — never a raw, repeating failure, and never the role of first-noticing a problem. The
//   Gatekeeper sits ABOVE the raw monitors (task-health, watchdog): it RECOGNIZES the finding, tracks
//   how long it has persisted, attaches a concrete RECOMMENDATION, and decides the severity. It does
//   NOT mutate anything (never auto-disables a task, never touches FB/IG) — it recommends, owner decides.
//
// Severity ladder:  🟢 healthy  ·  🟡 routine / recommend (auto-suppressed once acknowledged)  ·  🔴 needs-owner.
// Escalation is by PERSISTENCE: a brand-new finding is a quiet note; the same finding still unfixed on
// day 3+ gets louder. Persistence is tracked by the caller in a state file and passed in as `days`.

export const ICON = { green: "🟢", amber: "🟡", red: "🔴" };

// ── Task-health triage ────────────────────────────────────────────────────────
// A failing scheduled task is only worth the CEO's attention if it's ENABLED (a disabled task is
// already neutralized — no alarm). We then recognize KNOWN patterns from the task's action command so
// we can recommend instead of just reporting a hex code.
//
// task: { name, state, lastResult (uint), hex, action (the Execute+Arguments string), days }
// Returns a finding { area, key, severity, title, recommendation, days } or null if healthy/ignore.

// Windows Task Scheduler LastTaskResult codes that are NOT a failure (kept in sync with task-health-core).
const TASK_BENIGN = new Set([0x0, 0x41301, 0x41303]);

// Heuristic: does this task's action drive a browser (Playwright / Business Suite / a *schedule-week*
// browser scheduler)? Those were superseded by the Graph-API schedulers (api-schedule + fb-topup),
// so a browser task failing for days is almost certainly OBSOLETE, not broken — recommend disabling it.
export function looksObsoleteBrowserTask(action = "") {
  const a = String(action).toLowerCase();
  return /schedule-week|business\s*suite|playwright|warm-chrome|post-today|gen-week|tg-bridge|feedback/.test(a);
}

export function triageTask(task) {
  const result = (task.lastResult >>> 0);
  if (TASK_BENIGN.has(result)) return null;                       // success / running / never-run → healthy
  if (String(task.state).toLowerCase() === "disabled") return null; // already neutralized → no alarm

  const days = task.days || 1;
  const hex = task.hex || ("0x" + result.toString(16).toUpperCase());
  const louder = days >= 3;                                       // persisted → escalate tone

  // KNOWN PATTERN: an obsolete browser task still on a schedule, failing day after day.
  // kind "obsolete-task" → recommendation is to DISABLE a task = destructive → ALWAYS escalate (owner decides).
  if (looksObsoleteBrowserTask(task.action)) {
    return {
      area: "task", kind: "obsolete-task", taskName: task.name, key: `task:${task.name}`, severity: louder ? "red" : "amber", days,
      title: `排程任務「${task.name}」連續 ${days} 日失敗（${hex}）`,
      recommendation: `呢個係舊式瀏覽器任務，已被 Graph API 排程（api-schedule + fb-topup）取代。建議停用：Disable-ScheduledTask -TaskName "${task.name}"（我唔會自動停，等你拍板）。`,
    };
  }

  // KNOWN PATTERN: a MONITOR (task-health / watchdog / preflight / catchup / gatekeeper). These exit code
  // 2 BY DESIGN to SIGNAL "I found + escalated issues" — that's the monitor WORKING, not broken (the
  // gatekeeper already reads the underlying issues directly, so it won't be missed). So 0x2 from a monitor
  // is benign; only a DIFFERENT non-benign code is a genuine "who watches the watcher" crash.
  if (/taskhealth|watchdog|preflight|catchup|gatekeeper/i.test(task.name)) {
    if (result === 2) return null;                                // 2 = "found+escalated" signal → healthy
    // kind "monitor-crash" → a watcher itself broke. Read-only diagnosis is the right next step → agent-verify.
    return {
      area: "task", kind: "monitor-crash", taskName: task.name, key: `task:${task.name}`, severity: louder ? "red" : "amber", days,
      title: `監察任務「${task.name}」本身連續 ${days} 日失敗（${hex}）`,
      recommendation: `監察器自己出錯（exit ${hex}，唔係代表「發現問題」嘅 2 號訊號）。睇 logs/ 對應檔 + Task Scheduler History；唔影響出帖，但要修番先信得過。`,
    };
  }

  // Unknown failing enabled task — surface it, lead investigates. Louder once it persists.
  // kind "task-failure" → a DAY-1 transient failure of an enabled non-obsolete task is the one auto-safe
  // re-run case (whitelist item i); a PERSISTED one (re-running clearly isn't curing it) is no longer
  // "transient" → it needs diagnosis, not another blind re-run. The classifier decides via `days`.
  return {
    area: "task", kind: "task-failure", taskName: task.name, key: `task:${task.name}`, severity: louder ? "red" : "amber", days,
    title: `排程任務「${task.name}」連續 ${days} 日失敗（${hex}）`,
    recommendation: `未識別嘅失敗。睇 Task Scheduler History 同對應 log 搵原因；如已過時就建議停用，否則修好個 script。`,
  };
}

// ── Posting-coverage triage ────────────────────────────────────────────────────
// For each ACTIVE brand we want the next ~2 Mondays covered. A Monday is COVERED if some future post
// is already scheduled on Facebook (has fbPostId) for that date. If a Monday has a post sitting in the
// BACKLOG (a generated/approved post for it but not yet pushed to FB — normal, fb-topup will schedule
// it once it enters Meta's ~30-day window) that's 🟡 (fine, just noting). A Monday with NEITHER a
// scheduled post NOR any backlog to fill it is a TRUE GAP → 🔴 (the CEO would otherwise first-notice a
// silent week).
//
// brand: { id, label, posts: [{ date, fbPostId, status }] }  (posts already flattened across week files)
// mondays: ["YYYY-MM-DD", ...] the upcoming Mondays to check
// Returns a finding or null (fully covered).
export function triageCoverage(brand, mondays) {
  const posts = brand.posts || [];
  const scheduledDates = new Set(posts.filter((p) => p.fbPostId && p.date).map((p) => p.date));
  // Backlog = a usable future post for that date with no fbPostId yet and not failed/broken.
  const backlogDates = new Set(
    posts.filter((p) => p.date && !p.fbPostId && p.status !== "failed" && !p.error).map((p) => p.date),
  );

  const gaps = [];      // Mondays with nothing at all → real risk of an empty week
  const backlogOnly = []; // Mondays covered only by backlog → fine, will auto-schedule
  for (const mon of mondays) {
    if (scheduledDates.has(mon)) continue;        // already live on FB → covered
    if (backlogDates.has(mon)) { backlogOnly.push(mon); continue; }
    gaps.push(mon);
  }

  if (gaps.length) {
    const days = brand.days || 1;
    return {
      // kind "gap" = NOTHING to schedule (no backlog) → top-up CANNOT fix it; needs content gen → escalate.
      area: "coverage", kind: "gap", brand: brand.id, key: `coverage:${brand.id}`, severity: "red", days,
      title: `${brand.label}：未來有 ${gaps.length} 個星期一冇內容（${gaps.join("、")}）`,
      recommendation: `呢啲日子冇排期帖、亦冇 backlog 補位 → 出帖會斷檔。建議跑該品牌嘅 weekly-run 生成內容，再 api-schedule 排期。`,
    };
  }
  if (backlogOnly.length) {
    return {
      // kind "backlog" = content EXISTS but not yet pushed to FB → fb-topup (idempotent Graph API) schedules
      // it. This is the ONE coverage case that is an auto-safe deterministic fix (whitelist item ii).
      area: "coverage", kind: "backlog", brand: brand.id, key: `coverage:${brand.id}`, severity: "amber", days: brand.days || 1,
      title: `${brand.label}：${backlogOnly.join("、")} 有內容但仲未排上 FB`,
      recommendation: `屬正常 backlog（FB 只接受約 30 日內排期）。SCE-FB-Topup 會喺日子進入窗口時自動排，無需動作。`,
    };
  }
  return null; // every checked Monday is scheduled-live → covered
}

// ── REMEDIATION classification (the "level b" self-healing brain) ────────────────────────────────────
// Every finding is classified into exactly ONE remediation class. This is the SAFETY HEART of the layer:
// the auto-safe whitelist lives HERE, in one pure place, so it can be unit-tested and audited at a glance.
//
//   "auto-safe"    — a known DETERMINISTIC, NON-destructive, NON-spending fix. STRICT 2-ITEM WHITELIST:
//                      (i)  a TRANSIENT-failed (day-1) ENABLED non-obsolete scheduled task → re-run it
//                           (Start-ScheduledTask — re-runs, never disables/deletes/edits the task).
//                      (ii) a posting backlog GAP (content exists but isn't on FB yet) → fb-topup
//                           (idempotent Graph-API scheduler — only PUSHES already-approved backlog).
//                    NOTHING else is auto-safe.
//   "agent-verify" — needs diagnosis. Dispatch a strictly READ-ONLY verify-agent to confirm the live facts
//                    and PROPOSE a fix. Makes no changes; the owner approves any action.
//   "escalate"     — needs the owner: anything destructive (disable/delete/reschedule), money-spending
//                    (OpenAI billing), an obsolete-task recommendation, or any persisted/unknown failure.
//
// Returns one of: "auto-safe" | "agent-verify" | "escalate".  Pure: a function of the finding's fields only.
export function classifyRemediation(finding) {
  if (!finding) return "escalate";
  const { area, kind, days = 1, severity } = finding;

  if (area === "task") {
    // WHITELIST (i): a transient (day-1) unknown failure of an enabled, non-obsolete task → safe to re-run.
    // Persisted (day >= 2) means a re-run already didn't cure it → stop blindly re-running, diagnose instead.
    if (kind === "task-failure") return days >= 2 ? "agent-verify" : "auto-safe";
    // A monitor that crashed (not the exit-2 signal) → read-only diagnosis. Re-registering a crashed monitor
    // needs admin, so it is NOT auto-fixed here: to keep ONE narrow elevated surface, the always-on
    // task-health monitor (S4U+Highest, infra-repair-core) is the only thing that re-registers tasks. The
    // Gatekeeper stays advisory (Limited) and escalates a crashed monitor instead.
    if (kind === "monitor-crash") return "agent-verify";
    // Obsolete browser task → the fix is to DISABLE it (destructive) → owner decides.
    if (kind === "obsolete-task") return "escalate";
    return "escalate"; // unknown task kind → safest default
  }

  if (area === "coverage") {
    // WHITELIST (ii): backlog exists but not yet pushed to FB → fb-topup is the idempotent deterministic fix.
    if (kind === "backlog") return "auto-safe";
    // A true GAP (no scheduled post AND no backlog) → top-up has nothing to schedule → needs content gen → owner.
    if (kind === "gap") return "escalate";
    return "escalate";
  }

  if (area === "generation") {
    if (kind === "billing") return "escalate";    // raising a usage limit spends money → owner only
    if (kind === "zeroweek") return "agent-verify"; // verify (read-only) whether a retry already filled it
    return "escalate";
  }

  return "escalate"; // unknown area → safest default
}

// Build the deterministic, whitelisted fix PLAN for an auto-safe finding. Returns null for anything not
// auto-safe (a hard second gate: even if classification said auto-safe, no plan ⇒ no fix is run). The plan
// is data only — it is the executor in gatekeeper.mjs that actually runs it, and ONLY these two shapes exist:
//   { type: "rerun-task", taskName }      → Start-ScheduledTask -TaskName <taskName>   (re-run, never mutate)
//   { type: "fb-topup", brand }           → node scripts/fb-topup.mjs                   (idempotent backlog push)
// `frozen` (caller passes the live POSTING_FROZEN state) FORCES a fb-topup plan to null → it will not run a
// posting/scheduling fix while posting is frozen; the caller downgrades that finding to escalate instead.
export function planAutoSafeFix(finding, { frozen = false } = {}) {
  if (classifyRemediation(finding) !== "auto-safe") return null;
  if (finding.area === "task" && finding.kind === "task-failure") {
    return { type: "rerun-task", taskName: finding.taskName, label: `重跑任務「${finding.taskName}」` };
  }
  if (finding.area === "coverage" && finding.kind === "backlog") {
    if (frozen) return null; // posting is frozen → do NOT autonomously schedule; caller escalates instead.
    return { type: "fb-topup", brand: finding.brand, label: `FB top-up 補排「${finding.brand}」backlog` };
  }
  return null;
}

// Stamp the `remediation` class onto each finding (and attach the auto-safe `plan`, if any). This is the
// SINGLE place the orchestrator calls to classify — so --dry and live see identical classes. When posting is
// frozen, an otherwise auto-safe fb-topup loses its plan and is DOWNGRADED to escalate (we never schedule
// while frozen). Returns a NEW array of findings each carrying `{ remediation, plan }`.
//   opts: { frozen?: bool, autofixEnabled?: bool } — autofixEnabled=false downgrades auto-safe → agent? No:
//   it stays classed "auto-safe" (so the digest can say "would auto-fix") but the executor simply won't run.
export function stampRemediation(findings, { frozen = false } = {}) {
  return (findings || []).filter(Boolean).map((f) => {
    let remediation = classifyRemediation(f);
    let plan = remediation === "auto-safe" ? planAutoSafeFix(f, { frozen }) : null;
    // Safety: classified auto-safe but no concrete whitelisted plan could be built (e.g. frozen blocked the
    // fb-topup) → it is NOT safe to auto-act → fall back to escalate so the owner sees it.
    if (remediation === "auto-safe" && !plan) remediation = "escalate";
    return { ...f, remediation, plan };
  });
}

// ── Digest assembly ─────────────────────────────────────────────────────────────
// Roll every finding into ONE structured digest. The overall verdict = the worst severity present.
// This is the single object the CEO report is rendered from (by Haiku, then sent once via alert.mjs).
export function buildDigest(findings, ctx = {}) {
  const real = (findings || []).filter(Boolean);
  const reds = real.filter((f) => f.severity === "red");
  const ambers = real.filter((f) => f.severity === "amber");
  const overall = reds.length ? "red" : ambers.length ? "amber" : "green";
  return {
    overall,                                   // green | amber | red
    icon: ICON[overall],
    reds, ambers,
    findings: [...reds, ...ambers],            // reds first so the CEO sees what matters most
    healthy: overall === "green",
    ctx,                                       // { date, brandsCovered, throughDate, nextTopup, ... } for the green line
  };
}

// Persistence bookkeeping (pure): given prior state + the set of finding keys seen TODAY, bump the
// consecutive-day counter for ones still present, reset (drop) ones that cleared. The caller persists
// the returned state. lastSeenDate guards against double-counting two runs on the same calendar day.
// state shape: { [key]: { days, firstSeen, lastSeenDate } }
export function updatePersistence(prevState, activeKeys, today) {
  const prev = prevState || {};
  const next = {};
  const active = new Set(activeKeys);
  for (const key of active) {
    const p = prev[key];
    if (!p) { next[key] = { days: 1, firstSeen: today, lastSeenDate: today }; continue; }
    if (p.lastSeenDate === today) { next[key] = { ...p }; continue; }   // already counted today → hold
    next[key] = { days: (p.days || 1) + 1, firstSeen: p.firstSeen || today, lastSeenDate: today };
  }
  // keys not seen today are intentionally dropped → a recovered issue resets to day 1 next time.
  return next;
}

// ── Date helpers (pure) ──────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// The next `count` Mondays strictly AFTER (or on) `from`, as YYYY-MM-DD (UTC math; HK has no DST so a
// date-only Monday is unambiguous). If `from` itself is a Monday it's included as the first one.
export function nextMondays(fromIso, count = 2) {
  const base = new Date(`${fromIso}T00:00:00Z`);
  const out = [];
  const d = new Date(base);
  // advance to the first Monday on/after `from` (getUTCDay: 0=Sun,1=Mon)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  for (let i = 0; i < count; i++) { out.push(isoDay(d)); d.setUTCDate(d.getUTCDate() + 7); }
  return out;
}

// Furthest-out scheduled post date across all brands → used for the green "scheduled through <date>" line.
export function furthestScheduled(brands) {
  let max = "";
  for (const b of brands || []) for (const p of b.posts || []) {
    if (p.fbPostId && p.date && p.date > max) max = p.date;
  }
  return max || null;
}
