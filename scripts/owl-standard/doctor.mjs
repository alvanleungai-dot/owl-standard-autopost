// scripts/owl-standard/doctor.mjs — pre-flight check. Run this BEFORE spending a cent.
//
// It answers one question: "if I run gen-week.mjs right now, what will break?"
// Everything here is read-only and free — no API call, no image render, no post.
//
//   node scripts/owl-standard/doctor.mjs
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getEnv, ENV_FILE_CANDIDATES } from "../lib/env.mjs";
import { backendName } from "../lib/image-backend.mjs";
import { companyConfigPath, companyStatePath } from "../lib/paths.mjs";
import { REVIEW_BOTS, SCHEDULED_JOBS } from "../lib/worker-jobs.mjs";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const rows = [];
const add = (level, what, detail) => rows.push({ level, what, detail });
const OK = "✅", WARN = "⚠️ ", FAIL = "❌";

// ── 1. files the pipeline reads ───────────────────────────────────────────────────────────────────
const required = [
  [companyConfigPath("owl-standard", "company.md"), "租戶設定"],
  [companyConfigPath("owl-standard", "voice.md"), "聲線契約（write-caption 會讀）"],
  [companyConfigPath("owl-standard", "facts.md"), "事實表（文案及海報唯一可引用的事實）"],
  [companyConfigPath("owl-standard", "topics.md"), "lens/persona/angle 資料源"],
  [companyConfigPath("owl-standard", "assets", "logo.png"), "海報 logo"],
  [p("../gen-poster-v4.mjs"), "海報生成器"],
  [p("../write-caption.mjs"), "文案生成器"],
  [p("../derive-concept.mjs"), "概念生成器"],
  [p("./topic-engine.mjs"), "揀題引擎"],
  [p("./gen-week.mjs"), "主 pipeline"],
];
for (const [path, label] of required) {
  if (existsSync(path)) add(OK, label, "");
  else add(FAIL, label, `檔案唔存在：${path}`);
}

// The CJK font must be SHIPPED — the Render container installs none, and without it every Chinese
// glyph in the composited footer renders as a tofu box.
const font = p("../../assets/fonts/NotoSansTC-Bold.ttf");
if (!existsSync(font)) add(FAIL, "中文字型", `assets/fonts/NotoSansTC-Bold.ttf 唔見咗——footer 中文會變豆腐格`);
else if (statSync(font).size < 1_000_000) add(FAIL, "中文字型", "檔案太細，唔似真字型");
else add(OK, "中文字型", `${(statSync(font).size / 1e6).toFixed(1)} MB`);

// ── 2. credentials, by what the run actually needs ────────────────────────────────────────────────
const backend = backendName();
add(OK, "生圖後端", backend + (backend === "higgsfield" ? "（預設）" : "（後備）"));

const need = [
  ["ANTHROPIC_API_KEY", true, "寫文案 + 揀題，冇佢乜都做唔到"],
];
if (backend === "higgsfield") {
  need.push(["HIGGSFIELD_API_KEY_ID", true, "cloud.higgsfield.ai -> API"]);
  need.push(["HIGGSFIELD_API_KEY_SECRET", true, "同上"]);
} else {
  need.push(["OPENAI_API_KEY", true, "platform.openai.com"]);
}
for (const [key, hard, hint] of need) {
  if (getEnv(key)) add(OK, key, "");
  else add(hard ? FAIL : WARN, key, `未設定 — ${hint}`);
}

// Not needed for gen-week, but needed for the steps after it. Warn, never fail.
for (const [key, why] of [
  ["TELEGRAM_BOT_TOKEN_OWLSTANDARD", "審批 bot（weekly-run 先需要）"],
  ["TELEGRAM_BOT_TOKEN__OPS", "警報 bot（Render worker 開機必需）"],
  ["FB_PAGE_ID_OWLSTANDARD", "出 FB 先需要"],
  ["FB_PAGE_TOKEN_OWLSTANDARD", "出 FB 先需要"],
  ["IG_USER_ID_OWLSTANDARD", "出 IG 先需要"],
  ["CLOUDINARY_CLOUD_NAME", "出 IG 先需要"],
]) {
  if (!getEnv(key)) add(WARN, key, `未設定 — ${why}`);
}

