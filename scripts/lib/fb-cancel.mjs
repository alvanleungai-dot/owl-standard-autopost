// lib/fb-cancel.mjs — take back a Facebook booking the owner no longer wants.
//
// WHY (2026-09-18 review): approval books a post on Facebook straight away, but pressing ❌ or 🔁
// afterwards only changed the local record — the booked post still went live at 10:00, and its
// confirmed publish-ledger slot then blocked the redone version from ever being booked.
//
// Cancels ONLY a post that has not gone live yet. Deleting content that is already public is the
// owner's call, made on Facebook itself — this never does it.
import { fetchWithDeadline, PUBLISH_HTTP_TIMEOUT_MS } from "./http-deadline.mjs";
import { forceReleaseSlot } from "./publish-ledger.mjs";

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Delete a scheduled Facebook post and free its ledger slot so it can be booked again after a new
 * approval. On success `post.fbPostId` is removed (the caller saves the week). Returns { ok, reason }.
 */
export async function cancelFacebookBooking({
  post,
  token,
  brand = "owl-standard",
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  release = forceReleaseSlot,
}) {
  if (!post?.fbPostId) return { ok: true, reason: "not booked" };
  const publishAt = Date.parse(`${post.date}T10:00:00+08:00`);
  if (!(publishAt > nowMs)) return { ok: false, reason: "已於 Facebook 發佈，請直接在 Facebook 處理" };
  if (!token) return { ok: false, reason: "FB_PAGE_TOKEN_OWLSTANDARD 未設定" };
  try {
    const res = await fetchWithDeadline(
      `${GRAPH}/${encodeURIComponent(post.fbPostId)}?access_token=${encodeURIComponent(token)}`,
      { method: "DELETE" },
      { fetchImpl, timeoutMs: PUBLISH_HTTP_TIMEOUT_MS, label: `Meta cancel ${post.slug}` },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error || body?.success === false) {
      return { ok: false, reason: body?.error?.message || `HTTP ${res.status}` };
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 160) };
  }
  release({ brand, slug: post.slug, channel: "fb", planned_date: post.date });
  delete post.fbPostId;
  return { ok: true, reason: "cancelled" };
}
