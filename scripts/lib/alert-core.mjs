// scripts/lib/alert-core.mjs — pure screening logic for the alert gateway. No I/O.
// Decides whether a would-be owner alert should actually be sent, given prior state — so
// duplicate/just-seen issues never reach the owner. (The re-verify step lives in alert.mjs.)
// State shape: { [key]: { count, firstSeen, lastSent } }

export const COOLDOWN = {
  crucial: 12 * 3600_000,   // login / billing / a post that didn't go out — remind ≤ twice a day
  info: 24 * 3600_000,      // digests / FYIs — at most once a day
  noise: Infinity,          // never reaches the owner
};

export const alertKey = (source, kind) => `${source}:${kind}`;

// Returns { send, state, reason }. Sends when the key was never sent, or its cooldown has elapsed.
export function decide(state, key, severity, nowMs) {
  const cd = COOLDOWN[severity] ?? COOLDOWN.info;
  const prev = state[key] || { count: 0, firstSeen: nowMs, lastSent: 0 };
  const next = { count: prev.count + 1, firstSeen: prev.firstSeen || nowMs, lastSent: prev.lastSent || 0 };
  if (cd === Infinity) return { send: false, state: { ...state, [key]: next }, reason: "noise" };
  if (nowMs - (prev.lastSent || 0) >= cd) {
    next.lastSent = nowMs;
    return { send: true, state: { ...state, [key]: next }, reason: "send" };
  }
  return { send: false, state: { ...state, [key]: next }, reason: "cooldown" };
}

// Forget an issue once it's resolved, so its NEXT occurrence alerts immediately (no stale cooldown).
export function clearKey(state, key) {
  if (!state[key]) return state;
  const s = { ...state }; delete s[key]; return s;
}

// Drop entries untouched within maxAgeMs (keeps the state file small).
export function prune(state, nowMs, maxAgeMs = 30 * 86_400_000) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (nowMs - (v.lastSent || v.firstSeen || 0) < maxAgeMs) out[k] = v;
  }
  return out;
}