// ── 3. the Higgsfield endpoint trap ───────────────────────────────────────────────────────────────
if (backend === "higgsfield") {
  const ep = getEnv("HIGGSFIELD_ENDPOINT");
  if (!ep) {
    add(WARN, "HIGGSFIELD_ENDPOINT",
      "未設定 → 會 fallback 去 Flux Pro，唔係 GPT Image 2。先跑 verify-higgsfield.mjs 搵正確路徑");
  } else if (!ep.includes("gpt-image")) {
    add(WARN, "HIGGSFIELD_ENDPOINT", `= ${ep} — 唔似 GPT Image 路徑，中文準確度未必夠`);
  } else {
    add(OK, "HIGGSFIELD_ENDPOINT", ep);
  }
}

// ── 4. things that silently produce a broken week ─────────────────────────────────────────────────
const cfg = existsSync(companyConfigPath("owl-standard", "company.md"))
  ? readFileSync(companyConfigPath("owl-standard", "company.md"), "utf8") : "";
if (/page_id:\s*""/.test(cfg)) add(WARN, "company.md page_id", "仲係空 — 生成冇問題，出 FB 先會擋");
if (/ig_user_id:\s*""/.test(cfg)) add(WARN, "company.md ig_user_id", "仲係空 — 出 IG 先會擋");
if (/approver_telegram_id:\s*0/.test(cfg)) add(WARN, "company.md approver_telegram_id", "仲係 0 — 審批推送先會用到");

// ── 5. switches: a wrong VALUE does not error, it silently leaves things OFF ──────────────────────
const publishing = getEnv("PUBLISHING_ENABLED");
if (publishing && publishing !== "1") {
  add(WARN, "PUBLISHING_ENABLED", `目前為「${publishing}」，必須填 1，否則雲端上所有發佈工作都會被略過`);
}
for (const item of [...SCHEDULED_JOBS, ...REVIEW_BOTS]) {
  const value = getEnv(item.env);
  if (!value) continue;
  if (value.trim().toLowerCase() === "true") add(OK, item.env, "已開啟");
  else add(WARN, item.env, `目前為「${value}」，必須填 true，否則此工作不會執行`);
}
if (getEnv("REVIEW_AUTO_APPROVE_ENABLED").trim().toLowerCase() === "true") {
  add(WARN, "REVIEW_AUTO_APPROVE_ENABLED", "已開啟 48 小時自動批准：未經您批准的帖文亦會發佈");
}

// A stale week manifest makes gen-week refuse to overwrite. Better to know now than mid-run.
const weeksDir = companyStatePath("owl-standard", "weeks");
add(OK, "weeks/ 目錄", existsSync(weeksDir) ? "已存在" : "未建立（第一次跑會自動開）");

// ── report ────────────────────────────────────────────────────────────────────────────────────────
console.log("\nOwl Standard — 開跑前檢查（唔會用到任何 credit）\n");
console.log("env 讀取次序：");
for (const f of ENV_FILE_CANDIDATES()) console.log(`  · ${f}${existsSync(f) ? "" : "  (唔存在)"}`);
console.log("");
for (const r of rows) console.log(`  ${r.level} ${r.what}${r.detail ? " — " + r.detail : ""}`);

const fails = rows.filter((r) => r.level === FAIL);
const warns = rows.filter((r) => r.level === WARN);
console.log("\n" + "─".repeat(78));
if (fails.length) {
  console.log(`❌ ${fails.length} 個問題會令 gen-week 失敗。修好先好跑。`);
  process.exitCode = 1;
} else {
  console.log(`✅ gen-week 可以跑。${warns.length ? `（${warns.length} 個警告係之後階段先影響到）` : ""}`);
  console.log("\n   下一步：node scripts/owl-standard/gen-week.mjs");
  console.log("   成本：約 US$0.2（3 帖文案 + 3 張海報）");
}
