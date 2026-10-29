// scripts/lib/content-repair.mjs — REGENERATE one post whose generation failed.
//
// WHY THIS EXISTS (2026-08-04)
//   gen-week.mjs already handles a per-post failure honestly: it catches, records
//   `{ status: "failed", error }`, and exits non-zero so the alarm fires. What nothing did was come
//   back later. The 2026-08-02 Anthropic credit outage left posts marked failed; the credit was
//   restored by 08-04 and they were still failed, still alerting every morning, because the remedy
//   the alert offered was a command for a human to type — and it was the WRONG command besides
//   (`weekly-run.mjs` generates the NEXT week; it does not repair an existing one).
//
// PER-BRAND, LIKE poster-regen.mjs — AND FOR THE SAME REASON
//   The four brands do not share a generator. better-life composes
//   writeCaption → deriveConcept → gen-poster-v4; tml goes through genEduPoster()/genCase()/genImage();
//   sunmood and bright-day use the shared topic-engine with their own poster scripts. poster-regen.mjs
//   met this by wiring what it had verified and DECLARING tml unsupported rather than guessing,
//   because "guessing would silently no-op". Same rule here. An unsupported brand returns a reason
//   the owner can read; it never pretends to have repaired something.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   It does not re-propose a topic. The topic was reserved in the ledger BEFORE generation ran
//   (gen-week reserves first precisely so a crash cannot re-propose), so the failed post's topic is
//   already recorded and is recovered from there. Inventing a new topic would silently change what
//   the week is about and orphan the reserved ledger entry.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));

export class ContentRepairUnsupportedError extends Error {
  constructor(brand, reason) {
    super(`content regeneration is not wired for ${brand}: ${reason}`);
    this.name = "ContentRepairUnsupportedError";
    this.code = "CONTENT_REPAIR_UNSUPPORTED";
    this.brand = brand;
  }
}

// The registry IS the boundary of what may be auto-regenerated. Adding a brand means verifying its
// generator's three steps against the actual script — never inferring them from another brand.
export const CONTENT_REPAIR_REGISTRY = Object.freeze({
  "owl-standard": {
    supported: true,
    note: "writeCaption → deriveConcept → gen-poster-v4.mjs, verified against scripts/owl-standard/gen-week.mjs " +
      "(2026-08-25): that generator calls exactly those three in that order, and regenCommand in poster-regen.mjs " +
      "reproduces its execFileSync argv (direction, slug, \"tl\", conceptPath, --no-report, --force).",
  },
});

export function isContentRepairSupported(brand) {
  return CONTENT_REPAIR_REGISTRY[String(brand || "")]?.supported === true;
}

/**
 * PURE. Recover the topic a failed post was generated FROM.
 * A failed post keeps its `angle` but loses its `title` (gen-week's catch branch does not carry it),
 * so the title comes from the topics ledger, which was written before generation ran and is keyed by
 * the post's slug.
 */
export function topicForBrokenPost(post, ledger = []) {
  const slug = post?.slug;
  if (!slug) return null;
  const entry = (Array.isArray(ledger) ? ledger : []).find((row) => row?.id === slug);
  const title = entry?.title || post?.title;
  if (!title) return null;
  return { title, angle: entry?.angle || post?.angle || "" };
}

/** PURE. The fields a successful repair writes back onto the post. */
export function repairedPostPatch({ post, brand, caption, concept, markerFor }) {
  const patch = {
    title: post.title,
    headline: concept?.headline,
    marker: typeof markerFor === "function" ? markerFor(caption) : undefined,
    caption,
    poster: `companies/${brand}/posters/${post.slug}.png`,
    status: "generated",
    repairedAt: new Date().toISOString(),
  };
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key];
  return patch;
}

/**
 * Regenerate ONE failed better-life post in place.
 * Returns { ok, reason, patch? }. Never throws for an expected condition — the caller sweeps many
 * posts across four brands and must not die because one is unwired or one topic is unrecoverable.
 */
export async function regenerateContent(brand, post, {
  loadLedger,
  writeCaption,
  deriveConcept,
  writeConceptFile,
  markerFor,
  // Injectable like every other dependency here, so the no-topic / failure branches below stay testable
  // even when no real brand is currently marked supported.
  registry = CONTENT_REPAIR_REGISTRY,
  run = (argv, env) => execFileSync(process.execPath, argv, {
    cwd: p("../.."),
    env: { ...process.env, SCE_SUPPRESS_WROTE: "1", IMG_QUALITY: process.env.IMG_QUALITY || "medium", ...env },
    timeout: 6 * 60 * 1000,
    stdio: "pipe",
  }),
} = {}) {
  const spec = registry[brand];
  if (!spec) return { ok: false, reason: `unknown brand ${brand}` };
  if (!spec.supported) return { ok: false, reason: spec.reason, unsupported: true };

  let topic;
  try { topic = topicForBrokenPost(post, loadLedger()); }
  catch (error) { return { ok: false, reason: `topics ledger unreadable: ${error?.message || error}` }; }
  if (!topic) {
    // Without the reserved topic there is nothing to regenerate FROM, and inventing one would change
    // what the week is about. Stop, exactly as poster-regen stops on a missing concept file.
    return { ok: false, reason: `no reserved topic in the ledger for ${post?.slug} — refusing to invent one` };
  }

  try {
    const caption = await writeCaption({ ...topic, publishDate: post?.date });
    const concept = await deriveConcept(topic, caption);
    const conceptPath = writeConceptFile(post.slug, concept);
    run(
      [p("../gen-poster-v4.mjs"), post.direction || "infographic", post.slug, "tl", conceptPath, "--no-report", "--force"],
      {},
    );
    return {
      ok: true,
      reason: "regenerated from the reserved topic",
      patch: repairedPostPatch({ post: { ...post, title: topic.title }, brand, caption, concept, markerFor }),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}
