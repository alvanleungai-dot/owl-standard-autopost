// Every red line is pinned in BOTH directions. The "must block" lists include the exact phrasings that
// slipped through the old regexes in the 2026-09-18 review; the "must allow" lists are correct sentences
// a careless rule would reject (and so fail good posts).
import test from "node:test";
import assert from "node:assert/strict";
import { RULES, findViolation } from "./compliance.mjs";

const CASES = {
  guarantee: {
    block: ["我哋包過，放心", "保證通過認證", "一定成功", "100%通過", "百分百成功"],
    allow: ["我們不會保證通過，但會先評估風險", "唔一定成功，每個單位情況唔同", "不保證結果", "唔會保證通過"],
  },
  "five-years": {
    block: ["認證有效期5年", "認證有效期為5年", "有效期為五年", "證書有效5年", "認證可以用５年", "5年後要續期"],
    allow: ["認證有效期為60個月", "條例於2025年10月刊憲", "第4.5年開始準備續期", "集團有8年經驗", "2030年全面執法"],
  },
  "buildings-department": {
    block: ["由屋宇署認證", "屋宇署負責簡樸房認證", "向屋宇署申請認證", "由屋宇署審批認證", "屋宇署發出的證書"],
    allow: [
      "簡樸房認證由房屋局負責，屋宇署只負責建築工程審批",
      "屋宇署命令會延遲認證",
      "未解決的屋宇署清拆令會影響認證時間表",
      "屋宇署處理清拆令後，才可以申請認證",
    ],
  },
  "government-endorsement": {
    block: ["本公司政府認可", "官方指定顧問", "房屋局推薦的顧問", "政府合作夥伴"],
    allow: ["我們不是政府機構", "並非政府認可的機構，只協助業主完成政府要求的申請程序"],
  },
  "flat-fee": {
    block: ["認證費劃一$3,000", "一律收費 $3,000", "統一收費3000元"],
    allow: ["認證前評估 HK$3,000，簽約後全數抵扣", "沒有寬限期登記的標準費為 $3,000", "罰款 $300,000，每持續一日另罰 $20,000"],
  },
  "subdivided-not-bhu": {
    block: ["劏房即係簡樸房", "劏房即是簡樸房", "簡樸房又稱劏房", "劏房（簡樸房）業主", "劏房／簡樸房業主"],
    allow: ["劏房不等於簡樸房", "劏房唔等於簡樸房", "劏房同簡樸房有咩分別", "分間單位取得認證後才可稱為簡樸房"],
  },
  "daily-fine": {
    block: ["罰款$300,000及監禁3年", "最高可罰30萬"],
    allow: ["罰款 $300,000 及監禁 3 年，每持續一日另罰 $20,000", "最高罰款30萬，另每日罰2萬"],
  },
};

test("every rule has test cases in both directions (no untested red line)", () => {
  assert.deepEqual(RULES.map((r) => r.id).sort(), Object.keys(CASES).sort());
  assert.equal(RULES.length, 7, "company.md names seven red lines");
});

for (const rule of RULES) {
  test(`red line "${rule.id}": blocks every violation and allows every correct sentence`, () => {
    for (const text of CASES[rule.id].block) {
      assert.equal(findViolation(text)?.id, rule.id, `must block: ${text}`);
    }
    for (const text of CASES[rule.id].allow) {
      assert.equal(findViolation(text), null, `must allow: ${text}`);
    }
  });
}
