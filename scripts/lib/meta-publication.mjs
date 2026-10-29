// scripts/lib/meta-publication.mjs — ask Meta the ONE question the publish ledger cannot answer
// itself: "did this post actually go out?"
//
// WHY THIS EXISTS (2026-08-04)
//   publish-ledger.mjs blocks a slot the moment a publish attempt ends ambiguously, and its reaper
//   is deliberately alert-only:
//
//     "An uncertain record may mean Meta accepted the publish before the process died, so automatic
//      release would recreate the double-post window."
//
//   That reasoning is correct and must not be weakened. But it was only ever half an argument. The
//   uncertainty is not irreducible — Meta knows the answer. Nobody was asking. So five slots sat
//   blocked for days, every daily IG run exited 3, and the owner was the only mechanism that could
//   ever clear them. This module is the missing question.
//
// THE SAFETY HEART — read this before changing anything here
//   Callers are allowed to RELEASE a blocked slot only on `absent`, and `absent` is deliberately
//   expensive to earn. It requires that we walked the media list back PAST the start of the window
//   in which the publish could have happened, with every page loading cleanly. If pagination ran out
//   first, if any read failed, if the caption is too short to identify a post — the verdict is
//   `undetermined`, never `absent`. Absence of evidence is not evidence of absence, and here the
//   difference between those two is a duplicate post on a client's live account.
//
//   Everything in this file is READ-ONLY. No posting, no mutation, no scheduling. It reports.

import { fetchWithDeadline, PUBLISH_HTTP_TIMEOUT_MS } from "./http-deadline.mjs";
import { loadEdge, RemoteDedupUnavailableError } from "./meta-dedup.mjs";

export const GRAPH_BASE = "https://graph.facebook.com/v21.0";

// How far around the publish attempt we look. The anchor is when the claim was written, because that
// is within seconds of when the publish call was made — a far tighter and more honest window than the
// post's planned date, which can be days from the attempt when catch-up runs late.
export const LOOKBACK_BEFORE_MS = 60 * 60 * 1000;        // 1 hour before the attempt
export const LOOKAHEAD_AFTER_MS = 24 * 60 * 60 * 1000;   // 24 hours after it
// Bounded pagination. Hitting this bound WITHOUT reaching the window start yields `undetermined`.
export const MAX_MEDIA_PAGES = 10;
export const MEDIA_PAGE_SIZE = 50;
// A caption shorter than this cannot identify a post, so it can neither confirm nor refute one.
export const MIN_IDENTIFYING_CAPTION_CHARS = 12;

/**
 * Normalise a caption for comparison. Whitespace, zero-width characters and case vary between what
 * we send and what Meta echoes back; the words do not. Emoji and CJK are preserved — they carry the
 * most identifying signal in these captions.
 */
