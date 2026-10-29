// scripts/owl-standard/api-ig-daily.mjs — publish to Instagram the Owl Standard post that is due today.
// IG can't native-schedule, so this runs daily at 10:05 HK and MIRRORS the Facebook schedule: a post
// goes to IG only on its own day (or the day after, to recover a missed run), only when approved, and
// only once Facebook has it booked (lib/publishable.mjs instagramDue). Idempotent (records igPostId).
// Uploads to a per-brand Cloudinary folder + deletes after IG ingests.
//   node api-ig-daily.mjs --dry   # show what's due, post nothing
//   node api-ig-daily.mjs         # publish due posts to the Owl Standard Instagram account
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import sharp from "sharp";
import crypto from "node:crypto";
import { assertNotFrozen, instagramDue, isApproved } from "../lib/publishable.mjs";
import { hkTodayStr } from "../lib/watchdog-core.mjs";
import { assertStateDir, companyArtifactPath, companyStatePath } from "../lib/paths.mjs";
import { ConfirmedPublishError, PublishConflictError, publishClaimed } from "../lib/publish-ledger.mjs";
import { reapPublishLedger } from "../lib/publish-ledger-alert.mjs";
import { getEnv } from "../lib/env.mjs";
import {
  fetchWithDeadline,
  MEDIA_HTTP_TIMEOUT_MS,
  PUBLISH_HTTP_TIMEOUT_MS,
} from "../lib/http-deadline.mjs";

if (process.env.SCE_IMPORT_ONLY === "1") process.exit(0);

assertStateDir();
const TOKEN = getEnv("FB_PAGE_TOKEN_OWLSTANDARD");
const CLOUD = getEnv("CLOUDINARY_CLOUD_NAME"), CKEY = getEnv("CLOUDINARY_API_KEY"), CSECRET = getEnv("CLOUDINARY_API_SECRET");
// IG USER ID IS NOT SET YET — companies/owl-standard/company.md channels.instagram.ig_user_id is still "".
// Read from env so a misconfigured run FAILS CLOSED with a named cause rather than posting to another
// tenant's Instagram account. Set IG_USER_ID_OWLSTANDARD in secrets/owl-standard/.env.
const IG_USER = getEnv("IG_USER_ID_OWLSTANDARD");
const FOLDER = "social-content-engine/owl-standard";
const G = "https://graph.facebook.com/v21.0";

// FAIL CLOSED on unset credentials/ids. Neither is configured yet (company.md still has an empty
// ig_user_id), and a publisher that silently no-ops on missing config is how a post ends up on the wrong
// account or a "success" is reported for nothing published.
if (!TOKEN) { console.log("❌ FB_PAGE_TOKEN_OWLSTANDARD missing in .env"); process.exit(1); }
if (!IG_USER) { console.log("❌ IG_USER_ID_OWLSTANDARD missing in .env — refusing to guess an Instagram account"); process.exit(1); }
const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
assertNotFrozen({ dry: DRY });
if (!DRY) await reapPublishLedger();
const todayHK = hkTodayStr(Date.now());
const yesterdayHK = hkTodayStr(Date.now() - 86_400_000);
const j = async (u, params) => (await fetchWithDeadline(
  u,
  { method: "POST", body: new URLSearchParams(params) },
  { timeoutMs: PUBLISH_HTTP_TIMEOUT_MS, label: "Meta Instagram publish" },
)).json();

