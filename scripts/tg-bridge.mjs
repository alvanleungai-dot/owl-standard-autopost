// tg-bridge.mjs — always-on Telegram review bridge for Owl Standard (dedicated bot).
// Review-first and MANUAL: nothing publishes until the owner taps ✅ (or `keep all`). Timed
// auto-approval exists only behind REVIEW_AUTO_APPROVE_ENABLED=true (lib/review-weeks.mjs).
// An approval immediately runs api-schedule.mjs (which books only status=approved posts) and
// reports the result here; SCE-FB-Topup re-runs it daily as the backstop.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TG_TOKEN, TG_CHAT, tg, notifyPhoto } from "./lib/notify.mjs";
import { getEnv } from "./lib/env.mjs";
import { cancelFacebookBooking } from "./lib/fb-cancel.mjs";
import { writeCaption } from "./write-caption.mjs";
import { deriveConcept, writeConceptFile } from "./derive-concept.mjs";
import { markerFor } from "./lib/caption-marker.mjs";
import {
  parseCallback, posterKeyboard, bulkKeyboard, redoPrompt, extractSlugFromPrompt,
  decidePost, decidedCaption, stampReview, postLabel, isBulkApprovable, bookingReport,
} from "./lib/review-core.mjs";
import { autoApproveEnabled, loadReviewableWeeks, sweepReviewWeeks } from "./lib/review-weeks.mjs";
import { hkTodayStr } from "./lib/watchdog-core.mjs";
import { deliverDueReviews } from "./lib/deliver-monthly.mjs";
import { escalate } from "./lib/alert.mjs";
import { activeWeekPath } from "./lib/artifacts.mjs";
import { companyStatePath, ensureStateParent, runtimePath } from "./lib/paths.mjs";
import { runTelegramReviewBot } from "./lib/review-bot-runtime.mjs";

if (process.env.SCE_IMPORT_ONLY === "1") process.exit(0);

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const weeksDir = `${companyStatePath("owl-standard", "weeks")}/`;
const genPoster = p("./gen-poster-v4.mjs");
const offsetFile = runtimePath("secrets", "owl-standard", "tg-offset.json");

const loadOffset = () => { try { return JSON.parse(readFileSync(offsetFile, "utf8")).offset || 0; } catch { return 0; } };
const saveOffset = (o) => { ensureStateParent(offsetFile); writeFileSync(offsetFile, JSON.stringify({ offset: o }), "utf8"); };

const weekOf = (slug) => slug.replace(/-\d+$/, "");          // "2026-W25-03" → "2026-W25"
const weekPathOf = (slug) => `${weeksDir}${weekOf(slug)}.json`;
const activeWeekId = () => {
  try { return basename(activeWeekPath("owl-standard"), ".json"); } catch { return null; }
};
const loadWeek = (id) => JSON.parse(readFileSync(`${weeksDir}${id}.json`, "utf8"));
const saveWeek = (id, b) => writeFileSync(`${weeksDir}${id}.json`, JSON.stringify(b, null, 2), "utf8");
const reply = (text, replyMarkup, options) => tg("sendMessage", replyMarkup ? { chat_id: TG_CHAT, text, reply_markup: replyMarkup } : { chat_id: TG_CHAT, text }, options);

