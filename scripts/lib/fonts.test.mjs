// The test that would have caught the garbled posters.
//
// It renders Chinese text through the SAME path the posters use — sharp compositing an SVG <text>
// element — and asserts the result differs from rendering with a font family that does not exist.
// If no CJK font is reachable, both renders fall back to the same tofu boxes, the images are
// identical, and this fails. That is the surface that matters: not "is a file present" but "can this
// process actually draw 百達利離婚事務所".
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  FONT_FILE, CJK_FAMILY, CJK_FONT_STACK, buildFontConfig, fontDir, fontIsShipped, ensureCjkFont,
} from "./fonts.mjs";

const SAMPLE = "百達利離婚事務所";

const renderWith = (family) => sharp(Buffer.from(
  `<svg width="520" height="80" xmlns="http://www.w3.org/2000/svg">` +
  `<rect width="520" height="80" fill="#000000"/>` +
  `<text x="10" y="55" font-family="${family}" font-size="40" font-weight="700" fill="#ffffff">${SAMPLE}</text>` +
  `</svg>`,
)).png().toBuffer();

test("the CJK font is SHIPPED WITH THE REPO, not assumed present on the host", () => {
  assert.equal(fontIsShipped(), true, `${FONT_FILE} must be committed — the Render container installs no fonts`);
  const bytes = readFileSync(join(fontDir(), FONT_FILE));
  assert.ok(bytes.length > 1_000_000, "a real CJK font is megabytes; a stub would pass a file-exists check and still garble");
  // A valid sfnt/TrueType header — catches an HTML error page saved under a .ttf name.
  assert.equal(bytes.subarray(0, 4).toString("hex"), "00010000");
});

test("the font stack names the family we actually ship", () => {
  assert.match(CJK_FONT_STACK, new RegExp(CJK_FAMILY));
  assert.equal(CJK_FAMILY, "Noto Sans TC");
  assert.notEqual(CJK_FAMILY, "Noto Sans CJK TC", "a different family — asking for a name nothing provides is the original bug");
});

test("every poster SVG font stack includes the shipped family", () => {
  const files = [
    "../gen-poster-v3.mjs", "../gen-poster-v4.mjs", "../tml/gen-edu-poster.mjs",
    "../bright-day/gen-poster-brightday.mjs", "../bright-day/gen-poster-brightday-red.mjs",
    "../bright-day/gen-poster-brightday-editorial.mjs",
  ];
  for (const rel of files) {
    const path = new URL(rel, import.meta.url);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    if (!/font-family|const SANS/.test(source)) continue;
    assert.match(source, /Noto Sans TC/, `${rel} must name the family the repo ships, or its Chinese renders as boxes`);
  }
});

// THE ORDERING BUG (2026-08-04). ensureCjkFont sat inside startSchedulerAndBots(), which runs AFTER
// triggerRunOnce — so a RUN_JOB_ONCE=SCE-PosterQA started 55ms before the font environment existed,
// redrew a poster without it, and reported the identical garbling it was sent to repair. A guard in
// the right file at the wrong LINE is not a guard.
test("the worker configures fonts BEFORE it can trigger a one-shot job", () => {
  const source = readFileSync(new URL("../render-worker.mjs", import.meta.url), "utf8");
  const fontCall = source.indexOf("ensureCjkFont({");
  const runOnce = source.indexOf("triggerRunOnce(");
  assert.ok(fontCall > 0, "render-worker must configure the CJK font");
  assert.ok(runOnce > 0, "render-worker must still trigger one-shot jobs");
  assert.ok(fontCall < runOnce, "fonts must be configured before ANY job can spawn, or the job inherits an env without them");
});

test("the poster sweep configures fonts itself, not trusting its parent", () => {
  const source = readFileSync(new URL("../poster-qa-sweep.mjs", import.meta.url), "utf8");
  assert.match(source, /ensureCjkFont/, "the sweep spawns redraws with ITS env — a missing font here makes every redraw futile");
  const call = source.indexOf("ensureCjkFont({");
  const firstBrandLoop = source.indexOf("for (const brand of brands)");
  assert.ok(call > 0 && call < firstBrandLoop, "must be configured before any poster is judged or redrawn");
});

test("the poster generator configures fonts itself, so a direct run matches the worker's", () => {
  const source = readFileSync(new URL("../gen-poster-v4.mjs", import.meta.url), "utf8");
  assert.match(source, /ensureCjkFont\(\)/);
});

test("the generated fontconfig EXTENDS the system config instead of replacing it", () => {
  const conf = buildFontConfig("/repo/assets/fonts", "/state/fontconfig/cache");
  assert.match(conf, /<include ignore_missing="yes">\/etc\/fonts\/fonts\.conf<\/include>/,
    "replacing the system config would fix Chinese by breaking every Latin glyph on the same poster");
  assert.match(conf, /<dir>\/repo\/assets\/fonts<\/dir>/);
  assert.match(conf, /<cachedir>\/state\/fontconfig\/cache<\/cachedir>/);
});

test("ensureCjkFont exports FONTCONFIG_FILE so spawned generators inherit it", () => {
  const env = {};
  const result = ensureCjkFont({ env });
  assert.equal(result.ok, true, result.reason);
  assert.ok(env.FONTCONFIG_FILE, "child processes read this from the environment they inherit");
  assert.ok(existsSync(env.FONTCONFIG_FILE));
});

// ── the real surface ─────────────────────────────────────────────────────────────────────────────

test("sharp can actually DRAW Chinese with the shipped family", async (t) => {
  // PLATFORM: this test discriminates by asking for a family that does not exist and requiring a
  // DIFFERENT image. That only works where fontconfig resolves families — i.e. the Linux container this
  // guard exists for. On Windows, DirectWrite silently substitutes the same system CJK fallback for BOTH
  // family names, so the two renders come back byte-identical and the assertion below fails even though
  // the shipped font is present and correct. Skipping keeps the guard honest on Render instead of
  // weakening it into something that passes everywhere and proves nothing.
  if (process.platform === "win32") {
    return t.skip("fontconfig-based family resolution is not the Windows font path; this guard targets the Linux container");
  }
  const env = {};
  const configured = ensureCjkFont({ env });
  if (!configured.ok) return t.skip(configured.reason);
  // fontconfig reads this at first text render in THIS process.
  process.env.FONTCONFIG_FILE = env.FONTCONFIG_FILE;
  process.env.FONTCONFIG_PATH = env.FONTCONFIG_PATH;

  // ONLY the shipped family — no OS fallbacks. Testing the full stack would pass on a Windows dev
  // machine via Microsoft JhengHei and prove nothing about the container where this actually broke.
  const withFont = await renderWith(CJK_FAMILY);
  const withNothing = await renderWith("ThisFamilyDoesNotExistAnywhere");

  const inked = async (buf) => {
    const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    return data.reduce((n, v) => n + (v > 40 ? 1 : 0), 0);
  };
  const drawn = await inked(withFont);
  assert.ok(drawn > 200, `expected real glyphs to put ink on the canvas, got ${drawn} lit pixels`);

  // THE NEGATIVE HALF: if no CJK font were reachable, the "with font" render would fall back to the
  // same tofu boxes as the nonsense family and these would be byte-identical. They must differ.
  assert.notEqual(
    withFont.equals(withNothing), true,
    "rendering with the shipped family produced the SAME image as an unknown family — the font is not reaching sharp, which is exactly the garbled-poster defect",
  );
});
