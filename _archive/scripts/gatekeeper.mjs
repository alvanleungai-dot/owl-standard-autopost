// scripts/gatekeeper.mjs — THE GATEKEEPER: a daily system-health TRIAGE that sits ABOVE the raw
// monitors (task health + durable posting coverage) and reports ONCE to the owner.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  THE PRINCIPLE — the owner is the CEO.
//  • They get ONE proactive, already-triaged report per day, with a concrete RECOMMENDATION per issue.
//  • They must NEVER be the one who first-notices a problem, and never see raw, repeating failures.
//  • The gap this closes: SCE-TaskHealth caught failing tasks but fired RAW, REPEATING Telegram pings.
//    It didn't recognize an obsolete task, didn't recommend a fix, didn't track how long it had
//    persisted — so the owner became first-line detection. WRONG. The Gatekeeper fixes that:
//        gather signals → TRIAGE (recognize known patterns) → RECOMMEND (never auto-mutate) →
//        one consolidated CEO digest, deduped + persistence-escalated via the alert gatekeeper.
//  • It RECOMMENDS only. It NEVER auto-disables a task and NEVER changes live FB/IG. Owner decides.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
//   node scripts/gatekeeper.mjs --dry     # gather + triage + PRINT the digest it WOULD send (sends nothing)
//   node scripts/gatekeeper.mjs           # gather + triage + send the daily CEO digest (deduped)
//
// State: secrets/gatekeeper-state.json (gitignored — secrets/ is in .gitignore) tracks, per finding,
// how many CONSECUTIVE days it has been failing, so day-1 is a quiet note and day-3+ escalates.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  triageTask, triageCoverage, buildDigest, updatePersistence,
  stampRemediation, nextMondays, furthestScheduled, isoDay, ICON,
} from "./lib/gatekeeper-core.mjs";
import { escalate, resolve, inform } from "./lib/alert.mjs";
import { askText } from "./lib/anthropic.mjs";
import { companyStatePath, runtimePath } from "./lib/paths.mjs";
import { readPostingControl } from "./lib/publishable.mjs";
import {
  assertGatekeeperAutofixAuthorized,
  gatekeeperAgentVerifyEnabled,
  gatekeeperAutofixAuthorization,
} from "./lib/gatekeeper-config.mjs";

if (process.env.SCE_IMPORT_ONLY === "1") process.exit(0);

const execFileP = promisify(execFile);
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const DRY = process.argv.includes("--dry");

// ── Remediation-layer config (process env first; fail-closed auto-fix) ──────────────────────────────
// The scheduled entrypoint has no --autofix argument and is therefore structurally report-only.
// Live remediation requires BOTH --autofix and exact GATEKEEPER_AUTOFIX=true; a requested action
// without the env authorisation aborts before any signal gathering.
const AUTOFIX_AUTHORIZATION = gatekeeperAutofixAuthorization();
const AUTOFIX_ENABLED = AUTOFIX_AUTHORIZATION !== null;
const AGENT_VERIFY_ENABLED = gatekeeperAgentVerifyEnabled();

// Reuse the publisher's fail-closed control. In cloud mode, missing
// In cloud mode, anything except PUBLISHING_ENABLED=1 is frozen; a wiped checkout cannot enable autofix.
const POSTING_FROZEN = !readPostingControl().enabled;

