// gen-poster-v4.mjs — Better Life poster generator (gpt-image-2).
// CHANGE vs v3 (owner feedback 2026-06-11):
//   - NO white top bar. The artwork is FULL-BLEED; we only ask the model to keep the
//     TOP-LEFT corner a plain, softly-lit LIGHT area so a dark logo reads with contrast.
//   - REAL logo, transparent background, ORIGINAL colours (no white knockout, no shadow).
//   - Logo sits TOP-LEFT, smaller.
//
// "direction" = LAYOUT only. The visual SUBJECT comes from `concept` (varies per post).
//
// Usage:
//   node scripts/gen-poster-v4.mjs <direction> <outName> [corner] [conceptFile] [model]
//   direction   = few-words | infographic | cartoon
//   outName     = file stem under companies/owl-standard/posters/
//   corner      = tl | tr | bl | br   (default tl)
//   conceptFile = UTF-8 .txt: line1 = headline, rest = scene concept (optional)
//   model       = force an image model (default: gpt-image-2 chain)
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { companyConfigPath, companyStatePath, ensureStateParent } from "./lib/paths.mjs";
import { assertArtifactsWritable, wroteLine } from "./lib/artifacts.mjs";
import { generateImage } from "./lib/image-backend.mjs";
import { ensureCjkFont } from "./lib/fonts.mjs";
import { HUMAN_ANATOMY_RULE } from "./lib/figure-safety.mjs";

// The footer is SVG text rendered by sharp via fontconfig. Configure the shipped CJK font HERE so a
// direct run is never silently different from one spawned by the worker — the ordering bug that let
// a redraw reproduce the exact garbling it was repairing (2026-08-04).
ensureCjkFont();

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// ---- args ----
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const force = process.argv.includes("--force");
const direction = (args[0] || "few-words").toLowerCase();
const outName = args[1] || "test";
const corner = (args[2] || "tl").toLowerCase();
const conceptFile = args[3];
const modelOverride = args[4];
const outPath = companyStatePath("owl-standard", "posters", `${outName}.png`);
// Check before credential parsing or paid generation: duplicate output must be a no-op failure.
assertArtifactsWritable([outPath], { force });

// Credentials are validated by the selected backend (lib/image-backend.mjs), which knows which env
// vars its own provider needs and fails closed with a named cause.

// ---- per-post headline + concept (varied imagery; override via conceptFile) ----
// Fallbacks only — a real run always passes a conceptFile written by derive-concept.mjs.
let headline = "「合規之前，先搞清楚你個單位」";
let concept = {
  "few-words": "bright morning daylight through a window of a tidy, compliant Hong Kong subdivided residential unit — clean partition wall, a visible smoke detector, calm and orderly, NO people",
  "infographic": "a clean, orderly interior of a compliant Hong Kong subdivided unit — measured floor space, tidy partition wall, fire door, neat utility meters — professional and reassuring",
  "cartoon": "a warm flat-illustration scene of a Hong Kong landlord reviewing a floor plan of a subdivided unit with a consultant — calm, organised, professional",
}[direction] || "a calm, orderly, premium interior scene";
if (conceptFile && existsSync(conceptFile)) {
  const lines = readFileSync(conceptFile, "utf8").split(/\r?\n/);
  headline = lines[0].trim() || headline;
  const rest = lines.slice(1).join(" ").trim();
  if (rest) concept = rest;
}

// ---- realism: only constrains people IF they appear ----
const REALISM =
  "If any person appears, they must look like a REAL human candidly photographed on an iPhone: natural skin " +
  "texture and pores, real everyday lighting, true-to-life. NOT glossy, NOT plastic, NOT waxy, NOT airbrushed, " +
  "NOT a 3D render, NOT CGI, NOT AI-looking. " + HUMAN_ANATOMY_RULE;

