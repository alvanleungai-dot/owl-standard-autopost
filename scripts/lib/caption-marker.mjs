// lib/caption-marker.mjs — the SINGLE definition of "a caption's hook" and the publish-dedup marker.
//
// WHY THIS MODULE EXISTS (2026-08-25)
//   There were two copies of this logic — write-caption.mjs's hook check and lib/fb-post.mjs's
//   markerFor — and BOTH had the same defect: they took the first line containing 【, but the brand
//   footer itself contains 【Owl Standard 簡樸房認證】. So a caption with no real hook silently took the
//   BRAND NAME as its dedup marker — identical for every post — and api-schedule.mjs would then skip
//   every post after the first as a duplicate. Two copies of one rule is how that survived a fix to
//   only one of them, so there is now exactly one.
//
//   It also lives here, and not in fb-post.mjs, because fb-post.mjs imports playwright at module load.
//   playwright is a devDependency; on a production install (Render) importing it throws, which would
//   take down tg-bridge.mjs and watchdog.mjs — neither of which drives a browser. This module has no
//   dependencies at all.
// The brand footer, appended to every caption. Defined HERE (not in write-caption.mjs) so this
// module imports nothing — importing back into write-caption.mjs created a circular import.
export const FOOTER = `📞 想了解你個單位嘅情況？
📱 WhatsApp：+852 5192 7907
✉️ 電郵：info@owl2coliving.com
🌐 網站：owlstandard.com

【Owl Standard 簡樸房認證】—— 八年業主管理經驗，一站式合規代辦。`;

const FOOTER_LINES = new Set(FOOTER.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
const clean = (s) => (s || "").replace(/[^一-鿿0-9A-Za-z]/g, "");

/** The caption's own hook line — a line carrying 【…】 that is NOT part of the brand footer. */
export const hookLine = (cap) =>
  (cap || "").split(/\r?\n/).find((l) => l.includes("【") && !FOOTER_LINES.has(l.trim())) || null;

export const hasHook = (cap) => hookLine(cap) !== null;

/** The publisher's dedup marker: up to 12 clean chars taken from the caption's own hook. */
export const markerFor = (cap) => {
  const line = hookLine(cap) || (cap || "").split(/\r?\n/)[0] || "";
  const m = line.match(/【(.+?)】/);
  return clean(m ? m[1] : line).slice(0, 12);
};
