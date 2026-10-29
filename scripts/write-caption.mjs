// write-caption.mjs — draft ONE Facebook/Instagram caption for Owl Standard in the brand voice.
//   node scripts/write-caption.mjs "認證前評估同免費勘察有咩分別？"
//
// Retargeted from the original Better Life (divorce) writer when this checkout was pruned to Owl Standard.
// The voice contract itself lives in companies/owl-standard/voice.md and is injected verbatim below, so
// tone changes are a data edit, not a code edit.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { askText } from "./lib/anthropic.mjs";
import { companyConfigPath } from "./lib/paths.mjs";
import { FOOTER, hasHook } from "./lib/caption-marker.mjs";
import { RULES, findViolation } from "./lib/compliance.mjs";

const voice = readFileSync(companyConfigPath("owl-standard", "voice.md"), "utf8");
// The ONLY facts a caption may cite (dates, fees, penalties, standards). Before 2026-09-18 the model
// wrote these from its own training data, which predates the ordinance's final text.
const facts = readFileSync(companyConfigPath("owl-standard", "facts.md"), "utf8");

// FOOTER lives in lib/caption-marker.mjs so that module has no import back into this one (a cycle
// there caused a TDZ ReferenceError). It is brand data both files need.

// The seven red lines live in lib/compliance.mjs, shared with derive-concept.mjs. Re-exported here
// because tests and older callers read them from this module.
export const BANNED = RULES;

// hookLine/hasHook live in lib/caption-marker.mjs — one definition, shared with the publisher's
// markerFor so the two can never drift apart again.

// `ask` is injectable so the compliance gate below can be tested without spending an API call — the
// gate is the highest-risk logic in this file and an untested gate is not a gate.
export async function writeCaption(topic, { ask: askFn = askText } = {}) {
  const system =
    `You write Facebook/Instagram captions for Owl Standard 簡樸房認證, a Hong Kong BHU (簡樸房) compliance ` +
    `consultancy under Owl Square Group — a consultant/works coordinator, NOT a law firm. ` +
    `Follow this voice contract EXACTLY:\n\n${voice}` +
    `\n\n---\nFACT SHEET — the ONLY source for any date, fee, penalty, number or standard you mention. ` +
    `If a number you want is not in it, do not write that number.\n\n${facts}`;

  const ask = (extra = "") =>
`Write ONE social caption in WRITTEN CANTONESE (繁體) for this topic:
題目：${topic.title}${topic.angle ? `（${topic.angle}）` : ""}${topic.lensDesc ? `\n內容範圍：${topic.lensDesc}` : ""}${topic.publishDate ? `\n發佈日期：${topic.publishDate}（凡提及「現在」「尚餘多久」「截止」，一律以此日期計算）` : ""}${topic.note ? `\n老闆的修改意見（必須採納）：${topic.note}` : ""}

Requirements:
- Open with a 【bracketed hook】 + one emoji.
- Follow the post structure in the voice contract; include ONE insight beat (🔍 實務上見到嘅情況 / 💡 好多業主唔知 / ⚠️ 常見錯誤).
- Every date, fee, penalty, number and standard must come from the FACT SHEET — never invent one.
  Hedge case-specific claims with 「每個單位情況唔同，搵我哋睇下」.
- HARD RULES (a caption breaking any of these is rejected):
${RULES.map((rule) => `  · ${rule.why}`).join("\n")}
- End with EXACTLY this footer block verbatim, then 3-4 relevant hashtags ending with #簡樸房認證:
${FOOTER}
${extra}
Return ONLY the caption text — no preamble, no explanation.`;

  let cap = await askFn(ask(), { system, maxTokens: 1400 });

  // One targeted retry that NAMES the violated rule — a bare "try again" reliably reproduces the same slip.
  let hit = findViolation(cap);
  if (hit) {
    cap = await askFn(
      ask(`NOTE: your previous attempt broke this rule — ${hit.why}。請重寫，確保完全沒有違反。`),
      { system, maxTokens: 1400 },
    );
    hit = findViolation(cap);
  }
  if (hit) throw new Error(`caption still violates a compliance rule after one retry: ${hit.why}`);

  // THE HOOK CHECK MUST RUN BEFORE THE FOOTER IS ADDED, and must ignore the footer's own brackets.
  // Inherited bug (present upstream too, where the footer read the divorce brand's name): the footer
  // contains 【Owl Standard 簡樸房認證】, so a plain /【.+?】/ test on the FINISHED caption is always
  // true — the check was dead. The knock-on matters more than the dead assertion: markerFor() in
  // gen-week.mjs takes the first line containing 【, so a hookless caption would take the BRAND NAME
  // as its dedup marker — identical for every post — and api-schedule.mjs would then skip every post
  // after the first as a duplicate.
  if (!hasHook(cap)) throw new Error("caption missing a 【hook】 (needed for the publisher's dedup marker)");

  // belt-and-suspenders: guarantee the footer is present
  if (!cap.includes("+852 5192 7907") || !cap.includes("【Owl Standard 簡樸房認證】")) {
    cap = cap.trimEnd() + "\n\n" + FOOTER + "\n\n#簡樸房 #業主合規 #簡樸房認證";
  }
  return cap.trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const title = process.argv.slice(2).join(" ") || "認證前評估同免費勘察有咩分別？";
  console.log(await writeCaption({ title }));
}
