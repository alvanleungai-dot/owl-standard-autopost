// scripts/lib/poster-regen.mjs — REDRAW one poster from the concept already on disk.
//
// WHY THIS EXISTS
// SCE-PosterQA can tell you a poster is broken; until this module it could not fix one. "Withheld and
// alarmed" still needs a human, and the owner's whole ask was to not be the human. This closes that:
// a rejected poster is redrawn and re-judged automatically, and only reaches him if it fails
// repeatedly.
//
// It redraws the IMAGE ONLY, reusing the caption and concept that were already written and reviewed.
// That is deliberate: the defects the check finds (malformed hands, garbled glyphs, clipped text) are
// all RENDER failures, not writing failures. Rewriting the copy would change something the owner may
// have already read in Telegram, and would spend a language model to fix a drawing problem.
//
// Each brand's generator takes its own arguments — verified against the scripts, not assumed:
//   better-life : gen-poster-v4.mjs <direction> <slug> tl <conceptFile>
//   sunmood     : gen-poster-sunmood-<dir>.mjs <slug> <conceptFile>
//   bright-day  : gen-poster-brightday-<dir>.mjs <slug> <conceptFile>
//   tml         : WIRED 2026-08-04 — not a script, so it is called IN PROCESS. Its two post types
//                 carry everything a redraw needs on the post record itself:
//                   type "edu"  -> genEduPoster(post.topic, post.slug, …)   (gpt-image-2 mascot)
//                   type "case" -> genImage(post.caseData, <poster path>, …) (Gemini before/after)
//                 Verified against scripts/tml/gen-week.mjs, which builds those records. Previously
//                 declared unsupported — correct at the time, but it meant three withheld tml
//                 posters could NEVER self-heal, including one garbled by the missing CJK font that
//                 a redraw now fixes. "It cannot fix itself" is a finding to close, not to report
//                 forever.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { companyStatePath } from "./paths.mjs";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));

export class RegenUnsupportedError extends Error {
  constructor(brand, reason) {
    super(`poster regeneration is not wired for ${brand}: ${reason}`);
    this.name = "RegenUnsupportedError";
    this.code = "REGEN_UNSUPPORTED";
    this.brand = brand;
  }
}

/** Build the exact argv for a brand's poster generator, or throw if that brand is not wired. */
export function regenCommand(brand, post, { conceptPath }) {
  const slug = post.slug;
  switch (brand) {
    // Inherited from better-life's gen-poster-v4.mjs, which was retargeted to Owl Standard's paths.
    // The "infographic" default direction and the "tl" argument come from that script's own CLI.
    case "owl-standard":
      return [p("../gen-poster-v4.mjs"), post.direction || "infographic", slug, "tl", conceptPath, "--no-report", "--force"];
    default:
      throw new RegenUnsupportedError(brand, "unknown brand");
  }
}

/**
 * PURE. What a tml redraw needs, or why it cannot happen. Separated so the decision is testable
 * without touching gpt-image or Gemini.
 */
export function planTmlRegen(post) {
  const type = post?.type;
  if (type === "edu") {
    if (!post.topic) return { ok: false, reason: `edu post ${post?.slug} has no topic on the record — refusing to invent one` };
    return { ok: true, kind: "edu", topic: post.topic };
  }
  if (type === "case") {
    if (!post.caseData) return { ok: false, reason: `case post ${post?.slug} has no caseData on the record — refusing to invent one` };
    return { ok: true, kind: "case", caseData: post.caseData };
  }
  return { ok: false, reason: `unknown tml post type ${JSON.stringify(type ?? null)}` };
}

/** Where this brand keeps the concept text the generator draws from. */
export function conceptPathFor(brand, slug) {
  return companyStatePath(brand, "concepts", `${slug}.txt`);
}

/**
 * Redraw one poster. Returns { ok, reason }.
 * Never throws for an expected condition — the caller is a sweep over many posts and must not die
 * because one brand is unwired or one concept file is missing.
 */
export async function regenerateTmlPoster(post, {
  genEduPoster,
  genImage,
  posterPath = companyStatePath("owl-standard", "posters", `${post?.slug}.png`),
} = {}) {
  const plan = planTmlRegen(post);
  if (!plan.ok) return plan;
  try {
    if (plan.kind === "edu") {
      // force:true — a redraw MUST overwrite the defective poster; report:false so a repair does not
      // re-notify the brand's review channel about a post the owner has already seen.
      await genEduPoster(plan.topic, post.slug, "", { force: true, report: false });
    } else {
      await genImage(plan.caseData, posterPath, { force: true });
    }
    return { ok: true, reason: "redrawn" };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

export async function regeneratePoster(brand, post, {
  run = (argv) => execFileSync(process.execPath, argv, {
    cwd: p("../.."),
    env: { ...process.env, IMG_QUALITY: process.env.IMG_QUALITY || "high" },
    timeout: 6 * 60 * 1000,
    stdio: "pipe",
  }),
  exists = existsSync,
  conceptPath = conceptPathFor(brand, post.slug),
  // tml redraws in process rather than by spawning a script. Imported lazily so the poster modules
  // (and their API keys) are only loaded when a tml post is actually being repaired.
  tmlRegen = async (p2) => regenerateTmlPoster(p2, {
    // tml's in-process generators were deleted with the tenant. Left throwing rather than silently
    // resolving to nothing: no brand currently uses this path (regenCommand handles owl-standard).
    genEduPoster: () => { throw new RegenUnsupportedError("tml", "tml generators were removed with the tenant"); },
    genImage: () => { throw new RegenUnsupportedError("tml", "tml generators were removed with the tenant"); },
  }),
} = {}) {
  if (brand === "tml") return tmlRegen(post);
  if (!exists(conceptPath)) {
    // Without the concept there is nothing to redraw FROM. Rewriting it here would change reviewed
    // copy to fix a drawing defect, so this stops instead.
    return { ok: false, reason: `no concept file at ${conceptPath}` };
  }
  let argv;
  try { argv = regenCommand(brand, post, { conceptPath }); }
  catch (error) { return { ok: false, reason: error.message }; }

  try {
    run(argv);
    return { ok: true, reason: "redrawn" };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}
