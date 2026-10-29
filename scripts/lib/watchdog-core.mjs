// scripts/lib/watchdog-core.mjs — pure logic for the posting watchdog. No I/O.
// All time inputs are epoch ms; HK = UTC+8 (no DST). Tested in watchdog-core.test.mjs.
const pad = (n) => String(n).padStart(2, "0");
const HK = 8 * 3600_000;
const DOW = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };

export const isApproved = (p) => p.status === "approved";

// Today's date string (YYYY-MM-DD) in HK.
export function hkTodayStr(nowMs) {
  const d = new Date(nowMs + HK);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// For day-based brands (Better Life): the date of THIS week's <post.day>, in HK.
export function weekdayDate(post, nowMs) {
  const d = new Date(nowMs + HK);
  const mondayIdx = (d.getUTCDay() + 6) % 7;        // 0=Mon … 6=Sun
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - mondayIdx);
  const off = DOW[post.day] ?? 0;
  const t = new Date(monday); t.setUTCDate(monday.getUTCDate() + off);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// A post's scheduled calendar date: explicit (TML/Sunmood) or derived from its weekday (Better Life).
export function postDate(post, nowMs) { return post.date || weekdayDate(post, nowMs); }

// Overdue = its slot day is strictly before today (a ~1-day grace so we never race Meta's own
// scheduled publish on the post's own day — only republish posts that are genuinely past-due).
export function isOverdue(post, nowMs) { return postDate(post, nowMs) < hkTodayStr(nowMs); }

// Split approved posts into those whose marker is live on the page vs missing.
export function reconcile(approved, liveSet) {
  const live = [], missing = [];
  for (const x of approved) ((x.__marker && liveSet.has(x.__marker)) ? live : missing).push(x);
  return { live, missing };
}

// Classify a failure string into a category. login/billing = crucial (escalate to owner);
// transient = infrastructure noise (interrupted run, timeout, network) — retry/ignore, never alarm.
export function classifyFailure(text) {
  const t = (text || "").toLowerCase();
  if (/not_logged_in|not logged in|session expired|checkpoint/.test(t)) return "login";
  if (/billing|insufficient_quota|hard.?limit|quota|exceeded your current|credit/.test(t)) return "billing";
  if (/browser has been closed|target page.*clos|target clos|context.*clos|page\.goto|timeout|timed out|net::|err_|navigation|econn|socket hang up|epipe|protocol error/.test(t)) return "transient";
  return "unknown";
}

// Owner-facing escalation copy (Cantonese).
export function escalationMsg(kind, label, detail = "") {
  if (kind === "login") return `🔴 ${label}：Facebook／Instagram 登入過期，要你重新登入先出到帖。喺電腦行對應 warm-chrome（例如 node scripts/owl-standard/warm-chrome.mjs）再登入。`;
  if (kind === "billing") return `🔴 ${label}：API 額度滿咗（billing limit）。去 platform.openai.com → Settings → Limits 加返額度，再叫我重新生成。`;
  return `⚠️ ${label}：出咗個未知問題，需要你睇下：\n${String(detail).slice(0, 300)}`;
}