const execFileP = promisify(execFile);
const apiSchedule = p("./owl-standard/api-schedule.mjs");
// Book every approved post on Facebook NOW, so an approval takes effect at once and any failure is
// seen in this chat instead of being discovered on the publish day. Awaited (seconds normally; the
// 3-minute cap stays well inside the bot's 6-minute poll watchdog).
async function bookApproved() {
  let output;
  try {
    ({ stdout: output } = await execFileP(process.execPath, [apiSchedule], { timeout: 3 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (e) {
    output = `${e.stdout || ""}\n${e.stderr || ""}`.trim() || `⛔ ${String(e.message || e)}`;
  }
  return bookingReport(output);
}

const HELP = `📋 Owl Standard 審帖

list — 列出所有待決定的帖文及狀態
keep <slug> — 批准此帖（批准後會即時預約 Facebook）
skip <slug> — 不發佈此帖（如已預約 Facebook，會一併取消）
keep all — 批准所有已送給您、仍未決定的帖文
regen <slug> <意見> — 按您的意見重做文案及海報
menu — 顯示「全部批准」按鈕

slug = 帖文編號，例如 2026-W25-01（輸入 list 即可查看）
未批准的帖文不會發佈。`;

async function cmdList() {
  // Lists EVERY reviewable week so what the owner sees matches what `keep all` would act on.
  const weeks = loadReviewableWeeks({ brand: "owl-standard", nowMs: Date.now() });
  if (!weeks.length) return reply("未有任何一星期內容。");
  const blocks = weeks.map(({ id, week }) => {
    const lines = (week.posts || []).map((x) => `${x.day || x.date || ""} ${x.slug} — ${x.status}\n   ${postLabel(x)}`);
    return `🗓️ ${id}\n${lines.join("\n")}`;
  });
  return reply(blocks.join("\n\n"));
}

async function applyDecision(slug, status, by) {
  const id = weekOf(slug);
  if (!existsSync(weekPathOf(slug))) { await reply(`找不到 ${slug}。`); return null; }
  const b = loadWeek(id);
  const post = (b.posts || []).find((x) => x.slug === slug);
  if (!post) { await reply(`找不到 ${slug}。`); return null; }
  const label = decidePost(post, status, Date.now(), by);
  saveWeek(id, b);
  // ❌ on a post that is already booked: take the Facebook booking back as well, or it still goes live.
  if (status === "skip" && post.fbPostId) {
    const cancel = await cancelFacebookBooking({ post, token: getEnv("FB_PAGE_TOKEN_OWLSTANDARD") });
    if (cancel.ok) {
      saveWeek(id, b);
      await reply(`🗑️ 已取消 ${slug} 的 Facebook 預約。`);
    } else {
      await reply(`⚠️ ${slug} 已標記為不發佈，但 Facebook 預約未能取消（${cancel.reason}）。請到 Meta Business Suite 手動刪除這篇預約帖文。`);
    }
  }
  return { post, label };
}

async function approveAll() {
  // ACROSS EVERY reviewable week, not just the active one — the active-week pointer sits on the
  // FURTHEST generated week. But only posts actually SHOWN to the owner (isBulkApprovable): a week
  // generated after the last review batch must never be approved unseen by a bulk tap.
  const weeks = loadReviewableWeeks({ brand: "owl-standard", nowMs: Date.now() });
  if (!weeks.length) { await reply("目前沒有待審的帖文。"); return; }
  const now = Date.now();
  const today = hkTodayStr(now);
  let n = 0;
  for (const { id, week } of weeks) {
    let changed = 0;
    for (const post of week.posts || []) if (isBulkApprovable(post, today)) { decidePost(post, "approved", now, "manual"); changed++; }
    if (changed) { saveWeek(id, week); n += changed; }
  }
  await reply(`✅ 已批准 ${n} 篇已送審、仍未決定的帖文。`);
  if (n) await reply(await bookApproved());
}

// One redo per post at a time: a second tap while one runs would race on the same files.
const regenInFlight = new Set();

async function cmdRegen(slug, note) {
  const id = weekOf(slug);
  if (!existsSync(weekPathOf(slug))) return reply(`找不到 ${slug}。`);
  const b = loadWeek(id);
  const post = (b.posts || []).find((x) => x.slug === slug);
  if (!post) return reply(`找不到 ${slug}。`);
  if (regenInFlight.has(slug)) return reply(`${slug} 正在重做中，完成後會把新海報送給您。`);
  if (post.fbPostId) {
    // The old version is booked: take it back first, or both versions could end up live.
    const cancel = await cancelFacebookBooking({ post, token: getEnv("FB_PAGE_TOKEN_OWLSTANDARD") });
    if (!cancel.ok) return reply(`⛔ ${slug} 已預約 Facebook，但未能取消（${cancel.reason}），因此暫不重做，以免新舊兩個版本同時發佈。`);
    saveWeek(id, b);
    await reply(`🗑️ 已取消 ${slug} 原有的 Facebook 預約。`);
  }
  regenInFlight.add(slug);
  await reply(`✏️ 收到，正在重做 ${slug}${note ? `（${note}）` : ""}。完成後會把新海報送給您批准。`);
  // In the background: a redo takes minutes (two AI calls plus an image render). Awaiting it here
  // would stall the poll loop, and a stalled loop trips the 6-minute watchdog mid-redo.
  regenerate(slug, note)
    .catch((e) => reply(`⚠️ ${slug} 重做失敗：${String(e?.message || e).slice(0, 300)}`))
    .finally(() => regenInFlight.delete(slug));
}

async function regenerate(slug, note) {
  const id = weekOf(slug);
  const source = (loadWeek(id).posts || []).find((x) => x.slug === slug);
  const topic = { title: source.title || source.headline || "", angle: source.angle || "", publishDate: source.date, note: note || "" };
  const caption = await writeCaption(topic);
  const concept = await deriveConcept(topic, caption);
  const conceptPath = writeConceptFile(slug, concept);
  // --force: the old poster exists by definition, and without it gen-poster refuses to overwrite
  // (exit 75) — which is why this button never worked before 2026-09-18.
  await execFileP(process.execPath, [genPoster, source.direction || "infographic", slug, "tl", conceptPath, "--no-report", "--force"], {
    env: { ...process.env, IMG_QUALITY: "medium" }, timeout: 8 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
  });
  // Re-read: the sweep may have saved this week while the redo was running.
  const b = loadWeek(id);
  const post = (b.posts || []).find((x) => x.slug === slug);
  post.caption = caption; post.headline = concept.headline; post.marker = markerFor(caption);
  post.poster = `companies/owl-standard/posters/${slug}.png`;
  delete post.error;
  post.status = "regenerated";
  stampReview(post, Date.now());                      // shown again, so it needs a fresh ✅
  saveWeek(id, b);
  const file = companyStatePath("owl-standard", "posters", `${slug}.png`);
  await notifyPhoto(file, `🔁 ${slug} 已重做：${concept.headline || ""}`, posterKeyboard(slug));
  await reply(post.caption);
}

async function handle(text) {
  const t = (text || "").trim();
  const [cmd, slug, ...rest] = t.split(/\s+/);
  const note = rest.join(" ");
  switch ((cmd || "").toLowerCase()) {
    case "/start": case "help": case "/help": return reply(HELP);
    case "/menu": case "menu": return reply("批次操作：", bulkKeyboard());
    case "list": return cmdList();
    case "all": case "keepall": case "approveall": return approveAll();
    case "skip": return slug ? applyDecision(slug, "skip", "manual").then((r) => r && reply(`✅ ${slug} → ${r.label}`)) : reply("用法：skip <slug>");
    case "keep": case "approve":
      if (slug === "all") return approveAll();
      if (!slug) return reply("用法：keep <slug>（或 keep all 一次過全部批准）");
      return applyDecision(slug, "approved", "manual").then(async (r) => {
        if (!r) return;
        await reply(`✅ ${slug} → ${r.label}`);
        await reply(await bookApproved());
      });
    case "regen": case "redo": return slug ? cmdRegen(slug, note) : reply("用法：regen <slug> 你嘅意見");
    default: return; // ignore non-command chatter
  }
}

async function onCallback(cq) {
  // Only the configured review chat may decide. A forwarded poster keeps its buttons, so without
  // this check anyone it was forwarded to could approve (and so publish) a post.
  if (String(cq.message?.chat?.id) !== String(TG_CHAT)) {
    try { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "此按鈕只限指定的審閱聊天室使用" }); } catch {}
    return;
  }
  if (cq.data === "keepall") {
    try { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ 全部標記出" }); } catch {}
    return approveAll();
  }
  const parsed = parseCallback(cq.data);
  const ackText = !parsed ? "?" : parsed.verb === "skip" ? "❌ 唔出咗" : parsed.verb === "regen" ? "✏️ 等緊你嘅意見" : "✅ 標記咗出";
  try { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: ackText }); } catch {}
  if (!parsed) return;
  const { verb, slug } = parsed;
  const msg = cq.message;
  if (verb === "regen") {
    const b = existsSync(weekPathOf(slug)) ? loadWeek(weekOf(slug)) : null;
    const post = b?.posts?.find((x) => x.slug === slug);
    return reply(redoPrompt(slug, postLabel(post || { slug })), { force_reply: true });
  }
  const res = await applyDecision(slug, verb === "skip" ? "skip" : "approved", "manual");
  if (res && msg) {
    try {
      await tg("editMessageCaption", { chat_id: msg.chat.id, message_id: msg.message_id, caption: decidedCaption(res.post) });
      await tg("editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
    } catch {}
  }
  if (res?.post.status === "approved") await reply(await bookApproved());
}

async function onMessage(m) {
  if (!m || String(m.chat?.id) !== String(TG_CHAT) || !m.text) return;
  const promptSlug = m.reply_to_message ? extractSlugFromPrompt(m.reply_to_message.text) : null;
  if (promptSlug) return cmdRegen(promptSlug, m.text.trim());   // redo note
  return handle(m.text);                                        // typed commands
}

async function dispatch(u) {
  if (u.callback_query) return onCallback(u.callback_query);
  if (u.message) return onMessage(u.message);
}

async function runSweep(nowMs, signal, liveness) {
  // MONTHLY BATCH (2026-08-04). One delivery per calendar month through THIS brand's own bot,
  // plus a safety net for anything about to publish that he has never seen. Runs before the
  // decision sweep below, which only ever looks at posts already shown.
  try {
    await deliverDueReviews({
      brand: "owl-standard", brandLabel: "Owl Standard 簡樸房認證", nowMs, signal,
      notifyPhoto, photoPath: (x) => companyStatePath("owl-standard", "posters", `${x.slug}.png`),
      caption: (x) => `${x.date || x.slug} · ${x.title || x.headline || ""}`,
      keyboard: posterKeyboard, reply,
    });
  } catch (e) { console.log(`owl-standard: monthly delivery failed: ${e?.message || e}`); }

  // Sweeps EVERY week still holding an undecided, not-yet-past post — not just the active one.
  // The active-week pointer moves forward every Thursday (weekly-run -> setActiveWeek); sweeping
  // only that week stranded older undecided posts so their auto-approval never fired. See
  // scripts/lib/review-weeks.mjs.
  const { autoApproved, lastCalls, digest, broken, livenessBlocked } =
    sweepReviewWeeks({ brand: "owl-standard", nowMs, liveness, weeksDir, loadWeek, saveWeek });
  for (const pst of autoApproved) await reply(`⌛ 冇收到回覆,「${postLabel(pst)}」已自動標記為出。想唔出就排程前 tap ❌。`, undefined, { signal });
  for (const pst of lastCalls) {
    await reply(autoApproveEnabled()
      ? `⏳ 最後提醒：「${postLabel(pst)}」就嚟（3 鐘內）自動標記為出。`
      : `⏳ 提醒：「${postLabel(pst)}」將於 ${pst.date} 10:00 發佈，但仍未批准。未批准的帖文不會發佈。`,
    undefined, { signal });
  }
  if (digest) await reply(digest, undefined, { signal });
  // Broken posts (failed generation) are NEVER auto-approved — alert once (deduped) so they get regenerated.
  if (broken.length) await escalate({ source: "owl-standard", kind: "broken-content",
    text: `🔴 Owl Standard：今週有 ${broken.length} 篇未過關（圖片或內容有問題），已攔截唔會自動出。系統會自動重試修復，修唔到先會再搵你。`, signal });
  if (livenessBlocked.length) await escalate({
    source: "owl-standard",
    kind: `review-liveness-gap:${livenessBlocked.map((post) => post.slug).join(",")}`,
    text: `Review auto-approval blocked for Owl Standard: bot liveness was not proven for the full 48-hour window (${livenessBlocked.map((post) => post.slug).join(", ")}). Posts remain undecided.`,
    signal,
  });
}

if (!TG_TOKEN || !TG_CHAT) { console.log("Missing telegram creds in .env"); process.exit(1); }
console.log("Owl Standard review bot listening…");
await runTelegramReviewBot({
  name: "Owl Standard review bot",
  tg,
  loadOffset,
  saveOffset,
  dispatch,
  runSweep,
  replyError: (error) => reply(`⚠️ 出錯：${error.message}`),
});
