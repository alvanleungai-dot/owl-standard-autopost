// scripts/owl-standard/topic-engine.mjs — Owl Standard's OWN topic-discovery engine.
//
// WHY THIS FILE EXISTS SEPARATELY (not scripts/lib/topic-engine.mjs):
// The shared lib/topic-engine.mjs LENSES/PERSONAS/ANGLES arrays are hardcoded to HK-divorce content
// (Cantonese lens descriptions about custody, maintenance, hidden assets, etc). Owl Standard is a
// different industry (簡樸房/BHU compliance certification) — reusing the shared file would either mine
// divorce topics via Perplexity regardless of brandBrief, or require rewriting the shared file and
// re-testing all four divorce tenants (Better Life/Bright Day/Sunmood/TML) that depend on it.
// This file is an independent, same-shaped module scoped to companies/owl-standard/ only — it does not
// import from or modify scripts/lib/topic-engine.mjs. Mirrors the scripts/bright-day/ pattern of a
// per-tenant folder for tenant-specific logic.
//
//   import { proposeTopics, LENSES, PERSONAS, ANGLES } from "./topic-engine.mjs";
//   const topics = await proposeTopics(3);
//
// Smoke test:  node scripts/owl-standard/topic-engine.mjs [count]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { askText } from "../lib/anthropic.mjs";
import { companyStatePath, ensureStateParent } from "../lib/paths.mjs";

const BRAND = "owl-standard";

// ── Lenses — content sub-topics, sourced from companies/owl-standard/topics.md (verified against the
// official Cap.658 ordinance text and owlstandard.com's real content clusters — not invented). ──
export const LENSES = [
  { tag: "bhu-vs-subdivided", desc: "簡樸房（BHU）同劏房嘅法定分別：法律定義 vs 坊間講法" },
  { tag: "grace-deadline", desc: "寬限期登記截止日（2027年2月28日）同登記資格" },
  { tag: "enforcement-penalty", desc: "執法日（2027年3月1日）同罰則層級：簡易程序 vs 公訴程序" },
  { tag: "lease-ban-2029", desc: "2029年9月倒數期：未認證單位唔可以訂立新租約" },
  { tag: "full-enforcement-2030", desc: "全面執法里程碑（2030年3月1日）" },
  { tag: "oc-deed-restriction", desc: "業主立案法團公契（OC）限制同簡樸房認證嘅關係" },
  { tag: "subdivided-unit-definition", desc: "分間單位嘅法定構成要件（條例第4條）" },
  { tag: "ineligible-premises", desc: "邊啲處所唔適用簡樸房條例（資助出售單位、床位寓所、過渡性房屋等）" },
  { tag: "statutory-orders", desc: "屋宇署法定命令（第24條清拆令、第25條用途令、第26/26A條、第28條渠務令）同認證嘅關係" },
  { tag: "terminology", desc: "簡樸房條例術語辨析：房屋局 vs 屋宇署、認證 vs 登記" },
  { tag: "min-area-height", desc: "最低樓面面積（8平方米）同樓底高度（2.3米）計算方法" },
  { tag: "fire-safety", desc: "消防安全要求：FD30防火門、火警偵測器、滅火器年檢" },
  { tag: "ventilation", desc: "通風方案：方案A自然通風 vs 方案B機械通風，每小時5次換氣率" },
  { tag: "bathroom-req", desc: "獨立廁所要求：水廁、盥洗盆、浴缸或花灑三件缺一不可" },
  { tag: "meters", desc: "獨立水錶電錶要求：中電/港燈專供，電工加裝分錶唔合規" },
  { tag: "ineligible-units", desc: "邊啲單位唔符合簡樸房認證資格（例如天台構築物）" },
  { tag: "why-fail", desc: "常見認證失敗5大原因" },
  { tag: "specified-professional", desc: "指明專業人士三類範疇（註冊建築師/工程師/測量師）同AP/RSE/RGE分別" },
  { tag: "pre-assessment", desc: "認證前評估係咩：HK$3,000，8項標準逐項檢視，唔等於正式核證" },
  { tag: "fee-tiers", desc: "三級認證費結構：早鳥全免、半費$1,500、標準$3,000" },
  { tag: "renewal-fee", desc: "續期費用：60個月屆滿，每個簡樸房$2,400，第4.5年開始準備" },
  { tag: "diy-vs-consultant", desc: "DIY vs 請顧問嘅真實成本比較：顧問統籌費$5,000-15,000起" },
  { tag: "total-cost", desc: "全程總費用試算：評估、改造、認證三階段" },
  { tag: "renovation-categories", desc: "合規改造6大類：水電獨立計量、防火防煙門、FS251煙霧感應、機械通風、基本消防設施" },
  { tag: "certification-steps", desc: "認證代辦6環節：BHU-01表格、核證報告、結構評估、通風評估、房屋局溝通、認證書交付" },
  { tag: "post-cert-management", desc: "認證後管理6服務：出租配對、租客審核、租金收繳、維修保養、合規維持、續期準備" },
  { tag: "rent-premium", desc: "認證單位嘅租金溢價（市場約5-8%）" },
  { tag: "honest-positioning", desc: "誠實定位：條例2026年先生效，市場冇老案例，唔扮有經驗" },
];

