// scripts/lib/alert.mjs — central alert GATEKEEPER. Every owner-bound alert routes through escalate(),
// which screens it so only confirmed, crucial, non-duplicate issues reach the owner:
//   1) RE-VERIFY  — if a verify() is given, re-check the problem; if it's gone, drop silently (kills transients).
//   2) DEDUPE     — same issue won't ping again within its cooldown (alert-core).
// Sends via the DEDICATED ops Telegram bot (TELEGRAM_BOT_TOKEN__OPS → owner). State: secrets/alert-state.json.
//
// WHY NOT TELEGRAM_BOT_TOKEN (fixed 2026-08-04, owner-reported)
//   This line used to read `getEnv("TELEGRAM_BOT_TOKEN")`. That token is @landlord_fbgroup_bot — a
//   CLIENT-FACING BRAND BOT belonging to the landlord project. So every ops alarm this engine
//   raises — four brands' broken-content alerts, the publish-ledger block, "Render worker job X
//   exited with code 3" — arrived in the owner's chat with the landlord bot, about businesses that
//   have nothing to do with it. He reported it as a Telegram bug; it was a borrowed identity in code.
//
//   `~/.claude/secrets/keys.env` had already stated the house rule and pre-created the slot: "one bot
//   per purpose, never shared — a borrowed bot means an ops alert and a client-facing brand share an
//   identity and a rate limit." `_ops/scripts/notify-owner.mjs` was fixed to prefer it. This module,
//   which carries EVERY safety alarm on the worker, never was.
//
//   NO FALLBACK — deliberately, and this is the same ruling scripts/lib/notify.mjs already carries
//   for the brand review bots: "A missing brand token is a configuration error and must fail loudly,
//   not quietly reroute." Silence here would be worse than an error, so the failure is made loud in
//   the right place instead: scripts/render-worker.mjs refuses to START without this token, exactly
//   as it already refuses to start without a brand's dedicated review-bot token.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { alertKey, decide, clearKey, prune } from "./alert-core.mjs";
import { runtimePath } from "./paths.mjs";
import { getEnv } from "./env.mjs";
import { telegramRequest } from "./telegram-http.mjs";

export const OPS_TOKEN_ENV = "TELEGRAM_BOT_TOKEN__OPS";

const STATE = runtimePath("secrets", "alert-state.json");
const TOKEN = getEnv(OPS_TOKEN_ENV), CHAT = getEnv("TELEGRAM_OWNER_CHAT_ID");

const load = () => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } };
const persist = (s) => { try { mkdirSync(runtimePath("secrets"), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch {} };

export function createOpsTelegramSender({
  token = TOKEN,
  chat = CHAT,
  request = telegramRequest,
  log = console.log,
} = {}) {
  return async function sendOpsTelegram(text, { signal } = {}) {
    if (!token || !chat) {
      // Name what is missing. "(no ops telegram creds)" was true for months while the real state was
      // "the dedicated ops bot exists in the vault and was never pushed to this container".
      log(`ALERT_CHANNEL_UNCONFIGURED: ${!token ? OPS_TOKEN_ENV : "TELEGRAM_OWNER_CHAT_ID"} is missing — this alarm reached nobody`);
      return false;
    }
    try {
      await request({
        token,
        method: "sendMessage",
        body: { chat_id: chat, text },
        signal,
      });
      return true;
    } catch (error) {
      log(`ops telegram alert failed: ${error.message}`);
      return false;
    }
  };
}
const tgSend = createOpsTelegramSender();

// Injectable factory keeps the production API small while letting tests prove the complete
// decision → transport → durable cooldown sequence with a fake transport and in-memory state.
export function createEscalator({
  loadState = load,
  persistState = persist,
  deliver = tgSend,
  log = console.log,
  now = Date.now,
} = {}) {
  // Returns true iff a message was actually delivered to the owner.
  return async function escalateAlert({ source, kind, severity = "crucial", text, verify, signal }) {
    const nowMs = now();
    const key = alertKey(source, kind);
    if (typeof verify === "function") {
      let stillBad = true;
      try { stillBad = !!(await verify()); } catch { stillBad = true; } // verify error → stay cautious, treat as real
      if (!stillBad) {
        persistState(prune(clearKey(loadState(), key), nowMs));
        log(`alert[${key}]: re-verify says resolved — dropped (no message).`);
        return false;
      }
    }

    const priorState = loadState();
    const { send, state } = decide(priorState, key, severity, nowMs);
    if (!send) {
      persistState(prune(state, nowMs));
      log(`alert[${key}]: screened out (cooldown/dedupe).`);
      return false;
    }

    let sent = false;
    try {
      sent = !!(await deliver(text, { signal }));
    } catch (error) {
      log(`alert[${key}]: delivery transport threw: ${error?.message || error}`);
    }
    if (sent) {
      persistState(prune(state, nowMs));
      log(`alert[${key}]: SENT to owner.`);
      return true;
    }

    // A failed attempt is not a sent alert. Do not commit decide()'s lastSent cooldown,
    // otherwise the next healthy run would suppress the alarm for twelve hours.
    persistState(prune(priorState, nowMs));
    log(`ALERT_DELIVERY_FAILED alert[${key}]: owner notification was not delivered; retry remains eligible.`);
    return false;
  };
}

export const escalate = createEscalator();

// Call when a check PASSES, so a previously-alerted issue resets (next failure alerts immediately).
export function resolve(source, kind) {
  const nowMs = Date.now();
  persist(prune(clearKey(load(), alertKey(source, kind)), nowMs));
}

// FYIs / good news that should bypass screening (rare, low-volume). Goes straight to the owner.
export async function inform(text) { return tgSend(text); }