export function normalizeCaption(text) {
  return String(text ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")   // escapes, not literals: invisible chars are unreviewable
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** Comparable fingerprint: the leading N normalised characters. */
export function captionFingerprint(text, length = 60) {
  return normalizeCaption(text).slice(0, length);
}

export function captionIsIdentifying(text) {
  return normalizeCaption(text).length >= MIN_IDENTIFYING_CAPTION_CHARS;
}

/**
 * The window in which a publish for this ledger record could have landed.
 * Anchored on the claim/uncertainty timestamp; falls back to the planned date only when neither
 * is parseable, and says so, so the caller can weigh a wider window accordingly.
 */
export function attemptWindow(record, {
  beforeMs = LOOKBACK_BEFORE_MS,
  afterMs = LOOKAHEAD_AFTER_MS,
} = {}) {
  const anchorSource = record?.uncertain_at || record?.claimed_at || null;
  const anchored = Date.parse(anchorSource || "");
  if (Number.isFinite(anchored)) {
    return { startMs: anchored - beforeMs, endMs: anchored + afterMs, anchor: "claim", anchorSource };
  }
  const planned = Date.parse(`${record?.planned_date}T00:00:00+08:00`);
  if (Number.isFinite(planned)) {
    return { startMs: planned - beforeMs, endMs: planned + afterMs, anchor: "planned_date", anchorSource: record?.planned_date };
  }
  return null;
}

/**
 * Derive the Instagram business account id from the page token itself.
 * Never assert an id from config: companies/<brand>/company.md holds PROFILE-URL ids for three of
 * the four brands, and a Graph call against those returns "(#100) nonexisting field". The token
 * knows which page it is for; the page knows which IG account it owns.
 */
export async function deriveInstagramAccount({
  token,
  graphBase = GRAPH_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = PUBLISH_HTTP_TIMEOUT_MS,
} = {}) {
  if (!token) throw new RemoteDedupUnavailableError("Instagram identity lookup requires a page token");
  const access = encodeURIComponent(token);
  const [me] = await loadEdgeObject({
    fetchImpl,
    timeoutMs,
    edge: "me(instagram_business_account)",
    url: `${graphBase}/me?fields=id,name,instagram_business_account{id,username}&access_token=${access}`,
  });
  const ig = me?.instagram_business_account;
  if (!ig?.id) {
    throw new RemoteDedupUnavailableError(
      `page ${me?.name || me?.id || "(unknown)"} reports no linked Instagram business account`,
    );
  }
  return { pageId: me.id, pageName: me.name, igUserId: ig.id, igUsername: ig.username };
}

// loadEdge insists on a `data` array; /me returns a bare object. Same failure discipline, one shape.
async function loadEdgeObject({ fetchImpl, url, edge, timeoutMs }) {
  let response;
  try {
    response = await fetchWithDeadline(url, {}, { fetchImpl, timeoutMs, label: `Meta ${edge} read` });
  } catch (cause) {
    throw new RemoteDedupUnavailableError(`Meta ${edge} read failed: ${cause?.message || cause}`, { cause });
  }
  let body;
  try { body = await response.json(); }
  catch (cause) { throw new RemoteDedupUnavailableError(`Meta ${edge} response was not JSON`, { cause }); }
  if (!response.ok || body?.error) {
    throw new RemoteDedupUnavailableError(
      `Meta ${edge} rejected: ${body?.error?.message || `HTTP ${response.status}`}`,
    );
  }
  return [body];
}

/**
 * Walk Instagram media newest-first until we pass `untilMs`, or until the page bound is hit.
 * Returns { media, reachedWindowStart } — and `reachedWindowStart` is the whole point: it is the
 * only thing that licenses a caller to conclude a post is genuinely absent.
 */
export async function listInstagramMediaBack({
  igUserId,
  token,
  untilMs,
  graphBase = GRAPH_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = PUBLISH_HTTP_TIMEOUT_MS,
  maxPages = MAX_MEDIA_PAGES,
  pageSize = MEDIA_PAGE_SIZE,
} = {}) {
  if (!igUserId || !token) throw new RemoteDedupUnavailableError("Instagram media read requires igUserId and token");
  const access = encodeURIComponent(token);
  let url = `${graphBase}/${igUserId}/media?fields=id,caption,timestamp,permalink&limit=${pageSize}&access_token=${access}`;
  const media = [];
  let reachedWindowStart = false;
  let pages = 0;

  while (url && pages < maxPages) {
    const batch = await loadEdgePaged({ fetchImpl, timeoutMs, edge: "instagram media", url });
    pages += 1;
    media.push(...batch.data);
    // An item older than the window start proves we have walked past it: everything relevant is now
    // in hand. So does an exhausted feed — there is nothing older to miss.
    if (batch.data.some((item) => Date.parse(item.timestamp || "") < untilMs)) reachedWindowStart = true;
    if (!batch.next) { reachedWindowStart = true; break; }
    if (reachedWindowStart) break;
    url = batch.next;
  }

  return { media, reachedWindowStart, pages };
}

async function loadEdgePaged({ fetchImpl, url, edge, timeoutMs }) {
  let response;
  try {
    response = await fetchWithDeadline(url, {}, { fetchImpl, timeoutMs, label: `Meta ${edge} read` });
  } catch (cause) {
    throw new RemoteDedupUnavailableError(`Meta ${edge} read failed: ${cause?.message || cause}`, { cause });
  }
  let body;
  try { body = await response.json(); }
  catch (cause) { throw new RemoteDedupUnavailableError(`Meta ${edge} response was not JSON`, { cause }); }
  if (!response.ok || body?.error) {
    throw new RemoteDedupUnavailableError(`Meta ${edge} rejected: ${body?.error?.message || `HTTP ${response.status}`}`);
  }
  if (!Array.isArray(body?.data)) throw new RemoteDedupUnavailableError(`Meta ${edge} response has no data array`);
  return { data: body.data, next: body?.paging?.next || null };
}

/**
 * PURE. Decide, from an already-fetched inventory, whether this post is on the account.
 *
 * Returns one of:
 *   { state: "found",        remoteId, matched }
 *   { state: "absent" }                              — only when the window was fully enumerated
 *   { state: "undetermined", reason }                — everything else, including "ran out of pages"
 *
 * This is separated from the fetching above so every branch — especially the ones that must NOT say
 * "absent" — is unit-testable without a network.
 */
export function judgePublication({
  caption,
  window: win,
  media = [],
  reachedWindowStart = false,
  fingerprintLength = 60,
} = {}) {
  if (!win) return { state: "undetermined", reason: "no usable attempt window on the ledger record" };
  if (!captionIsIdentifying(caption)) {
    return { state: "undetermined", reason: "caption too short to identify a post on the account" };
  }
  const wanted = captionFingerprint(caption, fingerprintLength);

  const inWindow = media.filter((item) => {
    const at = Date.parse(item?.timestamp || "");
    return Number.isFinite(at) && at >= win.startMs && at <= win.endMs;
  });
  const hit = inWindow.find((item) => captionFingerprint(item?.caption, fingerprintLength) === wanted);
  if (hit) return { state: "found", remoteId: hit.id, matched: { permalink: hit.permalink, timestamp: hit.timestamp } };

  // No match. That is only meaningful if we actually looked at the whole window.
  if (!reachedWindowStart) {
    return { state: "undetermined", reason: `pagination bound reached before the window start; ${media.length} item(s) seen` };
  }

  // A post we cannot account for, sitting in the exact window where our publish attempt died, is the
  // ambiguity this whole module exists to refuse. Caption matching is an identity heuristic: if the
  // caption were edited after publishing, or Meta echoed it back altered, the post would be OURS and
  // we would be about to release its slot and publish it a second time on a client's account.
  // These brands post about once a week, so an unexplained item inside a ~25-hour window is rare —
  // and when it happens, a person should look. Holding costs a delay; releasing wrongly costs a duplicate.
  if (inWindow.length > 0) {
    return {
      state: "undetermined",
      reason:
        `${inWindow.length} post(s) sit inside the attempt window but none matches this caption — ` +
        "cannot rule out that one of them IS this post under an edited caption",
    };
  }
  return { state: "absent" };
}

/**
 * PURE. Normalise Facebook's two edges into the one shape `judgePublication` reads.
 * `reachedWindowStart` is earned the same way it is for Instagram: we must be able to SEE something
 * older than the window start. fetchFacebookInventory takes a single un-paginated page of 50, so a
 * busy page whose 50 newest posts are all newer than the window yields `undetermined` — correctly.
 */
export function normalizeFacebookInventory({ published = [], scheduled = [], windowStartMs } = {}) {
  const media = [
    ...published.map((item) => ({
      id: item.id,
      caption: item.message,
      timestamp: item.created_time,
    })),
    ...scheduled.map((item) => ({
      id: item.id,
      caption: item.message,
      timestamp: Number.isFinite(Number(item.scheduled_publish_time))
        ? new Date(Number(item.scheduled_publish_time) * 1000).toISOString()
        : null,
    })),
  ];
  const reachedWindowStart = media.some((item) => {
    const at = Date.parse(item.timestamp || "");
    return Number.isFinite(at) && at < windowStartMs;
  });
  return { media, reachedWindowStart };
}

/**
 * Full read-only lookup for one Facebook slot.
 * Same contract as the Instagram path: every failure is `undetermined`, never `absent`.
 */
export async function lookupFacebookPublication({
  record,
  caption,
  token,
  deps = {},
} = {}) {
  const {
    deriveAccount = deriveInstagramAccount,   // /me also yields the page id, which is all FB needs
    fetchInventory,
    judge = judgePublication,
  } = deps;
  const win = attemptWindow(record);
  if (!win) return { state: "undetermined", reason: "ledger record has no parseable timestamp or planned date" };
  if (typeof fetchInventory !== "function") {
    return { state: "undetermined", reason: "no Facebook inventory reader was supplied" };
  }
  try {
    const account = await deriveAccount({ token });
    const inventory = await fetchInventory({ pageId: account.pageId, token });
    const { media, reachedWindowStart } = normalizeFacebookInventory({ ...inventory, windowStartMs: win.startMs });
    return { ...judge({ caption, window: win, media, reachedWindowStart }), account, window: win };
  } catch (error) {
    if (error instanceof RemoteDedupUnavailableError) return { state: "undetermined", reason: error.message, window: win };
    return {
      state: "undetermined",
      reason: `LOOKUP BUG (${error?.name || "Error"}): ${error?.message || error} — a fault in the verifier, not in the account`,
      window: win,
    };
  }
}

/**
 * Full read-only lookup for one Instagram slot: derive identity → enumerate → judge.
 * Any RemoteDedupUnavailableError becomes `undetermined`, never `absent`.
 */
export async function lookupInstagramPublication({
  record,
  caption,
  token,
  deps = {},
} = {}) {
  const {
    deriveAccount = deriveInstagramAccount,
    listMedia = listInstagramMediaBack,
    judge = judgePublication,
  } = deps;
  const win = attemptWindow(record);
  if (!win) return { state: "undetermined", reason: "ledger record has no parseable timestamp or planned date" };
  try {
    const account = await deriveAccount({ token });
    const { media, reachedWindowStart } = await listMedia({
      igUserId: account.igUserId,
      token,
      untilMs: win.startMs,
    });
    return { ...judge({ caption, window: win, media, reachedWindowStart }), account, window: win };
  } catch (error) {
    if (error instanceof RemoteDedupUnavailableError) {
      return { state: "undetermined", reason: error.message, window: win };
    }
    // A bug in this module is not a statement about the account. Name it as ours — the same lesson
    // fb-token-probe.mjs learned when a ReferenceError spent days wearing a network error's clothes.
    return {
      state: "undetermined",
      reason: `LOOKUP BUG (${error?.name || "Error"}): ${error?.message || error} — a fault in the verifier, not in the account`,
      window: win,
    };
  }
}
