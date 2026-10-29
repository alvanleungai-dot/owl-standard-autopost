// scripts/lib/deliver-monthly.mjs — the ONE place a brand's monthly batch is actually sent.
//
// Each of the four review bots calls this from its own sweep, with its OWN notifyPhoto and keyboard.
// That is not an accident of refactoring: the approve buttons only function on the bot that owns
// them, and CLAUDE.md forbids one brand's posts going out through another brand's bot. So the
// DECISION is shared and the TRANSPORT stays per-brand.
//
// Ordering rule that makes this safe: a post is stamped "shown" only after Telegram has ACCEPTED it.
// Stamping first would start the 48-hour auto-approve clock on a poster the owner never received,
// and it would publish itself unseen — the exact failure the review mechanism exists to prevent.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runtimePath, ensureStateParent } from "./paths.mjs";
import { stampReview } from "./review-core.mjs";
import { autoApproveEnabled, sweepPendingDeliveries } from "./review-weeks.mjs";
import { batchHeader } from "./monthly-review.mjs";
import { escalate } from "./alert.mjs";

export const stateFile = (brand) => runtimePath("secrets", `review-delivery-${brand}.json`);

// A batch that cannot be delivered is almost never a transient. Measured 2026-08-04, first live run:
// Bright Day's bot returned `chat not found` on every attempt — the owner has never pressed START on
// it, so it CANNOT message him, ever, and no amount of retrying changes that. The sweep runs about
// once a minute, so the first version of this file re-sent the same five posters every 60 seconds.
//
// That is the rule this very session wrote into the retro — "never retry a deterministic failure; a
// repair loop without a convergence check burns money and hides the cause" — broken by the code that
// wrote it. Bound it, then say so ONCE through a channel known to work.
export const MAX_DELIVERY_ATTEMPTS = 3;
// ...and then SLOW DOWN rather than stop forever.
//
// The first version stopped dead once the budget was spent, which recreated the disease this whole
// session is about: it told the owner what to fix, he fixed it, and nothing ever tried again. He
// pressed START on the Bright Day bot minutes after the escalation and the batch stayed stuck,
// because "gave up" was permanent for the calendar month.
//
// A bounded retry should bound the RATE, not the possibility. Three quick attempts catch a blip;
// after that it re-tries hourly, so a channel a human repairs comes back on its own within the hour
// with nothing further to do. That is the difference between "it told us" and "it fixed itself".
export const RETRY_BACKOFF_MS = 60 * 60 * 1000;

export function readDeliveryState(brand, { read = readFileSync, exists = existsSync } = {}) {
  try {
    const path = stateFile(brand);
    if (!exists(path)) return { lastDeliveredMonth: null, failedMonth: null, attempts: 0, lastAttemptAt: null };
    const parsed = JSON.parse(read(path, "utf8"));
    return {
      lastDeliveredMonth: parsed.lastDeliveredMonth ?? null,
      failedMonth: parsed.failedMonth ?? null,
      attempts: Number(parsed.attempts) || 0,
      lastAttemptAt: Number(parsed.lastAttemptAt) || null,
    };
  } catch { return { lastDeliveredMonth: null, failedMonth: null, attempts: 0, lastAttemptAt: null }; }
}

export function writeDeliveryState(brand, state, { write = writeFileSync } = {}) {
  try { write(ensureStateParent(stateFile(brand)), `${JSON.stringify(state, null, 2)}\n`, "utf8"); }
  catch {}
}

export function readLastDeliveredMonth(brand, deps) {
  return readDeliveryState(brand, deps).lastDeliveredMonth;
}

export function writeLastDeliveredMonth(brand, month, deps) {
  writeDeliveryState(brand, { lastDeliveredMonth: month, failedMonth: null, attempts: 0 }, deps);
}

/**
 * PURE. Should we try this month's batch now?
 * Fast attempts first, then hourly forever — never a permanent stop.
 */
export function shouldAttemptDelivery({
  month, failedMonth, attempts, lastAttemptAt, nowMs = Date.now(),
  max = MAX_DELIVERY_ATTEMPTS, backoffMs = RETRY_BACKOFF_MS,
}) {
  if (failedMonth !== month) return true;              // a new month always gets a fresh budget
  if ((Number(attempts) || 0) < max) return true;      // still inside the fast budget
  // Budget spent: back off to hourly rather than stopping. A missing/garbled timestamp means we
  // cannot prove we are inside the backoff window, so it retries — the safe direction here is to
  // try again, not to stay silent. (It is also what lets an OLD state file, written before this
  // field existed, resume immediately on deploy.)
  const since = Number(lastAttemptAt);
  if (!Number.isFinite(since)) return true;
  return nowMs - since >= backoffMs;
}

