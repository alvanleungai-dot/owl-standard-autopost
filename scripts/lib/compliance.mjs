// lib/compliance.mjs — Owl Standard's compliance red lines, enforced in code on every caption AND
// every poster concept. ONE list, so the two surfaces cannot drift apart again.
//
// WHY THIS REPLACED TWO COPIES (2026-09-18 review): write-caption.mjs and derive-concept.mjs each
// carried their own 4-rule list, and both were narrow — 「認證有效期為5年」「向屋宇署申請認證」
// 「認證費劃一$3,000」 all passed. companies/owl-standard/company.md names SEVEN red lines; all seven
// are here. compliance.test.mjs pins each rule in BOTH directions: the violations it must stop, and the
// correct sentences it must let through (「劏房不等於簡樸房」「2025年10月刊憲」「第4.5年開始準備續期」) —
// an over-eager rule would fail good posts just as surely as a lax one lets bad ones out.

const S = "[^。！？!?\\n]"; // characters within the same sentence

// A negation right before a claim turns it into the honest disclaimer the voice contract asks for.
const NOT = "(?<!不|唔|冇|沒有|無法|不能|不會|唔會|唔可以|不可以|並非|並不|絕不|從不)";

export const RULES = Object.freeze([
  {
    id: "guarantee",
    why: "不可暗示保證認證結果（例如「包過」「一定成功」「保證通過」）",
    re: new RegExp(`${NOT}(?:包(?:你)?過|保證(?:通過|成功|認證|獲批|批出|過關)|一定(?:過|成功|得|通過|獲批)|百分百(?:通過|成功|獲批)|100\\s*[%％]\\s*(?:通過|成功))`),
  },
  {
    id: "five-years",
    why: "認證有效期一律寫「60個月」，不可寫「5年」",
    re: new RegExp(
      `(?:認證|有效期|有效|證書|續期)${S}{0,10}(?<![\\d.．])(?:5|５|五)\\s*年` +
      `|(?<![\\d.．])(?:5|５|五)\\s*年${S}{0,6}(?:認證|有效|續期|到期)`,
    ),
  },
  {
    id: "buildings-department",
    why: "簡樸房認證由「房屋局」負責，不是「屋宇署」（屋宇署只負責建築工程審批）",
    re: new RegExp(
      "屋宇署(?:的|之|嘅)?(?:簡樸房)?(?:認證|核證|證書)" +
      `|屋宇署${S}{0,6}(?:負責|審批|批出|發出|簽發|頒發|批核|處理)${S}{0,6}(?:認證|證書|簡樸房)` +
      `|(?:向|於|喺)屋宇署${S}{0,4}(?:申請|遞交|提交|申報)${S}{0,8}(?:認證|證書|簡樸房)`,
    ),
  },
  {
    id: "government-endorsement",
    why: "不可暗示政府或官方背書",
    re: new RegExp(`(?<!不是|並非|非|唔係|不屬|沒有|冇)(?:政府|官方|房屋局)(?:認可|指定|推薦)|(?:政府|官方)合作(?:夥伴|伙伴)`),
  },
  {
    id: "flat-fee",
    why: "認證費是三級結構（$0／$1,500／$3,000），不可寫成「劃一 $3,000」",
    re: new RegExp(`(?:劃一|一律|統一)${S}{0,6}(?:HK)?[$＄]?\\s*3,?000|(?:HK)?[$＄]\\s*3,?000${S}{0,4}(?:劃一|一律|統一)`),
  },
  {
    id: "subdivided-not-bhu",
    why: "「劏房」與「簡樸房」不是同義詞：取得認證後才可稱為「簡樸房」",
    re: new RegExp(
      "劏房[，,、\\s]?(?:即係|即是|亦即|也就是|即|又稱|又叫|就係|就是|等於)[，,、\\s]?簡樸房" +
      "|簡樸房[，,、\\s]?(?:即係|即是|亦即|也就是|即|又稱|又叫|就係|就是|等於)[，,、\\s]?劏房" +
      "|劏房\\s*[（(][^）)]{0,3}簡樸房[^）)]{0,2}[)）]|簡樸房\\s*[（(][^）)]{0,3}劏房[^）)]{0,2}[)）]" +
      "|劏房\\s*[／/]\\s*簡樸房|簡樸房\\s*[／/]\\s*劏房",
    ),
  },
  {
    id: "daily-fine",
    why: "提及 $300,000 罰款時，必須同時寫明「每持續一日另罰 $20,000」",
    // Compound rule: the fine is mentioned AND the daily fine is not.
    re: /(?:[$＄]\s*300,?000|30\s*萬|三十萬)/,
    unless: /(?:20,?000|2\s*萬|兩萬|二萬)/,
  },
]);

/** The first red line this text crosses, or null. */
export function findViolation(text) {
  const t = String(text || "");
  return RULES.find((rule) => rule.re.test(t) && !(rule.unless && rule.unless.test(t))) || null;
}
