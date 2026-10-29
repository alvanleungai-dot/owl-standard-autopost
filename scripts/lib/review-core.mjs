// scripts/lib/review-core.mjs — pure logic for the brand review bots (Sunmood / Better Life / TML).
// No I/O. All time inputs are epoch ms; callers pass Date.now(). HK = UTC+8 (no DST).
const HOUR = 3600_000, DAY = 86_400_000, HK = 8 * HOUR;

export const AUTO_APPROVE_HOURS = 48;
export const LAST_CALL_HOURS = 3;
export const DIGEST_HOUR = 10;
export const AUTO_APPROVE_MS = AUTO_APPROVE_HOURS * HOUR;
// Manual approval (the default): one reminder this long before an undecided post's publish time.
export const REMINDER_HOURS = 24;
// Posts publish at 10:00 HK on their date (api-schedule.mjs books exactly that time).
const publishAtMs = (post) => Date.parse(`${post?.date}T10:00:00+08:00`);

// Matches both date slugs (2026-06-15-01) and ISO-week slugs (2026-W25-01).
const SLUG_RE = /\d{4}-(?:W\d{2}|\d{2}-\d{2})-\d+/;
const VERBS = new Set(["keep", "skip", "regen"]);

// Human label for a post across brand schemas.
export const postLabel = (p) => p.headline || p.title || p.topic || p.name || p.slug;

export const formatCallback = (verb, slug) => `${verb}|${slug}`;
export function parseCallback(data) {
  const i = String(data || "").indexOf("|");
  if (i < 0) return null;
  const verb = data.slice(0, i), slug = data.slice(i + 1);
  if (!VERBS.has(verb) || !SLUG_RE.test(slug)) return null;
  return { verb, slug };
}

export const posterKeyboard = (slug, { regen = true } = {}) => ({
  inline_keyboard: [[
    { text: "✅ 出",   callback_data: formatCallback("keep", slug) },
    { text: "❌ 唔出", callback_data: formatCallback("skip", slug) },
    ...(regen ? [{ text: "🔁 重做", callback_data: formatCallback("regen", slug) }] : []),
  ]],
});

export const bulkKeyboard = () => ({
  inline_keyboard: [[{ text: "✅ 全部剩低都出", callback_data: "keepall" }]],
});

export const redoPrompt = (slug, headline) =>
  `✏️ 想改啲咩？回我一句（例如：標題短啲）\n#${slug} ${headline || ""}`.trim();
export function extractSlugFromPrompt(text) {
  const m = String(text || "").match(SLUG_RE);
  return m ? m[0] : null;
}

export const computeAutoApproveAt = (sentAtMs) => sentAtMs + AUTO_APPROVE_HOURS * HOUR;

export function stampReview(post, nowMs) {
  post.review = {
    sentAt: nowMs,
    autoApproveAt: computeAutoApproveAt(nowMs),
    decidedAt: null,
    decidedBy: null,
    lastCallSent: false,
    observedLiveMs: 0,
    lastObservedPollAt: null,
    livenessUnknown: false,
  };
}

export const isDecided = (p) => p.status === "approved" || p.status === "skip";
export const isUndecided = (p) => !isDecided(p);

/**
 * May `keep all` approve this post? Only one the owner has actually been SHOWN (review.sentAt set),
 * still undecided, not broken, and not yet past its date. Without the sentAt test, "approve all"
 * also approved posters generated after the last review batch — posts nobody had seen.
 */
export function isBulkApprovable(post, todayStr) {
  if (!post || post.review?.sentAt == null) return false;
  if (!isUndecided(post) || isBroken(post)) return false;
  return !!post.date && post.date >= todayStr;
}

/**
 * Turn api-schedule.mjs output into the short report the owner sees after approving.
 * Totals from its final line; every skipped/blocked/failed line verbatim; anything else (frozen,
 * missing token) is reported as "could not complete" with the lines that explain why.
 */
