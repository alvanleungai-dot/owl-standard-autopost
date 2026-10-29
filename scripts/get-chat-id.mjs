// get-chat-id.mjs — find your Telegram bot's @username and any chat IDs that have messaged it.
// 1) run it → see the bot username. 2) message that bot in Telegram. 3) run it again → see your chat_id.
import { getEnv } from "./lib/env.mjs";

let token = getEnv("TELEGRAM_BOT_TOKEN_OWLSTANDARD") || getEnv("TELEGRAM_BOT_TOKEN");
if (!token) { console.log("No TELEGRAM_BOT_TOKEN in .env"); process.exit(1); }

const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
if (!me.ok) { console.log("Bot token invalid:", JSON.stringify(me)); process.exit(1); }
console.log(`BOT: @${me.result.username}  (name: ${me.result.first_name})`);
console.log(`→ Open Telegram, search @${me.result.username}, tap START, send any message.\n`);

const up = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
const chats = new Map();
if (up.ok) for (const u of up.result) {
  const c = u.message?.chat || u.edited_message?.chat || u.channel_post?.chat;
  if (c) chats.set(c.id, c);
}
if (chats.size) {
  console.log("Chats that have messaged this bot:");
  for (const [id, c] of chats) console.log(`  TELEGRAM_CHAT_ID=${id}   (${c.first_name || c.title || ""} ${c.username ? "@" + c.username : ""})`);
} else {
  console.log("No messages to the bot yet — message it in Telegram, then run this again.");
}