const STATE_PATH = runtimePath("secrets", "gatekeeper-state.json");
const loadState = () => { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; } };
const saveState = (s) => { try { mkdirSync(runtimePath("secrets"), { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {} };

// Today in HK (machine clock is HK; date-only is DST-free). Used for "date >= today" and the digest line.
const TODAY = isoDay(new Date());

// Active brands to check posting coverage for. bright-day is included only ONCE it has a scheduled post
// (an fbPostId on a future post) — until then it's still in launch prep, not a coverage risk.
const BRANDS = [
  { id: "owl-standard", label: "Owl Standard 簡樸房認證", weeksDir: companyStatePath("owl-standard", "weeks") },
];

// ── SIGNAL 1: task health ─────────────────────────────────────────────────────────────────────────
// One PowerShell round-trip → every SCE-related task with its state, LastTaskResult AND its action
// command (so triage can recognize an obsolete browser task by what it runs). A query glitch must never
// alarm — on error we return [] and the digest just omits the task section.
async function gatherTasks() {
  const PS =
    "Get-ScheduledTask | Where-Object { $_.TaskName -match 'OwlStandard|SCE' } | " +
    "ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; " +
    "$act = ($_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' || '; " +
    "[pscustomobject]@{ name = $_.TaskName; state = $_.State.ToString(); " +
    "lastResult = $i.LastTaskResult; action = $act } } | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS], { timeout: 60000 });
    const parsed = JSON.parse((stdout || "").trim() || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => ({ ...r, hex: "0x" + ((r.lastResult >>> 0).toString(16).toUpperCase()) }));
  } catch (e) {
    console.error("gatekeeper: could not query Task Scheduler:", e.message);
    return [];
  }
}

// ── SIGNAL 2: posting coverage ──────────────────────────────────────────────────────────────────────
// Flatten every brand's week files into future posts ({ date, fbPostId, status }). Both week-file shapes
// carry a per-post `date` (better-life uses weekId W-numbers but each post now has a date; sunmood/tml/
// bright-day are date-keyed) — so this is uniform.
function gatherBrandPosts(brand) {
  const out = [];
  if (!existsSync(brand.weeksDir)) return out;
  for (const f of readdirSync(brand.weeksDir).filter((x) => x.endsWith(".json") && !x.startsWith("_"))) {
    let w; try { w = JSON.parse(readFileSync(`${brand.weeksDir}/${f}`, "utf8")); } catch { continue; }
    for (const post of w.posts || []) {
      if (!post.date) continue;
      out.push({ date: post.date, fbPostId: post.fbPostId || null, status: post.status, error: post.error, slug: post.slug });
    }
  }
  return out;
}

// ── Render the CEO digest with Haiku (clean + brief), with a deterministic fallback if the API is down ──
async function renderDigest(digest) {
  // Deterministic skeleton — also the fallback if Haiku is unreachable, so the owner is never left blind.
  const head = digest.healthy
    ? `${ICON.green} 一切正常`
    : `${digest.icon} 今日有 ${digest.findings.length} 項需要留意`;
  const lines = digest.findings.map((f) => `${ICON[f.severity === "red" ? "red" : "amber"]} ${f.title}\n   → ${f.recommendation}`);
  const ctx = digest.ctx || {};
  const greenLine = digest.healthy
    ? `${ICON.green} 全線健康 — ${ctx.brandsCovered ?? "?"} 個品牌已排期${ctx.throughDate ? `至 ${ctx.throughDate}` : ""}${ctx.nextTopup ? `；下次 FB top-up ${ctx.nextTopup}` : ""}。`
    : "";
  // Remediation footer — auto-fix outcomes + agent verdicts. Appended to BOTH the skeleton and the Haiku
  // output so the owner always sees exactly what was auto-fixed / verified, in either rendering path.
  const remBlock = [...(digest.autoFixNotes || []), ...(digest.verifyNotes || [])];
  const remFooter = remBlock.length ? `\n\n— 自動修復 / 核實 —\n${remBlock.join("\n")}` : "";

  const skeleton = (digest.healthy
    ? `🛡️ SCE 守門人（${TODAY}）\n${greenLine}`
    : `🛡️ SCE 守門人（${TODAY}）\n${head}\n\n${lines.join("\n\n")}`) + remFooter;

  // Ask Haiku to word it cleanly + briefly in Cantonese-flavoured Chinese, WITHOUT inventing anything.
  try {
    const system =
      "你係一個系統健康『守門人』，要向一位老闆（CEO）匯報。風格：精簡、專業、廣東話書面語。" +
      "硬規則：(1) 只可以用我提供嘅事實，唔可以加料或臆測。(2) 保留每個 emoji severity icon（🟢🟡🔴）。" +
      "(3) 第一行係一句總結 verdict。(4) 每個問題一行描述 + 一行具體建議（以「→」開頭）。" +
      "(5) 全綠時只需一句正面總結。(6) 唔好加客套說話、唔好 markdown 標題、唔好超過原文資訊。";
    const prompt =
      `今日日期：${TODAY}。整體狀態：${digest.overall}。\n` +
      `品牌已排期數：${ctx.brandsCovered ?? "?"}；排期覆蓋至：${ctx.throughDate ?? "—"}；下次 FB top-up：${ctx.nextTopup ?? "—"}。\n\n` +
      (digest.healthy
        ? "冇任何問題。請出一句簡短正面嘅『全綠』總結（包含上面嘅排期資訊）。"
        : "以下係已 triage 嘅問題（severity / 描述 / 建議），請原樣保留資訊重新組織成乾淨匯報：\n\n" +
          digest.findings.map((f, i) =>
            `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n   建議：${f.recommendation}`).join("\n\n"));
    const worded = await askText(prompt, { system, maxTokens: 700 });
    // Append the remediation footer VERBATIM (Haiku is told only to word the findings — auto-fix/verify
    // outcomes are factual machine output and must not be paraphrased/invented).
    return `🛡️ SCE 守門人（${TODAY}）\n${worded.trim()}${remFooter}`;
  } catch (e) {
    console.error("gatekeeper: Haiku wording failed, using deterministic skeleton:", e.message);
    return skeleton;
  }
}

// ── REMEDIATION EXECUTOR (the "level b" actuator) ────────────────────────────────────────────────────
// SAFETY: this is the ONLY place anything is ever RUN, and it runs ONLY the two whitelisted shapes built by
// planAutoSafeFix(). It can: (a) Start-ScheduledTask (re-run a task — never disable/delete/edit), and
// (b) `node scripts/fb-topup.mjs` (idempotent backlog push). It cannot reach any other command. There is
// no code path here that disables a task, deletes/edits a post, touches FB/IG content, or spends money.

// (a) Re-run a transient-failed task. Start-ScheduledTask only re-launches it; it cannot mutate the task.
async function runRerunTask(taskName) {
  // Hard guard: only A-Z/0-9/-/_ task names (these come from our own triage, but defend anyway — no shell injection).
  if (!/^[A-Za-z0-9_-]+$/.test(String(taskName || ""))) throw new Error(`unsafe task name: ${taskName}`);
  const { stdout, stderr } = await execFileP(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Start-ScheduledTask -TaskName '${taskName}'; 'started ${taskName}'`],
    { timeout: 60000 },
  );
  return ((stdout || "") + (stderr || "")).trim() || `started ${taskName}`;
}

// (b) Run the idempotent FB top-up (api-schedule per brand). Only PUSHES already-approved backlog to FB;
// it never generates, deletes, or reschedules. Idempotent: posts that already have an fbPostId are skipped.
async function runFbTopup() {
  const { stdout, stderr } = await execFileP(process.execPath, [p("./fb-topup.mjs")], { timeout: 5 * 60 * 1000 });
  const out = ((stdout || "") + (stderr || "")).trim();
  return out.slice(-600) || "fb-topup completed (no output)"; // tail only — keep the digest line short
}

// Execute a single auto-safe plan, return a short result string. Throws on failure (caller downgrades).
// The Gatekeeper's auto-safe whitelist is the 2 NON-elevated fixes ONLY (re-run a transient task, fb-topup a
// backlog). Re-registering a crashed monitor is NOT here: that needs admin, and to keep ONE narrow elevated
// surface the single elevated repairer is task-health (infra-repair-core). A crashed monitor is classified
// agent-verify/escalate, so the Gatekeeper stays advisory and runs at RunLevel Limited.
async function executeAutoSafe(plan, authorization) {
  assertGatekeeperAutofixAuthorized(authorization);
  if (plan.type === "rerun-task") return await runRerunTask(plan.taskName);
  if (plan.type === "fb-topup") return await runFbTopup();
  throw new Error(`unknown auto-safe plan type: ${plan.type}`); // unreachable — whitelist is closed
}

// ── AGENT-VERIFY DISPATCH (read-only diagnosis via headless Claude Code) ──────────────────────────────
// Runs `claude -p "<scoped prompt>"` to VERIFY the live facts/stats, diagnose the root cause, and PROPOSE a
// fix — explicitly READ-ONLY, make NO changes, output a short verdict. If the `claude` CLI is missing or not
// headless-capable, we degrade GRACEFULLY: return null and let the finding escalate with its static rec.
// We NEVER let this crash the gatekeeper.
let CLAUDE_CLI_PATH = undefined; // memoized: string path, or "" if unavailable
async function findClaudeCli() {
  if (CLAUDE_CLI_PATH !== undefined) return CLAUDE_CLI_PATH;
  try {
    const { stdout } = await execFileP("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-Command claude -ErrorAction SilentlyContinue).Source"],
      { timeout: 15000 });
    CLAUDE_CLI_PATH = (stdout || "").trim().split(/\r?\n/)[0] || "";
  } catch { CLAUDE_CLI_PATH = ""; }
  return CLAUDE_CLI_PATH;
}

function buildVerifyPrompt(finding) {
  // A tightly-scoped, READ-ONLY prompt. We tell the agent exactly what to check and to make no changes.
  return [
    `你係 SCE 內容引擎嘅唯讀診斷 agent。專案根目錄：${p("../")}。今日：${TODAY}。`,
    `守門人偵測到以下問題，需要你「核實統計／事實」並提出修復建議：`,
    `- 範疇：${finding.area} / ${finding.kind}`,
    `- 標題：${finding.title}`,
    `- 初步建議：${finding.recommendation}`,
    ``,
    `任務（嚴格只可讀，唔可以改任何嘢）：`,
    `1) 用 read-only 方式核實上面嘅事實係咪仍然成立（睇 logs/、companies/<brand>/weeks/*.json、Task Scheduler 狀態等）。`,
    `2) 診斷最可能嘅 root cause。`,
    `3) 提出一個具體修復步驟畀老闆批核。`,
    `絕對唔好執行任何修改、唔好出帖、唔好改檔、唔好停用任務、唔好花錢。`,
    `輸出格式：一段精簡廣東話 verdict（≤4 句），包含「核實結果 + root cause + 建議」。`,
  ].join("\n");
}

// Dispatch the read-only verify agent. Returns a short verdict string, or null if unavailable/failed.
async function dispatchVerifyAgent(finding) {
  const cli = await findClaudeCli();
  if (!cli) return null; // CLI missing → degrade: caller escalates with static recommendation
  try {
    // --permission-mode plan and an allowed-tools allowlist keep it strictly read-only even if it tries to act.
    const args = [
      "-p", buildVerifyPrompt(finding),
      "--output-format", "text",
      "--permission-mode", "plan",       // plan mode = cannot edit/run; read-only by construction
      "--allowedTools", "Read", "--allowedTools", "Grep", "--allowedTools", "Glob",
    ];
    const { stdout } = await execFileP(cli, args, { timeout: 4 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    const verdict = (stdout || "").trim();
    if (!verdict) return null;
    return verdict.slice(-800); // keep the digest line bounded
  } catch (e) {
    console.error(`gatekeeper: verify-agent for ${finding.key} failed (${e.message?.slice(0, 120)}) — degrading to escalate.`);
    return null; // never crash the gatekeeper; degrade to escalate
  }
}

// ── MAIN ────────────────────────────────────────────────────────────────────────────────────────────
const prevState = loadState();

// 1. GATHER
const taskRows = await gatherTasks();
const mondays = nextMondays(TODAY, 2);

// Attach brand posts; decide which brands are "active" for coverage.
const brandsWithPosts = BRANDS.map((b) => ({ ...b, posts: gatherBrandPosts({ weeksDir: b.weeksDir }) }));
const activeBrands = brandsWithPosts.filter((b) =>
  !b.gateOnScheduled || b.posts.some((post) => post.fbPostId && post.date >= TODAY));

// 2. TRIAGE — first WITHOUT persistence to learn which findings exist today, then bump persistence,
// then re-triage so each finding carries its real consecutive-day count (drives the escalation tone).
const rawTaskFindings = taskRows.map((t) => triageTask(t)).filter(Boolean);
const rawCoverageFindings = activeBrands.map((b) => triageCoverage(b, mondays)).filter(Boolean);
const todaysKeys = [...rawTaskFindings, ...rawCoverageFindings].map((f) => f.key);

const newState = updatePersistence(prevState, todaysKeys, TODAY);
const daysFor = (key) => (newState[key]?.days || 1);

// Re-triage with persistence days folded in (days affects severity for tasks/coverage).
const taskFindings = taskRows
  .map((t) => triageTask({ ...t, days: daysFor(`task:${t.name}`) })).filter(Boolean);
const coverageFindings = activeBrands
  .map((b) => triageCoverage({ ...b, days: daysFor(`coverage:${b.id}`) }, mondays)).filter(Boolean);

// 3. BUILD the consolidated digest.
const throughDate = furthestScheduled(activeBrands);
const ctx = {
  date: TODAY,
  brandsCovered: activeBrands.filter((b) => b.posts.some((post) => post.fbPostId)).length,
  throughDate,
  nextTopup: nextMondays(TODAY, 1)[0], // FB top-up runs daily but effectively schedules as each Monday enters window
};
const allFindings = [...taskFindings, ...coverageFindings];

// 3a. CLASSIFY remediation for every finding (auto-safe | agent-verify | escalate). When posting is frozen,
// an fb-topup auto-safe fix is downgraded to escalate inside stampRemediation (we never schedule while frozen).
const classified = stampRemediation(allFindings, { frozen: POSTING_FROZEN });

console.log(`gatekeeper: ${TODAY} · ${classified.length} finding(s) · ${activeBrands.length} active brand(s) · ` +
  `mondays=${mondays.join(",")} · autofix=${AUTOFIX_ENABLED ? "ON" : "OFF"}${POSTING_FROZEN ? " · POSTING_FROZEN" : ""}` +
  `${DRY ? " · DRY" : ""}`);
const REM_ICON = { "auto-safe": "⚙️", "agent-verify": "🔎", escalate: "⬆️" };
for (const f of classified) {
  console.log(`  ${ICON[f.severity]} ${REM_ICON[f.remediation]} [${f.area}/${f.kind}] ${f.title} (day ${f.days}) → ${f.remediation}` +
    (f.plan ? ` {${f.plan.type}}` : ""));
}

// 3b. REMEDIATE. Walk each finding by class; collect outcome notes folded into the digest.
//   auto-safe   → run the whitelisted fix (or, in --dry, print what it WOULD run). Failure ⇒ downgrade to escalate.
//   agent-verify→ dispatch the READ-ONLY verify agent (or, in --dry, print what it WOULD dispatch). Degrade ⇒ escalate.
//   escalate    → no action here; flows to alert.mjs unchanged.
const autoFixNotes = [];   // "⚙️ 自動修復「X」：<result>"
const verifyNotes = [];    // "🔎 核實：<verdict + proposed fix>"
for (const f of classified) {
  if (f.remediation === "auto-safe" && f.plan) {
    if (DRY) {
      autoFixNotes.push(`⚙️（DRY）會自動修復：${f.plan.label}`);
    } else if (!AUTOFIX_ENABLED) {
      // Classified auto-safe but autofix is switched off → tell the owner what it WOULD have done, run nothing.
      autoFixNotes.push(`⚙️ 自動修復已停用（GATEKEEPER_AUTOFIX=off）：本可自動「${f.plan.label}」，未執行。`);
    } else {
      try {
        const result = await executeAutoSafe(f.plan, AUTOFIX_AUTHORIZATION);
        f.fixResult = result;
        f.fixed = true; // resolved by the auto-fix → excluded from the owner's "needs attention" list below
        autoFixNotes.push(`⚙️ 自動修復「${f.plan.label}」：成功。${String(result).split(/\r?\n/).at(-1) || ""}`.trim());
      } catch (e) {
        // Fix itself failed → DOWNGRADE to escalate (never silently swallow). Owner must see it.
        f.remediation = "escalate";
        f.fixError = e.message;
        autoFixNotes.push(`⚠️ 自動修復「${f.plan.label}」失敗，已升級畀你跟進：${String(e.message).slice(0, 160)}`);
      }
    }
  } else if (f.remediation === "agent-verify") {
    if (DRY) {
      verifyNotes.push(`🔎（DRY）會派唯讀核實 agent 診斷：${f.title}`);
    } else if (!AGENT_VERIFY_ENABLED) {
      verifyNotes.push(`🔎 核實 agent 已停用：${f.title}（沿用靜態建議升級）。`);
    } else {
      const verdict = await dispatchVerifyAgent(f);
      if (verdict) { f.verifyVerdict = verdict; verifyNotes.push(`🔎 核實「${f.title}」：${verdict}`); }
      else {
        // CLI missing / not headless / failed → degrade gracefully to escalate with the static recommendation.
        f.remediation = "escalate";
        verifyNotes.push(`🔎 核實 agent 唔可用，已用靜態建議升級：${f.title}`);
      }
    }
  }
}

// 4. BUILD the consolidated digest from the findings the owner STILL needs to see. A finding that was
// successfully auto-fixed (f.fixed) is resolved → drop it from the attention list, but its "⚙️ 自動修復…"
// note stays in the footer so the owner has a record. Agent-verify findings remain (owner approves any action).
const remaining = classified.filter((f) => !f.fixed);
const digest = buildDigest(remaining, ctx);
digest.autoFixNotes = autoFixNotes;
digest.verifyNotes = verifyNotes;

const message = await renderDigest(digest);

if (DRY) {
  // --dry: show EXACTLY what the CEO would receive, send nothing, persist nothing.
  console.log("\n─────────── DIGEST IT WOULD SEND (--dry, not sent) ───────────");
  console.log(message);
  console.log("──────────────────────────────────────────────────────────────");
  // Let the process exit naturally once the event loop drains (avoids the libuv handle-close assert that
  // a hard process.exit() can trip on Windows while the HTTPS keep-alive socket is still closing).
} else {

// 4. REPORT — route through the alert gatekeeper so it dedupes (no spam) but escalates worsening issues.
//   • Any RED finding → escalate() under a per-issue key (its own cooldown; clears when the issue
//     resolves so the next occurrence pings immediately).
//   • A clean / amber-only day → a once-daily green "heartbeat" via the 'gatekeeper:heartbeat' key
//     (info cooldown = once per 24h) so the owner knows it's watching, without spam.
// We send ONE consolidated message either way; the per-key escalate calls only decide WHETHER to send.
saveState(newState); // persist the consecutive-day counters

// An auto-fix that FAILED is genuinely urgent — the system tried to self-heal and couldn't. Treat those
// (and any red) on the crucial path so the owner is told promptly, not just on the daily heartbeat.
const autoFixFailures = classified.filter((f) => f.fixError);
if (digest.reds.length || autoFixFailures.length) {
  // Worsening / important: escalate the consolidated digest. Key folds in the red + failed-fix issue-keys so
  // a NEW problem appearing later breaks the cooldown and re-sends immediately.
  const redKey = [...digest.reds, ...autoFixFailures].map((f) => f.key).sort().join("|");
  const sent = await escalate({
    source: "gatekeeper", kind: `digest:${redKey}`, severity: "crucial", text: message,
  });
  if (!sent) console.log("gatekeeper: red digest screened by cooldown (already informed within window).");
  // Clear keys for red issues that are no longer present, so their next occurrence alerts at once.
  // (handled implicitly: a resolved key won't be in redKey tomorrow → new key → sends.)
} else {
  // Green or amber-only → friendly once-daily heartbeat. inform() bypasses dedupe, but we gate it
  // through escalate() at info severity so it's at most once per 24h (no double-heartbeat on reruns).
  const sent = await escalate({ source: "gatekeeper", kind: "heartbeat", severity: "info", text: message });
  if (sent) resolve("gatekeeper", "digest"); // belt-and-braces: clear any stale red digest state on a green day
  else console.log("gatekeeper: heartbeat already sent today (info cooldown).");
}

console.log("gatekeeper done.");

} // end live (non-dry) branch

// Exit code: 2 if any red OR any auto-fix failure (so a wrapping monitor/log notices), else 0. Set, not
// process.exit(), so the event loop drains the HTTPS keep-alive socket cleanly on Windows.
process.exitCode = (digest.reds.length || classified.some((f) => f.fixError)) ? 2 : 0;
