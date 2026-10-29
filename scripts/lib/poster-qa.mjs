// scripts/lib/poster-qa.mjs — LOOK AT THE POSTER BEFORE IT GOES OUT.
//
// WHY THIS EXISTS
// Every other check in this engine measures the PIPELINE: did the job run, did the file appear, did
// the API return 200. None of them look at the picture. But the picture is where failures actually
// happen — the image model is the only stochastic component in the whole system, and it fails in ways
// a green exit code cannot see.
//
// Observed on live TML/Sun Mood posters, 2026-07-31:
//   · the mascot bear drawn with THREE hands (owner-reported, the trigger for this module)
//   · garbled pseudo-characters inside the WhatsApp button on every mascot poster
//   · body text clipped by the footer bar ("濕疹肌膚 / 需要呼吸空間" cut in half)
//   · a grey placeholder rectangle where branding failed to composite
//   · a before/after pair where the "after" was no better than the "before"
//
// THE CONTRACT: this returns a verdict on ONE poster. It never deletes, regenerates or publishes —
// the caller decides what to do. Callers use `shouldRetry` / `verdictSummary` to drive a bounded
// regenerate loop and then fail CLOSED: a poster that cannot pass is left marked broken, and
// publishable.mjs already refuses to publish a post carrying an error.
//
// FAIL-OPEN IS DELIBERATE FOR *INFRASTRUCTURE* FAILURES ONLY. If the vision API is unreachable we
// return `pass: true, inspected: false` — an outage in the checker must not silently stop four
// brands from publishing. A real DEFECT (a verdict we actually received) always fails closed.

import { readFileSync } from "node:fs";

// MEASURED 2026-07-31, not chosen by price. Both models were run against four real posters — two
// with defects confirmed by eye (text clipped by the footer bar; a grey placeholder rectangle) and
// two clean:
//   claude-haiku-4-5 : PASS PASS PASS PASS  → blind to both real defects. A gate that always passes
//                                             is worse than no gate; it manufactures false confidence.
//   claude-sonnet-5  : FAIL FAIL PASS PASS  → caught both, named where, and did NOT flag the good ones.
// So the model IS the gate here. Downgrading it silently disables the check without failing anything,
// which is exactly the false-green this workspace keeps getting bitten by. If you change it, re-run
// the negative test in poster-qa.negative.mjs against those four posters first.
export const QA_MODEL = "claude-sonnet-5";
export const MAX_POSTER_ATTEMPTS = 3;

/** Defect classes, each with the phrasing the model is asked to judge. Order is report order. */
export const DEFECT_CHECKS = Object.freeze([
  {
    id: "anatomy",
    question: "Does any character have the wrong number of hands, paws, arms, legs, fingers or eyes, "
      + "or a limb that merges into the body or another limb? A character holding something with one "
      + "paw while pointing with another is NORMAL (two limbs) — only report a genuine extra or "
      + "malformed limb.",
  },
  {
    id: "garbled_text",
    question: "Is there any text made of broken, invented or nonsense characters — letterforms that "
      + "are not real Chinese or Latin characters? Check small text inside buttons and badges "
      + "especially closely; that is where it hides.",
  },
  {
    id: "clipped_text",
    question: "Is any text cut off, running past the image edge, or hidden behind another element "
      + "such as a footer bar or logo strip?",
  },
  {
    id: "placeholder",
    question: "Is there a blank grey/white rectangle, a missing-image box, or an obviously empty "
      + "region where a logo or graphic should be?",
  },
  {
    id: "unreadable",
    question: "Is any main text illegible because it sits on a busy background or has too little "
      + "contrast against what is behind it?",
  },
]);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["defects"],
  properties: {
    defects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "present", "evidence"],
        properties: {
          id: { type: "string" },
          present: { type: "boolean" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

export function buildPrompt(checks = DEFECT_CHECKS) {
  return "You are inspecting a finished social-media poster before it is published to a real client's "
    + "Facebook page. Judge ONLY what you can actually see. Do not speculate, do not comment on taste, "
    + "and do not report a defect you are unsure about — a false alarm costs a regeneration, so answer "
    + "`present: false` when in doubt.\n\n"
    + "For each check, answer whether the defect is PRESENT, and give one short sentence of evidence "
    + "naming where in the image you see it (or why it is absent).\n\n"
    + checks.map((c) => `[${c.id}] ${c.question}`).join("\n\n")
    + "\n\nReturn one entry per check id, in the same order.";
}

/**
 * Turn the model's raw answer into a verdict.
 * Pure — no I/O — so the decision logic is testable without a network or an image.
 */
export function toVerdict(raw, { checks = DEFECT_CHECKS } = {}) {
  // Array.isArray, not `?? []`: a model that returns `defects` as a string or object would otherwise
  // throw inside the QA step and take a whole generation run down with it.
  const answers = Array.isArray(raw?.defects) ? raw.defects : [];
  const byId = new Map(answers.filter((d) => d && typeof d.id === "string").map((d) => [d.id, d]));
  const found = [];
  for (const check of checks) {
    const answer = byId.get(check.id);
    // A check the model did not answer is NOT treated as a defect. Missing coverage is a checker
    // problem, not a poster problem, and inventing failures here would burn paid regenerations.
    if (answer?.present === true) {
      found.push({ id: check.id, evidence: String(answer.evidence ?? "").slice(0, 200) });
    }
  }
  return { pass: found.length === 0, inspected: true, defects: found };
}

export function verdictSummary(verdict) {
  if (!verdict?.inspected) return "not inspected";
  if (verdict.pass) return "clean";
  return verdict.defects.map((d) => `${d.id} (${d.evidence})`).join("; ");
}

/**
 * Should the caller generate this poster again?
 * Only for a real, inspected defect, and only while attempts remain. An uninspected poster is never
 * retried — that would turn a vision-API outage into an expensive regeneration storm.
 */
export function shouldRetry(verdict, attempt, maxAttempts = MAX_POSTER_ATTEMPTS) {
  if (!verdict?.inspected) return false;
  if (verdict.pass) return false;
  return attempt < maxAttempts;
}

/**
 * Inspect one poster file. `ask` is injected so tests never touch the network.
 * Returns { pass, inspected, defects, error? }.
 */
export async function inspectPoster(posterPath, {
  ask,
  read = readFileSync,
  checks = DEFECT_CHECKS,
  mediaType = "image/png",
} = {}) {
  let base64;
  try {
    base64 = read(posterPath).toString("base64");
  } catch (error) {
    // A missing poster is a REAL defect the caller must act on, not an inspection outage.
    return { pass: false, inspected: true, defects: [{ id: "missing_file", evidence: String(error?.message ?? error).slice(0, 200) }] };
  }

  try {
    const raw = await ask({
      prompt: buildPrompt(checks),
      schema: SCHEMA,
      image: { base64, mediaType },
    });
    return toVerdict(raw, { checks });
  } catch (error) {
    // Fail OPEN: the checker being down must not stop four brands publishing.
    return { pass: true, inspected: false, defects: [], error: String(error?.message ?? error).slice(0, 200) };
  }
}
