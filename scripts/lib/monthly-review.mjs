// scripts/lib/monthly-review.mjs — PURE logic for WHEN the owner is shown posters. No I/O.
//
// THE CHANGE (2026-08-04, owner-directed)
//   Owner: "when will send me every month… It should be the first day of the month, right?"
//   It was not. Posters were delivered on GENERATION — every Thursday, four brands, one week at a
//   time: roughly 200 review messages a year for a man whose stated goal is "hands-off". His mental
//   model was a monthly batch and the machine's was weekly, and the machine had been winning
//   silently for months.
//
//   So delivery moves to ONE batch per calendar month, per brand, through that brand's own bot
//   (never a shared one — CLAUDE.md forbids borrowing, and the approve buttons only work on the bot
//   that owns them). Generation, auto-approval and publishing are all untouched; only the moment he
//   is shown things changes.
//
// THE SAFETY NET, AND WHY IT IS NOT OPTIONAL
//   A monthly delivery means a post can be generated on the 6th and published on the 10th without
//   ever having been shown. That is the one thing this must never do — the whole review mechanism
//   exists so nothing reaches a client page unseen. So anything inside LEAD_DAYS of its publish date
//   is delivered immediately regardless of the monthly cycle. In steady state it never fires, because
//   the queue runs ~8 weeks ahead; it exists for the month where something arrives late.
//
// SELF-HEALING BY CONSTRUCTION
//   The trigger is "the current month is not the month we last delivered", not "today is the 1st".
//   If the bot is down on the 1st it delivers the moment it comes back, instead of skipping a month
//   in silence. Same reasoning as the review sweep's stranded-week fix (2026-07-31).

import { isBroken, isDecided } from "./review-core.mjs";

// A post closer than this to publication is shown NOW, monthly cycle or not.
export const LEAD_DAYS = 7;
export const MS_PER_DAY = 86_400_000;

/** HK calendar month key, e.g. "2026-08". The cycle must turn over on Hong Kong's clock, not UTC's. */
export function hkMonthKey(nowMs) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" })
    .format(new Date(nowMs))
    .slice(0, 7);
}

/** Whole days from now until a post's publish date (negative = already past). */
export function daysUntil(dateStr, nowMs) {
  const at = Date.parse(`${dateStr}T10:00:00+08:00`);
  if (!Number.isFinite(at)) return Infinity;
  return Math.floor((at - nowMs) / MS_PER_DAY);
}

/** Has this post already been shown to the owner? */
export function isUndelivered(post) {
  return post?.review?.sentAt == null;
}

/**
 * Is a post eligible to be shown at all?
 * Broken posts are excluded deliberately: they are withheld and repaired, and showing the owner a
 * poster with garbled text to approve is asking him to do the machine's job.
 */
export function isDeliverable(post, todayStr) {
  if (!post || !post.slug) return false;
  if (!isUndelivered(post)) return false;
  if (isDecided(post) || isBroken(post)) return false;
  if (post.status === "skip") return false;
  if (!post.date || post.date < todayStr) return false;
  return true;
}

/**
 * PURE. Decide what to deliver right now.
 *
 * @returns {{ deliver: object[], reason: string, monthlyBatch: boolean, month: string }}
 */
export function planMonthlyDelivery({
  posts = [],
  nowMs,
  todayStr,
  lastDeliveredMonth = null,
  leadDays = LEAD_DAYS,
} = {}) {
  const month = hkMonthKey(nowMs);
  const eligible = posts.filter((post) => isDeliverable(post, todayStr));

  // The monthly batch: a new calendar month has begun since the last batch.
  if (month !== lastDeliveredMonth) {
    return {
      deliver: eligible,
      monthlyBatch: true,
      month,
      reason: `monthly batch for ${month} (last delivered: ${lastDeliveredMonth ?? "never"})`,
    };
  }

  // Otherwise: only the safety net. Anything about to publish that he has not seen.
  const urgent = eligible.filter((post) => daysUntil(post.date, nowMs) <= leadDays);
  return {
    deliver: urgent,
    monthlyBatch: false,
    month,
    reason: urgent.length
      ? `${urgent.length} post(s) publish within ${leadDays} days and were never shown — delivering out of cycle`
      : "nothing due",
  };
}

/** The header that opens a monthly batch, so it reads as one delivery rather than a burst. */
export function batchHeader(brandLabel, month, count, { autoApprove = false } = {}) {
  const [year, mon] = month.split("-");
  return `📅 ${brandLabel}｜${year}年${Number(mon)}月內容：${count} 篇\n\n` + (autoApprove
    ? "逐張睇，唔想出就撳 ❌，想改就撳 🔁。冇回覆嘅話 48 鐘之後會自動當「出」。"
    : "請逐張查看：確定發佈按 ✅，不發佈按 ❌，想修改按 🔁。未批准的帖文不會發佈。");
}