/**
 * Deliver whatever is due for this brand right now.
 *
 * @returns {{sent: string[], failed: string[], monthlyBatch: boolean, month: string, reason: string}}
 */
export async function deliverDueReviews({
  brand,
  brandLabel,
  nowMs = Date.now(),
  notifyPhoto,
  photoPath,
  caption,
  keyboard,
  reply,
  signal,
  sweep = sweepPendingDeliveries,
  readState = readDeliveryState,
  writeState = writeDeliveryState,
  writeMonth = writeLastDeliveredMonth,
  alert = escalate,
  stamp = stampReview,
  log = console.log,
} = {}) {
  const prior = readState(brand);
  const plan = sweep({ brand, nowMs, lastDeliveredMonth: prior.lastDeliveredMonth });
  if (!plan.deliver.length) {
    // Record the month even when the batch is EMPTY, or every sweep for the rest of the month keeps
    // re-deciding it is batch day and re-sending the header the moment one post appears.
    if (plan.monthlyBatch) writeMonth(brand, plan.month);
    return { sent: [], failed: [], monthlyBatch: plan.monthlyBatch, month: plan.month, reason: plan.reason };
  }

  if (!shouldAttemptDelivery({
    month: plan.month, failedMonth: prior.failedMonth, attempts: prior.attempts,
    lastAttemptAt: prior.lastAttemptAt, nowMs,
  })) {
    return {
      sent: [], failed: [], monthlyBatch: plan.monthlyBatch, month: plan.month,
      reason: `delivery gave up after ${prior.attempts} attempt(s) this month — waiting for a person`,
      exhausted: true,
    };
  }

  log(`${brand}: delivering ${plan.deliver.length} post(s) — ${plan.reason}`);
  const ordered = [...plan.deliver].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (plan.monthlyBatch && typeof reply === "function") {
    try {
      await reply(batchHeader(brandLabel || brand, plan.month, ordered.length, { autoApprove: autoApproveEnabled() }), undefined, { signal });
    } catch {}
  }

  const sent = [];
  const failed = [];
  for (const post of ordered) {
    let ok = false;
    try { ok = await notifyPhoto(photoPath(post), caption(post), keyboard(post.slug)); }
    catch { ok = false; }
    if (ok) { stamp(post, nowMs); sent.push(post.slug); }   // stamp ONLY after Telegram accepted it
    else failed.push(post.slug);
  }

  plan.save();

  if (!failed.length) {
    // Clean batch: close the month and clear any failure budget.
    if (plan.monthlyBatch) writeMonth(brand, plan.month);
    else writeState(brand, { ...prior, failedMonth: null, attempts: 0 });
    return { sent, failed, monthlyBatch: plan.monthlyBatch, month: plan.month, reason: plan.reason };
  }

  // Something did not land. Spend one attempt from the budget rather than retrying forever; the
  // month stays OPEN so a genuinely transient failure still gets its remaining tries.
  const attempts = (prior.failedMonth === plan.month ? prior.attempts : 0) + 1;
  writeState(brand, { lastDeliveredMonth: prior.lastDeliveredMonth, failedMonth: plan.month, attempts, lastAttemptAt: nowMs });
  log(`${brand}: ${failed.length} delivery failure(s), attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}`);

  if (attempts === MAX_DELIVERY_ATTEMPTS) {
    // Tell him through a channel PROVEN to work — the ops bot — because the brand's own bot is
    // precisely what is broken. Escalate screens by kind, so this is one message, not a stream.
    await alert({
      source: "review-delivery",
      kind: `undeliverable:${brand}:${plan.month}`,
      severity: "crucial",
      text:
        `🔴 ${brandLabel || brand} 嘅 ${plan.month} 內容送唔到你部電話（試咗 ${attempts} 次）。\n` +
        `未送出：${failed.join(", ")}\n\n` +
        "最常見原因：你未撳過嗰個 bot 嘅 START，所以佢冇權主動搵你。開 Telegram 搵返嗰個 bot、撳 START 就得。",
    });
  }

  return { sent, failed, monthlyBatch: plan.monthlyBatch, month: plan.month, reason: plan.reason, attempts };
}
