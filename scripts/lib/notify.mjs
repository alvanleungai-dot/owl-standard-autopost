// lib/notify.mjs — Telegram sender as an importable function (mirrors scripts/notify.mjs CLI).
// notify(text) sends a message to the owner; tg(method, body) is the raw Bot API helper.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getEnv } from "./env.mjs";
import { telegramRequest } from "./telegram-http.mjs";

// NO FALLBACK. `|| get("TELEGRAM_BOT_TOKEN")` used to route Better Life's review
// stream through the shared ops bot whenever the brand token was absent — one
// client's approval requests appearing in another channel, silently, exactly the
// borrowing CLAUDE.md forbids ("per-brand review bot; never borrow another
// brand's"). scripts/tml/notify.mjs already had this right. A missing brand token
// is a configuration error and must fail loudly, not quietly reroute.
export const TG_TOKEN = getEnv("TELEGRAM_BOT_TOKEN_OWLSTANDARD");
export const TG_CHAT = getEnv("TELEGRAM_CHAT_ID") || getEnv("TELEGRAM_OWNER_CHAT_ID");

export async function tg(method, body, options = {}) {
  if (!TG_TOKEN) throw new Error("no TELEGRAM_BOT_TOKEN_OWLSTANDARD configured");
  return telegramRequest({ token: TG_TOKEN, method, body, ...options });
}

// Best-effort owner alert. Never throws (a failed notify must not crash a posting run).
export async function notify(text, replyMarkup = null) {
  try {
    if (!TG_TOKEN || !TG_CHAT) { console.log("notify skipped (no telegram creds)"); return false; }
    const body = { chat_id: TG_CHAT, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const r = await tg("sendMessage", body);
    if (!r.ok) console.log(`notify failed: ${JSON.stringify(r).slice(0, 200)}`);
    return !!r.ok;
  } catch (e) {
    console.log(`notify error: ${e.message}`);
    return false;
  }
}

export async function notifyPhoto(photoPath, caption = "", replyMarkup = null) {
  try {
    if (!TG_TOKEN || !TG_CHAT) return false;
    const form = new FormData();
    form.append("chat_id", String(TG_CHAT));
    if (caption) form.append("caption", caption.slice(0, 1000));
    if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
    form.append("photo", new Blob([readFileSync(photoPath)], { type: "image/png" }), basename(photoPath));
    const j = await telegramRequest({ token: TG_TOKEN, method: "sendPhoto", body: form, form: true });
    if (!j.ok) console.log(`notifyPhoto failed: ${JSON.stringify(j).slice(0, 200)}`);
    return !!j.ok;
  } catch (e) { console.log(`notifyPhoto error: ${e.message}`); return false; }
}
