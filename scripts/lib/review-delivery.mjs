// review-delivery.mjs — deliver posters to a brand's review bot.
//
// WEEKLY DELIVERY IS OFF BY DEFAULT (2026-08-04, owner-directed).
//   The four weekly-run scripts call this the moment they generate, which meant a Telegram batch
//   every Thursday, per brand — roughly 200 review messages a year for an owner whose stated goal
//   is "hands-off". He expects a monthly batch on the 1st, so delivery moved to
//   lib/deliver-monthly.mjs, driven by the always-running review bots.
//
//   This function is NOT deleted, and the switch is an env var rather than a code removal, because
//   the monthly path is new and the cost of it being wrong is an unseen post reaching a client's
//   page. Set REVIEW_DELIVERY_MODE=weekly to put it straight back.
//
//   Nothing about generation, auto-approval or publishing changed — only WHEN he is shown things.
import { escalate } from "./alert.mjs";
import { stampReview } from "./review-core.mjs";
import { getEnv } from "./env.mjs";

/** "monthly" (default) or "weekly". Read at call time so a deploy can flip it without a code change. */
export function reviewDeliveryMode(get = getEnv) {
  return get("REVIEW_DELIVERY_MODE").trim().toLowerCase() === "weekly" ? "weekly" : "monthly";
}

/** True when generation should deliver immediately (the old behaviour). */
export function weeklyDeliveryEnabled(get = getEnv) {
  return reviewDeliveryMode(get) === "weekly";
}

export async function deliverReviewPhotos({
  brand,
  posts,
  notifyPhoto,
  photoPath,
  caption,
  keyboard,
  now = Date.now(),
  stamp = stampReview,
  alert = escalate,
  enabled = weeklyDeliveryEnabled,
}) {
  // Monthly mode: say nothing and send nothing. The posts stay unstamped, which is exactly what the
  // monthly deliverer looks for — "never shown" is how it finds them.
  if (!enabled()) {
    (globalThis.console ?? { log() {} }).log(
      `${brand}: weekly delivery is off (REVIEW_DELIVERY_MODE=monthly) — ${posts.length} post(s) will go out in the monthly batch`,
    );
    return [];
  }
  const failedSlugs = [];
  for (const post of posts) {
    const delivered = await notifyPhoto(
      photoPath(post),
      caption(post),
      keyboard(post.slug),
    );
    if (delivered) stamp(post, now);
    else failedSlugs.push(post.slug);
  }

  if (failedSlugs.length) {
    await alert({
      source: "weekly-review",
      kind: `delivery-failed:${brand}:${failedSlugs.join(",")}`,
      severity: "crucial",
      text:
        `Review delivery failed for ${brand}: ${failedSlugs.join(", ")}. ` +
        "The review clock was not started for these posts.",
    });
  }
  return failedSlugs;
}
