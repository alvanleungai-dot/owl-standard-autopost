// scripts/lib/figure-safety.mjs — stop drawing three-handed characters in the first place.
//
// THE PROBLEM (owner, 2026-08-04: "there's always a situation where the team gets three hands")
//   The image check catches these and the redraw loop fixes them, so nothing broken has reached a
//   client page. But every occurrence costs a paid re-render and a day of delay, and the rate is not
//   small — 2 of 10 posters inspected on 2026-08-04 failed `anatomy`:
//
//     tml/2026-08-24-01  "the bear's right hand has two fingers pointing up near its mouth"
//     better-life/W39-01 "the child's outstretched right arm/hand appears abnormally elongated"
//
//   Detection was already solved. This is about PREVENTION.
//
// THE CAUSE, and why it is not just "AI is random"
//   Both defects are hand-forward poses, and that is not a coincidence. TML's generator asks Haiku to
//   invent a fresh pose per topic — `mascotDirection`, free-form English, e.g. "examining items with
//   its magnifying glass, curious friendly face". A raised paw holding an object near the face is the
//   single most defect-prone thing you can ask an image model for: articulated fingers, occlusion,
//   and a second limb crossing the first. We were requesting the hardest possible drawing every week
//   and then paying to fix it.
//
//   Meanwhile the prompts were extremely specific about layout, typography and forbidden words, and
//   said NOTHING about how many limbs the character should have.
//
// THE FIX — two cheap, non-visual changes
//   1. Choose the pose from a WHITELIST of low-risk poses instead of inventing one. Every entry keeps
//      paws simple, unoccluded and away from the face. The character still varies; the failure-prone
//      configurations are simply not on the menu.
//   2. State the anatomy rule explicitly in the image prompt, the same way the brand rules are stated.
//
// DELIBERATELY NOT DONE: compositing a fixed pre-rendered mascot PNG. That would make anatomy
// perfectly deterministic, but it also makes every poster identical and cannot help the incidental
// humans in Better Life's photographic art. Keep it in reserve if the rate stays high.

/**
 * Poses that keep both paws simple, separated and away from the face.
 * Anything involving fingers, held objects near the head, or crossed limbs is deliberately absent.
 */
export const SAFE_POSES = Object.freeze([
  "standing upright and friendly, both paws relaxed at its sides, warm confident smile",
  "standing with both paws resting together low in front of its body, gentle reassuring expression",
  // Both paws placed explicitly. An unspecified paw is an invented paw — the model will put it
  // somewhere, and "somewhere" is how a third one appears.
  "standing beside a large simple object at its side, one paw resting flat on it and the other relaxed at its side, calm friendly expression",
  "seated behind a simple desk, both paws resting flat on the desk surface, attentive kind expression",
  "standing with one paw held low and open in a small welcoming gesture, the other relaxed at its side",
  "standing squarely facing the viewer, both paws tucked into its lab-coat pockets, encouraging smile",
]);

/** The clause that states the rule the prompts never stated. */
export const ANATOMY_RULE =
  "ANATOMY (STRICT): every character has EXACTLY two arms, two legs and one head, and each arm ends in " +
  "ONE simple rounded paw or hand. Paws must be simple mitten shapes — do NOT draw separated or splayed " +
  "fingers. Both paws must be clearly visible and clearly separated from each other and from the body; " +
  "no limb may merge into the body, into another limb, or into any object. Do NOT place a paw or hand " +
  "near the face or mouth. Do NOT draw a third arm, an extra paw, or a duplicated limb. ";

/** The same rule for incidental photographic humans, where mitten paws make no sense. */
export const HUMAN_ANATOMY_RULE =
  "ANATOMY (STRICT): any person has EXACTLY two arms, two hands, two legs and five fingers per hand, in " +
  "natural proportion. Hands must be relaxed and simple; do NOT draw outstretched, reaching or " +
  "gesturing hands, splayed fingers, or a hand near the face. Prefer hands resting, holding nothing, or " +
  "out of frame entirely. No extra or elongated limbs. ";

/**
 * PURE. Force a proposed pose onto the whitelist.
 *
 * A model asked to "pick from this list" will still occasionally return something adjacent, so this
 * is the enforcement rather than the request: an unrecognised pose falls back to a safe one chosen
 * deterministically from the slug, so the same post regenerates identically instead of rolling dice.
 */
export function constrainPose(proposed, slug = "", poses = SAFE_POSES) {
  const wanted = String(proposed || "").trim().toLowerCase();
  const exact = poses.find((p) => p.toLowerCase() === wanted);
  if (exact) return { pose: exact, substituted: false };
  // Accept a near-miss only when the model echoed a whitelist entry with extra wording around it.
  const contained = poses.find((p) => wanted.includes(p.toLowerCase()));
  if (contained) return { pose: contained, substituted: false };
  return { pose: poses[stableIndex(slug, poses.length)], substituted: true, proposed: String(proposed || "") };
}

/** Deterministic index from a slug — same post, same fallback pose, every regeneration. */
export function stableIndex(slug, length) {
  if (!Number.isInteger(length) || length <= 0) return 0;
  let hash = 0;
  for (const ch of String(slug)) hash = (hash * 31 + ch.charCodeAt(0)) % 2147483647;
  return hash % length;
}

/** The list as prompt text, for asking the concept model to choose rather than invent. */
export function poseMenu(poses = SAFE_POSES) {
  return poses.map((p, i) => `(${i + 1}) ${p}`).join(" | ");
}