// ---- NEW brand/layout: full-bleed, plain LIGHT top-left corner for a dark logo, no white bands ----
const BRAND =
  // Owl Standard palette, from companies/owl-standard/company.md assets.brand_colors (which mirror the
  // website's own --os-* tokens): paper #FDF8F0, accent orange #EA6321, ink #14201c, muted #5B6864.
  "Brand colours: warm off-white paper (#FDF8F0) + deep charcoal-green ink (#14201c) + a vivid ORANGE accent " +
  "(#EA6321). Put the key phrase of the headline in that ORANGE. Use orange sparingly, as an accent only — " +
  "never as a large background fill. " +
  "FULL-BLEED artwork: the scene fills the entire frame edge-to-edge. Do NOT add any white or empty borders, bands, " +
  "or letterboxing anywhere. " +
  "RESERVE the TOP-LEFT corner (about the top 14% of the height across the left ~55% of the width) as a CLEAN, PLAIN, " +
  "softly-lit LIGHT area — e.g. bright sky, a pale wall, or soft out-of-focus light — uncluttered, with no busy detail " +
  "and no text — so the logo placed there reads with strong contrast. " +
  "Do NOT draw any logo, brand mark, company name, watermark, or footer text — a real logo and footer are composited " +
  "afterwards. Keep the headline and all content BELOW that top-left logo zone. RESERVE the bottom ~18% as EMPTY space " +
  "for a footer added afterwards: do NOT place any pull-quote, card, headline, or text in that bottom band, and put any " +
  "pull-quote in the lower-middle with clear space beneath it, never touching the bottom edge. " +
  // Compliance rules mirrored from companies/owl-standard/company.md — the poster is a published surface too,
  // so the same red lines that scripts/write-caption.mjs enforces on captions apply to rendered text here.
  "HARD RULES for any Traditional Chinese text rendered in the poster: NEVER write 「5年」 for the certification " +
  "validity (it is 「60個月」); NEVER name 「屋宇署」 as the certifying authority (it is 「房屋局」); NEVER write " +
  "「包過」、「保證通過」、「政府認可」 or any wording that guarantees an outcome or implies government endorsement. " +
  "Tone: corporate, premium, professional, trustworthy, calm — a senior compliance consultant, not a hard sell. " +
  "Vertical social poster for a Hong Kong 簡樸房 (Basic Housing Unit) compliance consultancy. " +
  "All Traditional Chinese text must be perfect and legible.";

const LAYOUTS = {
  "few-words":
    `Direction: FEWER WORDS — minimal. Hero visual: ${concept}. ` +
    `One bold Traditional Chinese headline ${headline} (key phrase in the orange accent) in the upper-middle area + ONE short subline. ` +
    `The visual carries the emotion; keep text minimal. ${REALISM}`,
  "infographic":
    `Direction: INFOGRAPHIC. Hero visual at the top: ${concept}. Compose the hero so the very TOP-LEFT corner stays a ` +
    `bright, plain, light area (e.g. soft window light or a pale wall) — NOT the subject's body, hair, or any dark tone. ` +
    `Headline ${headline}, then a horizontal row of FOUR dark cards, each an ORANGE icon + one-line Traditional Chinese ` +
    `label for the post's key points. Below the cards add a short orange pull-quote that sits FULLY ABOVE the bottom 13% ` +
    `with clear empty space beneath it — the pull-quote must NOT touch, overlap, or run under the bottom edge. ${REALISM}`,
  "cartoon":
    `Direction: FLAT COMMERCIAL ART — a friendly, modern flat vector illustration (NOT a photo). Scene: ${concept}. ` +
    `Headline ${headline}, then a row of FOUR simple labelled icon cards for the post's key points, ` +
    `and a short orange pull-quote with clear space above the bottom margin (do not let it touch the bottom edge).`,
};
if (!LAYOUTS[direction]) { console.log(`Unknown direction: ${direction}`); process.exit(1); }
const prompt = `Create a good-looking vertical poster to be posted on Facebook. ${LAYOUTS[direction]} ${BRAND}`;

