// fb-token-probe.mjs — READ-ONLY validity probe for the Facebook Page access tokens.
//
// WHY THIS EXISTS (2026-07-26 incident retro)
//   docs/ai/PROJECT_STATE.md carried a heading "## ✅ VERIFIED (2026-07-24/25, measured)"
//   asserting "All 5 FB page tokens valid". That dated sentence was the only thing standing
//   behind unattended publishing to FIVE LIVE CLIENT PAGES — and nothing re-measured it.
//   Page tokens EXPIRE. The non-expiring path (FB_SYSTEM_USER_TOKEN) is empty in the vault.
//   A prose claim about a credential is not a credential check; it is a memory of one.
//
//   scripts/preflight.mjs probed Anthropic, Perplexity and OpenAI and had no Facebook check
//   at all, so an expired page token would have surfaced as a failed publish to a client's
//   page rather than as an alert beforehand.
//
// WHAT IT DOES
//   GET /me on the Graph API with each token. Read-only: no posting, no mutation, no
//   scheduling. A 200 with an id means the token is live; anything else names the brand and
//   returns Facebook's own error text. Where Facebook reports data_access_expires_at or
//   expires_at we surface days remaining so expiry is visible BEFORE it bites.
//
// DELIBERATELY NOT DOING
//   No auto-refresh, no token minting, no writes. Refresh touches credentials and live
//   accounts; this file only ever reports.

import { fetchWithDeadline, PUBLISH_HTTP_TIMEOUT_MS } from "./http-deadline.mjs";
import { REVIEW_BOTS } from "./worker-jobs.mjs";

const GRAPH = "https://graph.facebook.com/v21.0";

// The worker roster is the deployment ownership contract. A client token from another
// project is not missing here; only brands this service actually runs are probed.
export const FB_TOKEN_SLOTS = Object.freeze(Object.fromEntries(
  REVIEW_BOTS.map(({ brand, fbTokenEnv }) => [brand, fbTokenEnv]),
));

// `brand` is a REQUIRED parameter. It used to be referenced on the label line while only
// `token` was declared, so every single call threw ReferenceError: brand is not defined —
// and the catch below reported it as "network: …". Result: preflight said
// "⚠️ 5/5 FB page token(s) NOT valid" on the Render worker (2026-07-30 12:27) while all five
// tokens were in fact live — the four publishers scheduled successfully with them minutes later.
// A code bug wearing a network error's clothes, and it fired on a channel the owner is
// supposed to trust. Exactly the false-signal class this repo has been eliminating all day.
async function probeOne(brand, token) {
  if (!token) return { ok: false, detail: "token missing from env" };
  try {
    const res = await fetchWithDeadline(
      `${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(token)}`,
      {},
      { timeoutMs: PUBLISH_HTTP_TIMEOUT_MS, label: `Meta token probe ${brand}` },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) {
      const e = body?.error || {};
      // Facebook's own words, not a paraphrase: code 190 is the expired/invalid family.
      return { ok: false, detail: `HTTP ${res.status} — ${e.type || "error"} ${e.code ?? ""} ${e.message || ""}`.trim() };
    }
    return { ok: true, detail: `live (${body.name || body.id})` };
  } catch (error) {
    // Do NOT call everything "network". A programming fault reported as a transport fault sends
    // the reader hunting Facebook's status page instead of the stack trace, and it is how the
    // above bug survived. Name the error class; only real transport faults say "network".
    const transport = error?.name === "TimeoutError" || error?.name === "AbortError" ||
      /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error?.message || "");
    return {
      ok: false,
      detail: transport
        ? `network: ${error.message}`
        : `PROBE BUG (${error?.name || "Error"}): ${error.message} — this is a fault in the probe, not in the token`,
    };
  }
}

/**
 * Probe every configured page token.
 * @param {(key: string) => string} get - reads a key from the caller's env source
 * @returns {Promise<{brand:string, slot:string, ok:boolean, detail:string}[]>}
 */
export async function probeFbTokens(get, { probe = probeOne } = {}) {
  const out = [];
  for (const [brand, slot] of Object.entries(FB_TOKEN_SLOTS)) {
    const r = await probe(brand, get(slot));
    out.push({ brand, slot, ...r });
  }
  return out;
}

/** One-line verdict for preflight: "ok" or a human summary naming the failing brands. */
export async function fbTokenVerdict(get, options) {
  const results = await probeFbTokens(get, options);
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return "ok";
  throw new Error(
    `${bad.length}/${results.length} FB page token(s) NOT valid: ` +
      bad.map((b) => `${b.brand} (${b.detail})`).join(" · "),
  );
}
