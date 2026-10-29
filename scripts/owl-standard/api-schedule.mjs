// scripts/owl-standard/api-schedule.mjs — schedule Owl Standard's posts to Facebook via the Graph API.
// The reliable replacement for browser scheduling: uploads each poster with its caption as a scheduled
// photo post (published=false + scheduled_publish_time = its date @ 10:00 HK). Idempotent (records
// fbPostId per post, skips already-scheduled). Fully reversible: DELETE /{fbPostId}.
//   node scripts/owl-standard/api-schedule.mjs --dry        # preview, post nothing
//   node scripts/owl-standard/api-schedule.mjs --limit=1    # schedule just the next 1 (verify first)
//   node scripts/owl-standard/api-schedule.mjs              # schedule all future, not-yet-scheduled
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { assertNotFrozen, isPublishable, lastBookableDate, whyNotPublishable } from "../lib/publishable.mjs";
import { hkTodayStr } from "../lib/watchdog-core.mjs";
import { assertStateDir, companyArtifactPath, companyStatePath } from "../lib/paths.mjs";
import { ConfirmedPublishError, PublishConflictError, publishClaimed } from "../lib/publish-ledger.mjs";
import { reapPublishLedger } from "../lib/publish-ledger-alert.mjs";
import { facebookDedupFacts, fetchFacebookInventory } from "../lib/meta-dedup.mjs";
import { getEnv } from "../lib/env.mjs";
import { fetchWithDeadline, PUBLISH_HTTP_TIMEOUT_MS } from "../lib/http-deadline.mjs";

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
assertStateDir();
assertNotFrozen({ dry: DRY });
if (!DRY) await reapPublishLedger();
const limArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limArg ? Number(limArg.split("=")[1]) : Infinity;

const TOKEN = getEnv("FB_PAGE_TOKEN_OWLSTANDARD");
// PAGE ID IS NOT SET YET — the owner has not supplied Owl Standard's Facebook Page ID
// (companies/owl-standard/company.md channels.facebook.page_id is still ""). Read it from the env so a
// misconfigured run FAILS CLOSED with a named cause instead of posting to whatever id was left here from
// another tenant. Set FB_PAGE_ID_OWLSTANDARD in secrets/owl-standard/.env.
const PAGE_ID = getEnv("FB_PAGE_ID_OWLSTANDARD");
const G = "https://graph.facebook.com/v21.0";
const weeksDir = companyStatePath("owl-standard", "weeks");

if (!TOKEN) { console.log("❌ FB_PAGE_TOKEN_OWLSTANDARD missing in .env"); process.exit(1); }
if (!PAGE_ID) { console.log("❌ FB_PAGE_ID_OWLSTANDARD missing in .env — refusing to guess a Page ID"); process.exit(1); }
// Hong Kong's date, not the server's: Render runs on UTC, which is still "yesterday" before 08:00 HK.
const today = hkTodayStr(Date.now());
const lastBookable = lastBookableDate(today);
const norm = (s) => (s || "").replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "");
const allowDateCollision = new Set(
  process.argv
    .filter((arg) => arg.startsWith("--allow-date-collision="))
    .map((arg) => arg.slice("--allow-date-collision=".length))
    .filter(Boolean),
);
const inventory = await fetchFacebookInventory({ pageId: PAGE_ID, token: TOKEN, graphBase: G });
const { existingNorm, occupiedDates } = facebookDedupFacts({ ...inventory, normalize: norm });

// gather future, non-broken posts across all week files
const items = [];
for (const f of readdirSync(weeksDir).filter((x) => x.endsWith(".json") && !x.startsWith("_"))) {
  const wpath = `${weeksDir}/${f}`;
  const w = JSON.parse(readFileSync(wpath, "utf8"));
  for (const post of w.posts || []) {
    if (!isPublishable(post, today)) {
      if (post.date && post.date >= today) console.log(`  withheld ${post.date} ${post.slug ?? ""} — ${whyNotPublishable(post, today)}`);
      continue;
    }
    items.push({ post, wpath, w });
  }
}
items.sort((a, b) => a.post.date.localeCompare(b.post.date));
console.log(`Owl Standard API schedule: ${items.length} future post(s)${DRY ? " · DRY (nothing posted)" : ""}`);

