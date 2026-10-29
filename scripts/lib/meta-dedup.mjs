export class RemoteDedupUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RemoteDedupUnavailableError";
    this.kind = "remote_dedup_unavailable";
  }
}

// Exported 2026-08-04 so meta-publication.mjs can reuse this exact discipline rather than write a
// second, weaker Graph reader. The load-bearing property is that EVERY failure mode — transport,
// non-JSON, HTTP error, Graph error body, missing data array — throws RemoteDedupUnavailableError.
// Nothing here can return an empty array for a read that did not actually succeed, which is what
// makes "Meta says it is not there" distinguishable from "we could not ask Meta".
export async function loadEdge({ fetchImpl, url, edge, timeoutMs }) {
  let response;
  try {
    response = await fetchWithDeadline(url, {}, {
      fetchImpl,
      timeoutMs,
      label: `Meta ${edge} dedup read`,
    });
  } catch (cause) {
    throw new RemoteDedupUnavailableError(`Meta ${edge} dedup read failed: ${cause?.message || cause}`, { cause });
  }
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new RemoteDedupUnavailableError(`Meta ${edge} dedup response was not JSON`, { cause });
  }
  if (!response.ok || body?.error) {
    throw new RemoteDedupUnavailableError(
      `Meta ${edge} dedup rejected: ${body?.error?.message || `HTTP ${response.status}`}`,
    );
  }
  if (!Array.isArray(body?.data)) {
    throw new RemoteDedupUnavailableError(`Meta ${edge} dedup response has no data array`);
  }
  return body.data;
}

export async function fetchFacebookInventory({
  pageId,
  token,
  graphBase = "https://graph.facebook.com/v21.0",
  fetchImpl = globalThis.fetch,
  timeoutMs = PUBLISH_HTTP_TIMEOUT_MS,
} = {}) {
  if (!pageId || !token) throw new RemoteDedupUnavailableError("Meta dedup requires pageId and token");
  const access = encodeURIComponent(token);
  const published = await loadEdge({
    fetchImpl,
    timeoutMs,
    edge: "published_posts",
    url: `${graphBase}/${pageId}/published_posts?fields=message,created_time&limit=50&access_token=${access}`,
  });
  const scheduled = await loadEdge({
    fetchImpl,
    timeoutMs,
    edge: "scheduled_posts",
    url: `${graphBase}/${pageId}/scheduled_posts?fields=message,scheduled_publish_time&limit=50&access_token=${access}`,
  });
  return { published, scheduled };
}

export function facebookDedupFacts({ published, scheduled, normalize }) {
  if (typeof normalize !== "function") throw new TypeError("normalize is required");
  const hkDate = (seconds) => new Date((Number(seconds) + 8 * 3600) * 1000).toISOString().slice(0, 10);
  const existingNorm = [...published, ...scheduled].map((item) => normalize(item.message)).join("|");
  const occupiedDates = new Set([
    ...scheduled.map((item) => item.scheduled_publish_time ? hkDate(item.scheduled_publish_time) : null),
    ...published.map((item) => item.created_time ? hkDate(Date.parse(item.created_time) / 1000) : null),
  ].filter(Boolean));
  return { existingNorm, occupiedDates };
}
import { fetchWithDeadline, PUBLISH_HTTP_TIMEOUT_MS } from "./http-deadline.mjs";
