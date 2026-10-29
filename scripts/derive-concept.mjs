// derive-concept.mjs — turn a topic+caption into poster concept fields, and write the
// concepts/<name>.txt file in the exact shape gen-poster-v4 expects.
// Retargeted from Better Life (divorce) to Owl Standard (簡樸房/BHU compliance) on 2026-08-25.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { askJSON } from "./lib/anthropic.mjs";
import { companyConfigPath, companyStatePath, ensureStateParent } from "./lib/paths.mjs";
import { RULES, findViolation } from "./lib/compliance.mjs";

// Card labels and the pull-quote often carry a number; it must come from the same fact sheet as the caption.
const facts = readFileSync(companyConfigPath("owl-standard", "facts.md"), "utf8");

const conceptPath = (name) => companyStatePath("owl-standard", "concepts", `${name}.txt`);

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headline", "scene", "cards", "quote"],
  properties: {
    headline: { type: "string" },
    scene: { type: "string" },
    cards: { type: "array", items: { type: "string" } },
    quote: { type: "string" },
  },
};

// The poster is a published surface too, so the same seven red lines as the caption (lib/compliance.mjs)
// are enforced here: a violation must fail rather than get rendered into an image.

export async function deriveConcept(topic, caption) {
  const prompt =
`For an Owl Standard poster on this topic, produce concept fields.
Owl Standard is a Hong Kong 簡樸房 (Basic Housing Unit / BHU) compliance consultancy under Owl Square Group —
a consultant and works coordinator for landlords, NOT a law firm and NOT a government body.
Topic: ${topic.title}
Caption (reference only):
${caption}

Return JSON {headline, scene, cards, quote}:
- headline: a SHORT punchy Cantonese hook for the poster image (≤ ~12 characters, no 【】 brackets).
- scene: an ENGLISH description of a calm, orderly, professional NO-TEXT image — e.g. a tidy compliant
  subdivided unit interior, a floor plan on a desk, independent utility meters, a fire door, measuring tools.
  No words or letters in the image; avoid faces unless essential.
- cards: EXACTLY 4 short Cantonese labels (≤ 8 characters each) = the post's key points.
- quote: ONE short Cantonese pull-quote (rendered in the orange brand accent).

HARD RULES — none of these may appear in ANY field:
${RULES.map((rule) => `- ${rule.why}`).join("\n")}

Any number, date or fee in any field must come from this fact sheet (if it is not there, use words, not a number):
${facts}`;

  const c = await askJSON(prompt, SCHEMA, { maxTokens: 1200 });
  const all = [c.headline, c.scene, c.quote, ...(c.cards || [])].join(" ");
  const hit = findViolation(all);
  if (hit) throw new Error(`concept violates a compliance rule: ${hit.why}`);
  c.cards = (c.cards || []).slice(0, 4);
  while (c.cards.length < 4) c.cards.push("搵我哋傾下");
  return c;
}

// Write concepts/<name>.txt (line1 = headline; rest = scene + cards + quote).
export function writeConceptFile(name, c) {
  const txt =
`${c.headline}\n${c.scene} The four cards must read (each an ORANGE icon + one short label): ` +
`${c.cards.join(" / ")}. The short orange pull-quote reads: ${c.quote}`;
  const path = ensureStateParent(conceptPath(name));
  writeFileSync(path, txt, "utf8");
  return path;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const c = await deriveConcept(
    { title: "認證前評估同免費勘察有咩分別？", angle: "test" },
    "【先判斷，再決定 🔍】 好多業主…",
  );
  console.log(JSON.stringify(c, null, 2));
}