let done = 0, booked = 0, later = 0, dup = 0, failed = 0;
for (const { post, wpath, w } of items) {
  if (post.fbPostId) { console.log(`  ${post.date} ${post.slug} — already scheduled (${post.fbPostId}) ✓`); booked++; continue; }
  if (post.date > lastBookable) {
    // Not a failure: Meta refuses bookings more than 30 days ahead. SCE-FB-Topup books it once in range.
    console.log(`  ${post.date} ${post.slug} — beyond Meta's booking window (last bookable ${lastBookable}); booked automatically later`);
    later++;
    continue;
  }
  const marker = norm(post.caption).slice(0, 14);
  if (marker && existingNorm.includes(marker)) {
    console.log(`  ${post.date} ${post.slug} — ⏭️ DUP content already on page`);
    dup++;
    continue;
  }
  if (occupiedDates.has(post.date) && !allowDateCollision.has(post.slug)) {
    console.log(
      `  ${post.date} ${post.slug} — ⏭️ date already occupied; unattended run refuses. ` +
      `Use --allow-date-collision=${post.slug} only after verifying the second post is intentional.`,
    );
    dup++;
    continue;
  }
  if (done >= LIMIT) break;
  const img = companyArtifactPath("owl-standard", post.poster);
  if (!existsSync(img)) { console.log(`  ${post.date} ${post.slug} — ⛔ poster missing, not booked`); failed++; continue; }
  const ts = Math.floor(Date.parse(`${post.date}T10:00:00+08:00`) / 1000);
  const headline = (post.caption || "").split(/\r?\n/)[0].slice(0, 44);
  console.log(`\n[${post.date} 10:00 HK · ts=${ts}] ${post.slug} — ${headline}`);
  if (DRY) { console.log("  (dry — would schedule this)"); continue; }
  try {
    const remote = await publishClaimed({
      brand: "owl-standard",
      slug: post.slug,
      channels: ["fb"],
      plannedDate: post.date,
      actor: `api-schedule:${post.slug}`,
      publish: async () => {
        const fd = new FormData();
        fd.append("message", post.caption || "");
        fd.append("published", "false");
        fd.append("scheduled_publish_time", String(ts));
        fd.append("access_token", TOKEN);
        fd.append("source", new Blob([readFileSync(img)]), `${post.slug}.png`);
        const r = await (await fetchWithDeadline(
          `${G}/${PAGE_ID}/photos`,
          { method: "POST", body: fd },
          { timeoutMs: PUBLISH_HTTP_TIMEOUT_MS, label: `Meta schedule ${post.slug}` },
        )).json();
        if (r.error) throw new ConfirmedPublishError(`Meta rejected ${post.slug}: ${r.error.message}`);
        const id = r.post_id || r.id;
        if (!id) throw new Error(`Meta returned success without a post id for ${post.slug}`);
        return { id };
      },
    });
    post.fbPostId = remote.id;
    writeFileSync(wpath, JSON.stringify(w, null, 2));
    console.log(`  ✅ scheduled · post id ${post.fbPostId}`);
    done++;
  } catch (e) {
    console.log(`  ⛔ publish blocked/failed: ${String(e.message).slice(0, 160)}`);
    if (e instanceof PublishConflictError) process.exitCode = 3;
    failed++;
  }
}
console.log(`\nScheduled ${done}, already booked ${booked}, later ${later}, dup/date-blocked ${dup}, failed ${failed}.`);
// An approved post that could not be booked is a problem someone must see: exit non-zero so
// SCE-FB-Topup raises the alarm (it used to exit 0 here, so a rejected booking was silent while
// Instagram carried on). A publish-identity conflict keeps its own exit code 3.
if ((failed || dup) && !process.exitCode) process.exitCode = 1;
