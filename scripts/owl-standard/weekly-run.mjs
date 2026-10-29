// scripts/owl-standard/weekly-run.mjs — Owl Standard weekly autopilot (REVIEW-FIRST, MANUAL APPROVAL).
// Generates the next missing week. In the default MONTHLY review mode nothing is sent now — the review
// bot delivers the batch on the 1st (or within 7 days of publishing); REVIEW_DELIVERY_MODE=weekly sends
// posters immediately. NOTHING is scheduled here: only posts the owner approves ever publish.
// Any hard failure pings the owner.
//   node scripts/owl-standard/weekly-run.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { notify, notifyPhoto } from "../lib/notify.mjs";
import { posterKeyboard, bulkKeyboard } from "../lib/review-core.mjs";
import { deliverReviewPhotos, weeklyDeliveryEnabled } from "../lib/review-delivery.mjs";
import { parseWrote, setActiveWeek } from "../lib/artifacts.mjs";
import { parseQueueFull } from "../lib/generation-queue.mjs";
import { reportWeeklyError } from "../lib/weekly-failure.mjs";
import { companyStatePath } from "../lib/paths.mjs";

if (process.env.SCE_IMPORT_ONLY === "1") process.exit(0);

const BRAND = "owl-standard";
const exec = promisify(execFile);
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const node = process.execPath;
const run = async (script) =>
  // 20 minutes: three posters through an async image queue can take several minutes each. The
  // job's own ceiling (worker-jobs.mjs, 35 min) and catchup's per-run timeout sit above this.
  (await exec(node, [p(script)], { cwd: p("../.."), timeout: 20 * 60 * 1000, maxBuffer: 12 * 1024 * 1024 })).stdout;

try {
  await notify("🟧 Owl Standard 簡樸房認證：開始生成下週內容…");
  const output = await run("./gen-week.mjs");
  process.stdout.write(output);
  // A full queue is a legitimate no-op, not a failure — do not treat it as a missing artifact.
  if (!parseQueueFull(output)) {
    const weekPath = parseWrote(output, "Owl Standard week generator");
    setActiveWeek(BRAND, weekPath);
    const week = JSON.parse(readFileSync(weekPath, "utf8"));

    // The 48h auto-approve clock starts ONLY on confirmed delivery — see lib/review-delivery.mjs.
    const failedReviews = await deliverReviewPhotos({
      brand: BRAND,
      posts: week.posts,
      notifyPhoto,
      photoPath: (x) => companyStatePath(BRAND, "posters", `${x.slug}.png`),
      caption: (x) => `${x.day || x.slug} · ${x.title || x.headline || ""}`,
      keyboard: posterKeyboard,
    });
    week.lastDigestAt = null;
    writeFileSync(weekPath, JSON.stringify(week, null, 2), "utf8");
    if (!weeklyDeliveryEnabled()) {
      // Monthly review (the default): nothing was sent just now, so never say it was — and never
      // attach an approve-all button for posters the owner has not seen.
      const made = (week.posts || []).filter((x) => x.status === "generated").length;
      await notify(
        `🗓️ Owl Standard 已生成 ${made} 篇帖文（${week.weekId}）。` +
        "將於下月 1 日的審閱批次送出；發佈日在 7 日內的，會提前送出。",
      );
    } else if (!failedReviews.length) {
      await notify(
        "✅ 已全部送到審閱。請逐張按 ✅／❌／🔁，或一次過全部批准。未批准的帖文不會發佈。",
        bulkKeyboard(),
      );
    }
  }
} catch (e) {
  process.exitCode = await reportWeeklyError({
    brand: BRAND,
    error: e,
    message: `❌ Owl Standard 生成出錯，需要人手檢查：\n${String(e?.message || e).slice(0, 400)}`,
    notify,
  });
}
