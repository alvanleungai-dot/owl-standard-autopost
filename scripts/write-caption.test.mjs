// Tests for the caption compliance gate — the rules in companies/owl-standard/company.md
// "Compliance red-lines", enforced in code rather than only documented.
import test from "node:test";
import assert from "node:assert/strict";
import { writeCaption, BANNED } from "./write-caption.mjs";
import { hookLine, markerFor } from "./lib/caption-marker.mjs";

const FOOTER_OK =
  "📱 WhatsApp：+852 5192 7907\n【Owl Standard 簡樸房認證】—— 八年業主管理經驗，一站式合規代辦。";
const good = `【先判斷，再決定 🔍】認證有效期係60個月，由房屋局審批。\n${FOOTER_OK}`;
const topic = { title: "認證前評估係咩" };

test("a compliant caption passes through unchanged", async () => {
  const cap = await writeCaption(topic, { ask: async () => good });
  assert.match(cap, /【先判斷，再決定/);
  assert.match(cap, /60個月/);
});

test("the caption gate enforces the shared seven-rule list (each rule is pinned in lib/compliance.test.mjs)", () => {
  assert.equal(BANNED.length, 7, "company.md names seven red lines");
});

test("the caption is grounded: fact sheet in the system prompt, publish date in the brief", async () => {
  let seen;
  await writeCaption({ ...topic, publishDate: "2026-10-06" }, {
    ask: async (prompt, options) => { seen = { prompt, system: options.system }; return good; },
  });
  assert.match(seen.system, /每日另罰 \$20,000/, "the fact sheet must reach the model");
  assert.match(seen.system, /2027-02-28/);
  assert.match(seen.prompt, /發佈日期：2026-10-06/);
});

test("a violation triggers ONE retry, and the retry prompt names the broken rule", async () => {
  const prompts = [];
  let call = 0;
  const cap = await writeCaption(topic, {
    ask: async (prompt) => { prompts.push(prompt); return ++call === 1 ? `【測試 🔍】認證有效期5年\n${FOOTER_OK}` : good; },
  });
  assert.equal(call, 2, "must retry exactly once");
  assert.match(prompts[1], /60個月/, "the retry must NAME the violated rule — a bare 'try again' repeats the slip");
  assert.match(cap, /60個月/);
});

test("a violation that survives the retry THROWS rather than shipping", async () => {
  await assert.rejects(
    () => writeCaption(topic, { ask: async () => `【測試 🔍】我哋包過\n${FOOTER_OK}` }),
    /compliance rule after one retry/,
  );
});

test("each red line is enforced end to end", async () => {
  // Includes the exact phrasings that slipped through the old four-rule gate (2026-09-18 review).
  const violations = [
    "認證有效期為5年", "向屋宇署申請認證", "我哋包過", "政府認可",
    "認證費劃一$3,000", "劏房即係簡樸房", "罰款$300,000及監禁3年",
  ];
  for (const v of violations) {
    await assert.rejects(
      () => writeCaption(topic, { ask: async () => `【測試 🔍】${v}\n${FOOTER_OK}` }),
      /compliance rule after one retry/,
      `"${v}" must be rejected`,
    );
  }
});

test("a missing footer is appended rather than silently shipped", async () => {
  const cap = await writeCaption(topic, { ask: async () => "【先判斷，再決定 🔍】認證要 60個月。" });
  assert.match(cap, /\+852 5192 7907/);
  assert.match(cap, /【Owl Standard 簡樸房認證】/);
});

test("a caption with no 【hook】 throws — the publisher dedups on that marker", async () => {
  await assert.rejects(
    () => writeCaption(topic, { ask: async () => `冇括號嘅標題\n${FOOTER_OK}` }),
    /missing a 【hook】/,
  );
});

// REGRESSION (2026-08-25): the footer itself contains 【Owl Standard 簡樸房認證】, so a naive
// /【.+?】/ test on the finished caption is always true and the hook check was dead. The knock-on is
// worse than a dead assertion: gen-week's markerFor takes the first line containing 【, so a hookless
// caption would take its dedup marker from the BRAND NAME — identical for every post — and
// api-schedule.mjs would skip every post after the first as a duplicate.
test("hookLine ignores the footer's own brackets", () => {
  assert.equal(hookLine(FOOTER_OK), null, "the footer alone must not count as a hook");
  assert.match(hookLine(good), /先判斷，再決定/, "a real hook line must be found");
});

test("two hookless captions must not collapse to the same dedup marker", async () => {
  // Both would previously have yielded the brand name as their marker.
  for (const body of ["第一篇內容，冇括號標題。", "第二篇內容，都係冇括號。"]) {
    await assert.rejects(
      () => writeCaption(topic, { ask: async () => `${body}
${FOOTER_OK}` }),
      /missing a 【hook】/,
      "a hookless caption must be rejected at source, not given the brand name as its marker",
    );
  }
});

// The publisher's marker and the caption's hook check must stay ONE definition — see
// lib/caption-marker.mjs for the two-copies bug this prevents.
test("markerFor takes the caption's own hook, never the footer's brand brackets", () => {
  assert.equal(markerFor(good), "先判斷再決定");
  const a = `【第一篇獨有標題 🔍】內容甲
${FOOTER_OK}`;
  const b = `【第二篇獨有標題 📋】內容乙
${FOOTER_OK}`;
  assert.notEqual(markerFor(a), markerFor(b), "distinct hooks must yield distinct dedup markers");
  assert.ok(!markerFor(a).includes("OwlStandard"), "the brand name must never become the marker");
});