async function publish(post) {
  // host on Cloudinary (per-brand folder, signed)
  const jpeg = await sharp(readFileSync(companyArtifactPath("owl-standard", post.poster))).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash("sha1").update(`folder=${FOLDER}&timestamp=${ts}${CSECRET}`).digest("hex");
  const fd = new FormData();
  fd.append("file", `data:image/jpeg;base64,${jpeg.toString("base64")}`);
  fd.append("folder", FOLDER); fd.append("api_key", CKEY); fd.append("timestamp", String(ts)); fd.append("signature", sig);
  const up = await (await fetchWithDeadline(
    `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`,
    { method: "POST", body: fd },
    { timeoutMs: MEDIA_HTTP_TIMEOUT_MS, label: `Cloudinary upload ${post.slug}` },
  )).json();
  if (!up.secure_url) throw new ConfirmedPublishError("cloudinary: " + JSON.stringify(up).slice(0, 120));
  // IG: create container → publish
  const cont = await j(`${G}/${IG_USER}/media`, { image_url: up.secure_url, caption: post.caption || "", access_token: TOKEN });
  if (cont.error) throw new ConfirmedPublishError("container: " + cont.error.message);
  if (!cont.id) throw new Error(`IG container returned success without an id for ${post.slug}`);
  // Publish only once Meta reports the container ready (status_code FINISHED). A fixed 4-second pause
  // occasionally lost that race and pushed the post to the next day. Every failure in this loop happens
  // BEFORE media_publish, so it is a confirmed non-publish (the ledger slot is released, not stuck).
  let status = "IN_PROGRESS";
  try {
    for (let i = 0; i < 12 && status === "IN_PROGRESS"; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await (await fetchWithDeadline(
        `${G}/${cont.id}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`,
        {},
        { timeoutMs: PUBLISH_HTTP_TIMEOUT_MS, label: `IG container status ${post.slug}` },
      )).json();
      status = s.status_code || (s.error ? `ERROR: ${s.error.message}` : "IN_PROGRESS");
    }
  } catch (e) {
    throw new ConfirmedPublishError(`container status check failed before publishing: ${e.message}`);
  }
  if (status !== "FINISHED") throw new ConfirmedPublishError(`container not ready (${status}); nothing was published`);
  const pub = await j(`${G}/${IG_USER}/media_publish`, { creation_id: cont.id, access_token: TOKEN });
  if (pub.error) throw new ConfirmedPublishError("publish: " + pub.error.message);
  if (!pub.id) throw new Error(`IG publish returned success without a media id for ${post.slug}`);
  // tidy: delete the Cloudinary asset (IG keeps its own copy)
  try {
    const dts = Math.floor(Date.now() / 1000);
    const dsig = crypto.createHash("sha1").update(`public_id=${up.public_id}&timestamp=${dts}${CSECRET}`).digest("hex");
    const dfd = new FormData(); dfd.append("public_id", up.public_id); dfd.append("api_key", CKEY); dfd.append("timestamp", String(dts)); dfd.append("signature", dsig);
    await fetchWithDeadline(
      `https://api.cloudinary.com/v1_1/${CLOUD}/image/destroy`,
      { method: "POST", body: dfd },
      { timeoutMs: PUBLISH_HTTP_TIMEOUT_MS, label: `Cloudinary destroy ${post.slug}` },
    );
  } catch {}
  return pub.id;
}

const weeksDir = companyStatePath("owl-standard", "weeks");
let posted = 0, skipped = 0, failed = 0;
for (const f of readdirSync(weeksDir).filter((x) => x.endsWith(".json") && !x.startsWith("_"))) {
  const wpath = `${weeksDir}/${f}`; const w = JSON.parse(readFileSync(wpath, "utf8")); let changed = false;
  for (const post of w.posts || []) {
    const verdict = instagramDue(post, todayHK, yesterdayHK);
    if (!verdict.due) {
      // Log only what someone might wonder about: an approved post that is not going out.
      if (isApproved(post) && !post.igPostId && post.date <= todayHK && post.date >= yesterdayHK) {
        console.log(`  withheld ${post.date} ${post.slug ?? ""} — ${verdict.reason}`);
      }
      skipped++;
      continue;
    }
    console.log(`[IG due ${post.date}] ${post.slug} — ${(post.caption || "").split(/\r?\n/)[0].slice(0, 36)}`);
    if (DRY) { console.log("  (dry — would publish)"); continue; }
    try {
      const remote = await publishClaimed({
        brand: "owl-standard", slug: post.slug, channels: ["ig"], plannedDate: post.date, actor: `api-ig-daily:${post.slug}`,
        publish: async () => ({ id: await publish(post) }),
      });
      post.igPostId = remote.id; changed = true; posted++; console.log(`  ✅ IG posted · ${remote.id}`);
    } catch (e) {
      console.log(`  ⛔ publish blocked/failed: ${String(e.message).slice(0, 160)}`);
      if (e instanceof PublishConflictError) process.exitCode = 3;
      failed++;
    }
  }
  if (changed && !DRY) writeFileSync(wpath, JSON.stringify(w, null, 2));
}
console.log(`\nIG daily: posted ${posted}, skipped ${skipped}, failed ${failed}.`);