export function bookingReport(output) {
  const lines = String(output || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const totals = lines.join("\n").match(/Scheduled (\d+), already booked (\d+), later (\d+), dup\/date-blocked (\d+), failed (\d+)/);
  const problems = lines.filter((l) => /⛔|❌|⏭️/.test(l)).slice(0, 8);
  const head = totals
    ? `📅 Facebook 預約：成功 ${totals[1]}、早前已預約 ${totals[2]}、稍後自動預約 ${totals[3]}、` +
      `重複或當日已有帖文 ${totals[4]}、失敗 ${totals[5]}`
    : "📅 Facebook 預約未能完成";
  return [head, ...problems].join("\n").slice(0, 1500);
}
// A post is "broken" when generation failed to produce postable content. Such a post must NEVER be
// auto-approved (the 2026-06-22 incident: failed posters got 48h-approved, then the scheduler crashed
// on the missing caption). It needs regeneration, not a publish decision.
export const isBroken = (p) => p.status === "failed" || !!p.error;

function labelFor(status, by) {
  if (status === "skip") return "❌ 已 skip";
  return by === "auto" ? "✅ 自動出" : "✅ 已標記出";
}
export function decidePost(post, status, nowMs, by) {
  post.status = status;
  post.review = post.review || {};
  post.review.decidedAt = nowMs;
  post.review.decidedBy = by;
  return labelFor(status, by);
}
export const decidedCaption = (post) =>
  `${postLabel(post)}\n${labelFor(post.status, post.review?.decidedBy)}`;

export function remainingLabel(autoApproveAtMs, nowMs) {
  let s = Math.max(0, Math.floor((autoApproveAtMs - nowMs) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `仲有 ~${d} 日 ${h} 鐘`;
  if (h > 0) return `仲有 ~${h} 鐘`;
  return `仲有 ~${m} 分鐘`;
}

export function buildDigest(posts, nowMs, { autoApprove = false } = {}) {
  if (!autoApprove) {
    const lines = posts.map((p) => `• ${postLabel(p)}${p.date ? ` — ${p.date} 發佈` : ""}`);
    return `⚠️ 仍有 ${posts.length} 篇未決定（未批准的帖文不會發佈）：\n${lines.join("\n")}`;
  }
  const lines = posts.map((p) =>
    `• ${postLabel(p)} — ${remainingLabel(nowMs + reviewRemainingMs(p), nowMs)}`);
  return `⚠️ 仲有 ${posts.length} 篇未決定：\n${lines.join("\n")}`;
}

export function reviewRemainingMs(post) {
  const observed = Number(post?.review?.observedLiveMs);
  return Math.max(0, AUTO_APPROVE_MS - (Number.isFinite(observed) ? observed : 0));
}

function creditObservedLiveness(review, liveness) {
  const observedAtMs = liveness?.observedAtMs;
  const maxGapMs = liveness?.maxGapMs;
  if (!Number.isFinite(review.observedLiveMs)) {
    review.observedLiveMs = 0;
    review.livenessUnknown = true; // legacy record: no historical poll evidence exists
  }
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(maxGapMs) || maxGapMs <= 0) return false;
  if (!Number.isFinite(review.lastObservedPollAt)) {
    // One successful poll proves only that instant, not the time since the post was sent.
    // Establish a baseline and wait for the next bounded successful poll before crediting time.
    if (!Number.isFinite(review.sentAt) || observedAtMs - review.sentAt > maxGapMs) {
      review.livenessUnknown = true;
    }
    review.lastObservedPollAt = observedAtMs;
    return true;
  }

  const delta = observedAtMs - review.lastObservedPollAt;
  if (delta < 0) {
    review.livenessUnknown = true;
    return false;
  }
  if (delta <= maxGapMs) {
    review.observedLiveMs = Math.min(AUTO_APPROVE_MS, review.observedLiveMs + delta);
  } else {
    // The bot may have been unable to receive replies anywhere in this gap. Credit none of it.
    review.livenessUnknown = true;
  }
  review.lastObservedPollAt = observedAtMs;
  return true;
}

// Instant of today's DIGEST_HOUR:00 HK, for the HK calendar day containing nowMs.
function hkDayGateMs(nowMs) {
  const shifted = nowMs + HK;
  const dayStart = Math.floor(shifted / DAY) * DAY;
  return dayStart + DIGEST_HOUR * HOUR - HK;
}
export function digestDue(lastDigestAtMs, nowMs) {
  const gate = hkDayGateMs(nowMs);
  return nowMs >= gate && (lastDigestAtMs == null || lastDigestAtMs < gate);
}

export function planSweep(week, nowMs, { liveness, autoApprove = false } = {}) {
  const autoApproved = [], lastCalls = [], broken = [], livenessBlocked = [];
  for (const post of week.posts || []) {
    if (!post.review || post.review.sentAt == null || isDecided(post)) continue;
    if (isBroken(post)) { broken.push(post); continue; } // surface for a regen alert; never auto-approve
    if (!autoApprove) {
      // MANUAL APPROVAL (the default): no timer ever approves a post. One reminder goes out when an
      // undecided post is inside REMINDER_HOURS of its publish time; a post nobody approves never publishes.
      const leftMs = publishAtMs(post) - nowMs;
      if (!post.review.lastCallSent && leftMs > 0 && leftMs <= REMINDER_HOURS * HOUR) {
        post.review.lastCallSent = true;
        lastCalls.push(post);
      }
      continue;
    }
    const hasCurrentObservation = creditObservedLiveness(post.review, liveness);
    const remainingMs = reviewRemainingMs(post);
    if (remainingMs === 0) {
      decidePost(post, "approved", nowMs, "auto");
      autoApproved.push(post);
    } else if (
      nowMs >= post.review.autoApproveAt &&
      (!hasCurrentObservation || post.review.livenessUnknown)
    ) {
      // Wall time elapsed, but the bot's ability to receive owner replies was not established for
      // the whole 48 hours. Safe failure is to leave the post undecided and make the gap alarmable.
      livenessBlocked.push(post);
    } else if (!post.review.lastCallSent && remainingMs <= LAST_CALL_HOURS * HOUR) {
      post.review.lastCallSent = true;
      lastCalls.push(post);
    }
  }
  // Undecided = awaiting the owner's decision. Broken posts aren't awaiting a decision (they need
  // regen), so they're excluded from the digest.
  const undecided = (week.posts || []).filter((p) => p.review?.sentAt != null && isUndecided(p) && !isBroken(p));
  let digest = null;
  if (undecided.length && digestDue(week.lastDigestAt ?? null, nowMs)) {
    digest = buildDigest(undecided, nowMs, { autoApprove });
    week.lastDigestAt = nowMs;
  }
  return { week, autoApproved, lastCalls, digest, broken, livenessBlocked };
}
