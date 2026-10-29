// scripts/contact-sheet.mjs — export EVERY upcoming post across all four brands to one reviewable place.
//
// WHY THIS EXISTS
// Posters live on the Render worker's disk, which the owner cannot open, and the review bots deliver
// them to FOUR SEPARATE Telegram chats. Reviewing ~20 upcoming posts therefore meant hopping between
// four conversations with no way to see a brand's month at a glance. This uploads each upcoming
// poster to Cloudinary and prints ONE json manifest line per post, so a single gallery page can be
// built from the log without anyone needing shell access to the worker.
//
// READ-ONLY with respect to publishing: it never sets a status, never touches Facebook or Instagram,
// and never changes a week file. The only side effect is a Cloudinary upload into a review folder.
//
//   node scripts/contact-sheet.mjs            # all brands, all future-dated posts
//   node scripts/contact-sheet.mjs --brand=tml
import crypto from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import sharp from "sharp";
import { getEnv } from "./lib/env.mjs";
import { companyArtifactPath, companyStatePath } from "./lib/paths.mjs";
import { fetchWithDeadline, MEDIA_HTTP_TIMEOUT_MS } from "./lib/http-deadline.mjs";
import { hkTodayStr, postDate } from "./lib/watchdog-core.mjs";

if (process.env.SCE_IMPORT_ONLY === "1") process.exit(0);

const CLOUD = getEnv("CLOUDINARY_CLOUD_NAME");
const CKEY = getEnv("CLOUDINARY_API_KEY");
const CSECRET = getEnv("CLOUDINARY_API_SECRET");
if (!CLOUD || !CKEY || !CSECRET) { console.log("contact-sheet: Cloudinary credentials missing; nothing to do."); process.exit(0); }

const BRANDS = ["owl-standard"];
const only = process.argv.find((a) => a.startsWith("--brand="))?.slice("--brand=".length);
const brands = only ? BRANDS.filter((b) => b === only) : BRANDS;
const now = Date.now();
const today = hkTodayStr(now);

async function upload(brand, slug, file) {
  // Flattened to JPEG: the posters are large PNGs and this is a review thumbnail, not the asset that
  // gets published. The published image is always re-read from disk by the real publisher.
  const jpeg = await sharp(readFileSync(file)).flatten({ background: "#ffffff" })
    .resize(760, null, { withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  const folder = `review/${brand}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash("sha1").update(`folder=${folder}&public_id=${slug}&timestamp=${ts}${CSECRET}`).digest("hex");
  const fd = new FormData();
  fd.append("file", `data:image/jpeg;base64,${jpeg.toString("base64")}`);
  fd.append("folder", folder);
  fd.append("public_id", slug);
  fd.append("api_key", CKEY);
  fd.append("timestamp", String(ts));
  fd.append("signature", sig);
  const up = await (await fetchWithDeadline(
    `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`,
    { method: "POST", body: fd },
    { timeoutMs: MEDIA_HTTP_TIMEOUT_MS, label: `contact-sheet upload ${brand}/${slug}` },
  )).json();
  if (!up.secure_url) throw new Error(`cloudinary: ${JSON.stringify(up).slice(0, 160)}`);
  return up.secure_url;
}

let ok = 0, missing = 0, failed = 0;
console.log("CONTACT_SHEET_BEGIN");
for (const brand of brands) {
  const weeksDir = companyStatePath(brand, "weeks");
  if (!existsSync(weeksDir)) continue;
  for (const f of readdirSync(weeksDir).filter((x) => x.endsWith(".json") && !x.startsWith("_")).sort()) {
    let week;
    try { week = JSON.parse(readFileSync(`${weeksDir}/${f}`, "utf8")); } catch { continue; }
    for (const post of week.posts || []) {
      const date = postDate(post, now);
      if (!date || date < today) continue;                       // upcoming work only
      const posterRef = post.poster || `companies/${brand}/posters/${post.slug}.png`;
      const file = companyArtifactPath(brand, posterRef);
      if (!existsSync(file)) {
        missing += 1;
        console.log(`CONTACT_SHEET_ITEM ${JSON.stringify({ brand, week: f.replace(/\.json$/, ""), date, slug: post.slug, status: post.status ?? null, headline: post.headline || post.topic || "", booked: Boolean(post.fbPostId), url: null, note: "poster file missing" })}`);
        continue;
      }
      try {
        const url = await upload(brand, post.slug, file);
        ok += 1;
        console.log(`CONTACT_SHEET_ITEM ${JSON.stringify({ brand, week: f.replace(/\.json$/, ""), date, slug: post.slug, status: post.status ?? null, headline: post.headline || post.topic || "", booked: Boolean(post.fbPostId), url })}`);
      } catch (error) {
        failed += 1;
        console.log(`CONTACT_SHEET_ITEM ${JSON.stringify({ brand, week: f.replace(/\.json$/, ""), date, slug: post.slug, status: post.status ?? null, headline: post.headline || post.topic || "", booked: Boolean(post.fbPostId), url: null, note: String(error?.message || error).slice(0, 140) })}`);
      }
    }
  }
}
console.log(`CONTACT_SHEET_END ok=${ok} missingPoster=${missing} failed=${failed}`);