export const PERSONAS = [
  "現有分間單位業主（未登記，高風險）", "已寬限期登記、猶豫要唔要即刻認證嘅業主",
  "二房東／營運人（承租後分租）", "跨境業主（人喺內地或海外）",
  "透過繼承取得物業嘅業主", "物業仲有按揭嘅業主",
  "舊樓（1980年前興建）業主", "持有多間分間單位嘅業主",
  "已收到屋宇署命令（清拆令/渠務令）嘅業主", "想自己DIY唔請顧問嘅業主",
  "已經委託地產代理但唔熟認證流程嘅業主", "子女在外、業主年長者",
];

export const ANGLES = [
  "拆解常見迷思", "一步步教點做（流程拆解）", "費用透明化試算", "時間線同每步要幾耐",
  "常犯錯誤提醒", "兩種做法比較", "真實情境點處理", "答一條好多人問嘅問題",
  "用一張清單整理要點", "數字/數據型",
];

const BRAND_BRIEF =
  `你為香港「Owl Standard 簡樸房認證」揀社交媒體內容主題。呢間公司係 Owl Square Group 旗下嘅合規顧問品牌，` +
  `提供簡樸房（BHU）認證一站式服務，唔係律師行。語氣專業、可靠、沉穩自信，主打建立公司權威感。` +
  `硬性規則：唔可以暗示保證認證結果、唔可以以公司名義提供法律定論、唔可以講「5年」（一律用「60個月」）、` +
  `唔可以用「屋宇署」指代BHU認證主管部門（要用「房屋局」）。`;

function loadCoverage() {
  const path = companyStatePath(BRAND, "topic-coverage.json");
  if (existsSync(path)) { try { return JSON.parse(readFileSync(path, "utf8")); } catch {} }
  return { lens: {}, persona: {}, angle: {} };
}
function saveCoverage(cov) {
  const path = ensureStateParent(companyStatePath(BRAND, "topic-coverage.json"));
  writeFileSync(path, JSON.stringify(cov, null, 2), "utf8");
}
function leastUsed(items, usage, k, keyOf) {
  return items.map((it, i) => ({ it, i, u: usage[keyOf(it)] || 0 }))
    .sort((a, b) => a.u - b.u || a.i - b.i).slice(0, k).map((x) => x.it);
}

const LEDGER_PATH = () => companyStatePath(BRAND, "topics-ledger.json");
const norm = (s) => (s || "").replace(/[^一-鿿0-9A-Za-z]/g, "").toLowerCase();
export function loadLedger() {
  const path = LEDGER_PATH();
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return []; }
}
export function isDuplicate(title, ledger = loadLedger()) {
  const n = norm(title);
  if (!n) return true;
  return ledger.some((e) => { const m = norm(e.title); return m && (m.includes(n) || n.includes(m)); });
}
export function appendLedger(entries) {
  const cur = loadLedger();
  cur.push(...entries);
  writeFileSync(ensureStateParent(LEDGER_PATH()), JSON.stringify(cur, null, 2), "utf8");
  return cur.length;
}

// Propose `n` fresh, non-duplicate topics. Picks the LEAST-USED lens/persona/angle cells first (structural
// non-repetition), asks Haiku to draft concrete topic titles for those cells, then dedupes against the
// ledger. Does NOT call Perplexity — Owl Standard's facts are already verified against the ordinance text
// in topics.md/seeds.md, so this stays a single cheap Haiku call rather than N parallel research queries.
export async function proposeTopics(n = 3) {
  const cov = loadCoverage();
  const ledger = loadLedger();
  const picks = leastUsed(LENSES, cov.lens, n + 2, (l) => l.tag);
  const persona = leastUsed(PERSONAS, cov.persona, 1, (p) => p)[0];
  const angle = leastUsed(ANGLES, cov.angle, 1, (a) => a)[0];

  const prompt =
    `${BRAND_BRIEF}\n\n` +
    `目標人物：${persona}\n表達手法：${angle}\n` +
    `候選話題角度（揀最啱嘅 ${n} 個，每個寫一個具體、唔重複嘅帖文標題）：\n` +
    picks.map((l) => `- [${l.tag}] ${l.desc}`).join("\n") +
    `\n\n已經用過嘅標題（避免重複或改寫版本）：\n${ledger.slice(-40).map((e) => `- ${e.title}`).join("\n") || "（無）"}` +
    `\n\n只輸出 ${n} 行，每行一個標題，唔要編號、唔要解釋。`;

  const raw = await askText(prompt, { maxTokens: 512 });
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, n + 2);

  const fresh = [];
  for (const title of lines) {
    if (isDuplicate(title, ledger)) continue;
    if (fresh.some((f) => isDuplicate(title, [{ title: f.title }]))) continue;
    fresh.push({ title, angle, persona, lens: picks[fresh.length]?.tag || picks[0].tag });
    if (fresh.length >= n) break;
  }

  // Mark the cells we drew from as used, regardless of how many titles survived dedup — the point is to
  // stop re-drawing the same least-used cells every call, not to only count successes.
  for (const l of picks.slice(0, fresh.length || 1)) cov.lens[l.tag] = (cov.lens[l.tag] || 0) + 1;
  cov.persona[persona] = (cov.persona[persona] || 0) + 1;
  cov.angle[angle] = (cov.angle[angle] || 0) + 1;
  saveCoverage(cov);

  return fresh;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const n = Number(process.argv[2]) || 3;
  const fresh = await proposeTopics(n);
  console.log(`fresh ${fresh.length}/${n} (ledger has ${loadLedger().length} used):`);
  fresh.forEach((t, i) => console.log(`  ${i + 1}. ${t.title}   [lens:${t.lens} persona:${t.persona} angle:${t.angle}]`));
}