// ---- generate artwork (text-to-image; no logo input => model cannot draw a 2nd logo) ----
// Backend is pluggable: IMAGE_BACKEND=higgsfield (default) | openai. See lib/image-backend.mjs for why
// both exist — these posters render Traditional Chinese inside the image, and that is the deciding
// factor between them.
let artBuf, model;
try {
  ({ buffer: artBuf, model } = await generateImage({
    prompt, width: 1024, height: 1536, label: outName, modelOverride,
  }));
} catch (e) {
  console.log(`Image generation failed: ${e.message}`);
  process.exit(1);
}

// ---- one-time: build a TRANSPARENT logo that KEEPS its real colours (white bg -> transparent) ----
const logoSrc = companyConfigPath("owl-standard", "assets", "logo.png");
const logoDark = companyStatePath("owl-standard", "derived", "logo-dark.png");
if (!existsSync(logoDark)) {
  ensureStateParent(logoDark);
  const { data, info } = await sharp(logoSrc).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    // near-white background -> fully transparent; everything else keeps its original colour
    if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) data[i + ch - 1] = 0;
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).png().toFile(logoDark);
  console.log("Built transparent logo -> assets/logo-dark.png");
}

// ---- compose: artwork sits ENTIRELY ABOVE the footer band (footer can NEVER overlap content) ----
const W = 1122, H = 1402, PAD = 40, LOGO_H = 64, FOOT_H = 140;
const ART_H = H - FOOT_H; // artwork region height; footer occupies its own band below it
const art = await sharp(artBuf)
  .resize(W, ART_H, { fit: "cover", position: "centre" }).png().toBuffer();

const logoBuf = await sharp(logoDark).resize({ height: LOGO_H }).png().toBuffer();
const lm = await sharp(logoBuf).metadata();

const at = {
  tl: { top: PAD, left: PAD },
  tr: { top: PAD, left: W - PAD - lm.width },
  bl: { top: H - FOOT_H - PAD - lm.height, left: PAD },
  br: { top: H - FOOT_H - PAD - lm.height, left: W - PAD - lm.width },
}[corner] || { top: PAD, left: PAD };

const footerSvg = Buffer.from(
  `<svg width="${W}" height="${FOOT_H}" xmlns="http://www.w3.org/2000/svg">
     <rect width="${W}" height="${FOOT_H}" fill="#14201c"/>
     <rect width="${W}" height="5" fill="#EA6321"/>
     <text x="${PAD}" y="${FOOT_H / 2 + 4}" text-anchor="start" dominant-baseline="middle"
           font-family="Microsoft JhengHei, PingFang TC, Noto Sans TC, Noto Sans CJK TC, sans-serif"
           font-size="40" font-weight="700" fill="#ffffff" letter-spacing="2">Owl Standard 簡樸房認證</text>
     <text x="${W - PAD}" y="${FOOT_H / 2 + 4}" text-anchor="end" dominant-baseline="middle"
           font-family="Microsoft JhengHei, PingFang TC, Noto Sans TC, Noto Sans CJK TC, sans-serif"
           font-size="38" font-weight="700" fill="#EA6321" letter-spacing="3">一站式業主管理服務</text>
   </svg>`
);

ensureStateParent(outPath);
await sharp({ create: { width: W, height: H, channels: 4, background: { r: 20, g: 32, b: 28, alpha: 1 } } })
  .composite([
    { input: art, top: 0, left: 0 },          // artwork fills the region ABOVE the footer
    { input: footerSvg, top: ART_H, left: 0 }, // footer in its own band — no overlap possible
    { input: logoBuf, top: at.top, left: at.left },
  ])
  .png()
  .toFile(outPath);

if (!process.argv.includes("--no-report")) console.log(wroteLine(outPath));
console.log(`✅ [${direction}] -> companies/owl-standard/posters/${outName}.png (1122x1402, model: ${model}, logo: real+transparent ${corner})`);
