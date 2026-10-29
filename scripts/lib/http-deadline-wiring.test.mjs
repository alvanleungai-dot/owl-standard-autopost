import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This list originally also covered the four divorce tenants' per-brand scripts (sunmood/bright-day/
// tml/better-life). This checkout was pruned to Owl Standard only (see companies/ and scripts/<tenant>/
// deletions) — those files no longer exist, so they were removed from this list rather than left as
// permanently-failing dead references. The surviving entries are shared engine code Owl Standard's own
// scripts (scripts/owl-standard/*) will also route through, so the regression check still has teeth.
const deadlineRouted = [
  "./meta-dedup.mjs",
  "../preflight.mjs",
  "../catchup.mjs",
  "./anthropic.mjs",
  "./fb-token-probe.mjs",
  "./fb-cancel.mjs",
  // gen-poster-v4.mjs no longer makes HTTP calls itself — it delegates to the pluggable image
  // backend, so the raw-fetch guard now points at where the fetch actually happens.
  "./image-backend.mjs",
];

test("publish and enabled-job HTTP sites cannot regress to raw fetch", () => {
  for (const relative of deadlineRouted) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /\b(?:await\s+(?:\(await\s+)?)?fetch\s*\(/, relative);
    assert.match(source, /fetchWithDeadline/, relative);
  }
});
