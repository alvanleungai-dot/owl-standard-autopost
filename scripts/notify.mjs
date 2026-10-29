// notify.mjs — send a Telegram message to the owner (alerts + confirmations).
// Reads TELEGRAM_BOT_TOKEN + chat id from .env. Usage: node scripts/notify.mjs "message text"
import { getEnv } from "./lib/env.mjs";

const token = getEnv("TELEGRAM_BOT_TOKEN_OWLSTANDARD");
const chat = getEnv("TELEGRAM_CHAT_ID") || getEnv("TELEGRAM_OWNER_CHAT_ID");
const text = process.argv.slice(2).join(" ") || "Better Life automation — test ✅";

if (!token || !chat) { console.log("Missing TELEGRAM_BOT_TOKEN or chat id in .env"); process.exit(1); }

const r = await (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: chat, text }),
})).json();

console.log(r.ok ? `Sent ✅ to chat ${chat}` : `FAILED: ${JSON.stringify(r)}`);
if (!r.ok) process.exitCode = 1;
