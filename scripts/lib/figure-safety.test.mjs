import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SAFE_POSES, ANATOMY_RULE, HUMAN_ANATOMY_RULE, constrainPose, stableIndex, poseMenu,
} from "./figure-safety.mjs";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ── the whitelist is the prevention, so its CONTENT is the thing to assert ───────────────────────
// Both anatomy defects measured on 2026-08-04 were hand-forward poses: a paw raised near the mouth,
// and an outstretched arm. Those configurations must not be on the menu at all.

test("no safe pose raises a paw to the face, splays fingers, or reaches out", () => {
  assert.ok(SAFE_POSES.length >= 4, "too few poses and every poster looks identical");
  for (const pose of SAFE_POSES) {
    assert.doesNotMatch(pose, /finger/i, `${pose}: fingers are the most defect-prone thing to draw`);
    // Target a paw AT the face, not the word "face" — "friendly expression" and "facing the viewer"
    // are fine; "paw near its mouth" is the defect. A blunter regex banned a harmless expression.
    // \b on the body part too: without it, "desk sur-FACE" matched and failed a perfectly safe pose.
    assert.doesNotMatch(pose, /(paw|hand|arm)[^,]*\b(near|to|at|on)\b[^,]*\b(face|mouth|chin|head)\b/i,
      `${pose}: a paw at the face occludes and merges`);
    assert.doesNotMatch(pose, /outstretch|reaching|raised|pointing|waving|holding up/i, `${pose}: reaching limbs elongate`);
    assert.doesNotMatch(pose, /magnifying|holding a|carrying/i, `${pose}: an object in a raised paw crosses two limbs`);
  }
});

test("every pose says where BOTH paws are — an unspecified paw is an invented paw", () => {
  for (const pose of SAFE_POSES) {
    assert.match(pose, /both paws|one paw .*the other|paws (relaxed|resting|tucked)/i, `${pose}: must place both paws`);
  }
});

test("the anatomy rule states the count, the shape and the separation", () => {
  assert.match(ANATOMY_RULE, /EXACTLY two arms/);
  assert.match(ANATOMY_RULE, /ONE simple rounded paw/);
  assert.match(ANATOMY_RULE, /do NOT draw separated or splayed/i);
  assert.match(ANATOMY_RULE, /no limb may merge/i);
  assert.match(ANATOMY_RULE, /third arm/i);
  // the human variant must NOT tell a photographic person to have mitten paws
  assert.match(HUMAN_ANATOMY_RULE, /five fingers per hand/);
  assert.doesNotMatch(HUMAN_ANATOMY_RULE, /mitten|paw/i);
});

// ── enforcement: requesting a whitelist is not the same as having one ────────────────────────────

test("an exact whitelist pose passes through untouched", () => {
  const r = constrainPose(SAFE_POSES[2], "2026-09-14-01");
  assert.equal(r.pose, SAFE_POSES[2]);
  assert.equal(r.substituted, false);
});

test("a whitelist pose wrapped in extra wording is still accepted", () => {
  const r = constrainPose(`The bear is ${SAFE_POSES[0]}, looking cheerful`, "s");
  assert.equal(r.pose, SAFE_POSES[0]);
  assert.equal(r.substituted, false);
});

test("NEGATIVE: an invented pose is SUBSTITUTED, not passed to the image model", () => {
  const invented = "examining items with its magnifying glass, curious friendly face";
  const r = constrainPose(invented, "2026-08-24-01");
  assert.equal(r.substituted, true);
  assert.ok(SAFE_POSES.includes(r.pose), "must land on the whitelist");
  assert.equal(r.proposed, invented, "and report what it rejected, so the substitution is visible");
  assert.notEqual(r.pose, invented);
});

test("NEGATIVE: empty/garbage input still yields a usable safe pose", () => {
  for (const bad of ["", null, undefined, 42, {}]) {
    const r = constrainPose(bad, "s");
    assert.ok(SAFE_POSES.includes(r.pose), `${JSON.stringify(bad)} must still produce a pose`);
    assert.equal(r.substituted, true);
  }
});

test("the fallback is DETERMINISTIC — the same post regenerates the same pose", () => {
  const a = constrainPose("nonsense", "2026-08-24-01").pose;
  const b = constrainPose("something else entirely", "2026-08-24-01").pose;
  assert.equal(a, b, "a redraw must not roll the dice again on the pose");
  // ...and different posts still differ, or every poster looks the same
  const slugs = ["a-01", "b-02", "c-03", "d-04", "e-05", "f-06", "g-07", "h-08"];
  assert.ok(new Set(slugs.map((s) => constrainPose("x", s).pose)).size > 1, "poses must vary across posts");
  assert.equal(stableIndex("same", 6), stableIndex("same", 6));
  assert.equal(stableIndex("anything", 0), 0);
});

test("the pose menu lists every safe pose for the concept model to choose from", () => {
  const menu = poseMenu();
  for (const pose of SAFE_POSES) assert.ok(menu.includes(pose), `${pose} missing from the menu`);
});

// ── wiring: the rule has to reach the actual image prompts ───────────────────────────────────────

// The "TML asks for a whitelist pose" test was removed: it read ../tml/gen-edu-poster.mjs (TML's mascot
// -bear poster generator), deleted in the prune to Owl Standard. The mascot pose whitelist it guarded is
// TML-specific; Owl Standard has no mascot. constrainPose/SAFE_POSES are still unit-tested above, and the
// HUMAN anatomy rule Owl Standard's poster generator will use is covered by the next test.

test("Better Life states the HUMAN anatomy rule wherever it constrains people", () => {
  const s = src("../gen-poster-v4.mjs");
  assert.match(s, /HUMAN_ANATOMY_RULE/);
  // it must be part of the prompt actually sent, not just imported
  assert.match(s, /NOT AI-looking\. " \+ HUMAN_ANATOMY_RULE/);
});

test("the image check still hunts anatomy — prevention does not replace the net", () => {
  const s = src("./poster-qa.mjs");
  assert.match(s, /id: "anatomy"/, "prevention reduces the rate; it cannot be trusted to eliminate it");
});
