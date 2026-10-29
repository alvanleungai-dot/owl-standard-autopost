// scripts/lib/fonts.mjs — make a Traditional-Chinese font available to sharp's SVG text renderer.
//
// THE DEFECT THIS FIXES (root-caused 2026-08-04)
//   SCE-PosterQA kept withholding better-life posters for `garbled_text`, describing "rows of boxed
//   hexadecimal-looking codes (e.g. '76 90 52 96 5A 4E 52 62')" in the bottom bar. Those hex values
//   are the CODE POINTS of 百達利離婚事務所 — the footer text — drawn as tofu boxes because the
//   container has no font that can render them.
//
//   gen-poster-v4.mjs composites its footer as an SVG string, and sharp renders SVG text through
//   librsvg/pango/fontconfig. The font stack it asks for is
//     "Microsoft JhengHei, PingFang TC, Noto Sans CJK TC, sans-serif"
//   — Windows, macOS, and a Linux family that is only present IF INSTALLED. The Render build command
//   is `npm ci && npx playwright install chromium`: Chromium only, no fonts, and `--with-deps` cannot
//   run there (needs root, refused — see _ops/RUNBOOK.md).
//
//   So this was a CLOUD-MIGRATION REGRESSION, invisible on the machine it was written on: the posters
//   rendered correctly on Windows, where Microsoft JhengHei exists, and have been garbled since the
//   move to Render. Two things then compounded it. The image check caught it — correctly — but its
//   auto-redraw retried a DETERMINISTIC environmental failure, so every redraw reproduced the identical
//   garbling, the posters stayed withheld forever, and the futile redraw loops are what pushed
//   SCE-PosterQA past its 20-minute ceiling. And the alert the owner received blamed the API
//   ("修好 API 後重新生成"), which was never involved.
//
// THE FIX
//   Ship the font WITH the repo (OFL-licensed Noto Sans TC) and point fontconfig at it. No root, no
//   apt-get, no build-command change, no network call at run time — the failure mode of each of those
//   is a green build that still cannot draw Chinese.
//
//   The generated config INCLUDES the system config rather than replacing it, or every Latin font
//   would disappear along with the problem.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, runtimePath } from "./paths.mjs";

export const FONT_FILE = "NotoSansTC-Bold.ttf";
// The family name fontconfig will report for the shipped file. NOT "Noto Sans CJK TC" — that is a
// different family, and asking for a name nothing provides is how this bug looked fine in code review.
export const CJK_FAMILY = "Noto Sans TC";
// The full stack to use in SVG: local dev machines first, then the family we actually ship.
export const CJK_FONT_STACK = `Microsoft JhengHei, PingFang TC, ${CJK_FAMILY}, Noto Sans CJK TC, sans-serif`;

export function fontDir() {
  return configPath("assets", "fonts");
}

export function fontIsShipped({ exists = existsSync } = {}) {
  return exists(join(fontDir(), FONT_FILE));
}

/** PURE. The fontconfig document — separated so a test can assert its shape without touching disk. */
export function buildFontConfig(dir, cacheDir) {
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <!-- Keep the system fonts. Replacing rather than extending the system config would fix Chinese
       by breaking every Latin glyph on the same poster. -->
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${dir}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;
}

/**
 * Point fontconfig at the shipped font for THIS process and every child it spawns.
 *
 * Called once at worker boot: the poster generators run as descendants of the worker
 * (worker → weekly-run → gen-week → gen-poster) and every hop passes process.env through, so one
 * call at the top covers the whole cloud path. Also called directly by the generators, so a local
 * one-off run is not silently different from the cloud.
 */
export function ensureCjkFont({ env = process.env, log = () => {} } = {}) {
  if (!fontIsShipped()) {
    return { ok: false, reason: `${FONT_FILE} is not in ${fontDir()} — Chinese text will render as boxes` };
  }
  if (env.FONTCONFIG_FILE && existsSync(env.FONTCONFIG_FILE)) {
    return { ok: true, reason: "already configured", file: env.FONTCONFIG_FILE, reused: true };
  }
  try {
    const confDir = runtimePath("fontconfig");
    const cacheDir = join(confDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const file = join(confDir, "fonts.conf");
    writeFileSync(file, buildFontConfig(fontDir(), cacheDir), "utf8");
    env.FONTCONFIG_FILE = file;
    env.FONTCONFIG_PATH = confDir;
    log(`fonts: fontconfig -> ${file} (family "${CJK_FAMILY}" from ${fontDir()})`);
    return { ok: true, reason: "configured", file };
  } catch (error) {
    return { ok: false, reason: `could not write fontconfig: ${error?.message || error}` };
  }
}
