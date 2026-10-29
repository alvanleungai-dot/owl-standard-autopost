// scripts/owl-standard/gen-week.mjs — generate ONE week of Owl Standard content end-to-end:
//   fresh topics → captions → poster concepts → posters → week-batch JSON.
//
// Topics are reserved in the ledger IMMEDIATELY (before any paid API call) so a crash can never
// re-propose them. Adapted from the retired Better Life gen-week.mjs; the differences are the tenant
// ("owl-standard"), the topic source (scripts/owl-standard/topic-engine.mjs, built from
// companies/owl-standard/topics.md), and the cadence.
//
// CADENCE — 3 feed posts/week: TUE, WED, FRI, per companies/owl-standard/company.md. That file also
// lists a SUN IG story; stories are not feed posts and are not generated here.
//
//   node scripts/owl-standard/gen-week.mjs [weekId] [N=3] [--force]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { proposeTopics, appendLedger, LENSES } from "./topic-engine.mjs";
import { writeCaption } from "../write-caption.mjs";
import { markerFor } from "../lib/caption-marker.mjs";
import { deriveConcept, writeConceptFile } from "../derive-concept.mjs";
import { companyStatePath, ensureStateParent } from "../lib/paths.mjs";
import { assertArtifactsWritable, wroteLine } from "../lib/artifacts.mjs";
import { queueFullLine, selectGenerationWeek, weekArg } from "../lib/generation-queue.mjs";

const BRAND = "owl-standard";
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const genPoster = p("../gen-poster-v4.mjs");

const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const SPREAD = ["TUE", "WED", "FRI"];
const DIRECTIONS = ["infographic", "cartoon"]; // rotate the visual direction week-to-week

const clean = (s) => (s || "").replace(/[^一-鿿0-9A-Za-z]/g, "");
// markerFor comes from lib/caption-marker.mjs — the single shared definition (see that file for the
// footer-bracket bug that having two copies allowed).

const FORCE = process.argv.includes("--force");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const explicitWeekArg = weekArg();
const explicitWeek = explicitWeekArg || positional[0] || null;
const N = Number(explicitWeekArg ? positional[0] : positional[1]) || SPREAD.length;

const artifactsFor = ({ weekId }) => {
  const paths = [companyStatePath(BRAND, "weeks", `${weekId}.json`)];
  for (let i = 0; i < N; i++) {
    const name = `${weekId}-${pad(i + 1)}`;
    paths.push(
      companyStatePath(BRAND, "concepts", `${name}.txt`),
      companyStatePath(BRAND, "posters", `${name}.png`),
    );
  }
  return paths;
};

const target = selectGenerationWeek({ style: "iso", artifactsFor, explicitWeek });
if (target.status === "full") {
  console.log(queueFullLine(target.through));
  process.exit(0);
}
const { monday, weekId, offsetWeeks: WEEK_OFFSET } = target;
process.env.WEEK_OFFSET = String(WEEK_OFFSET);

// Rotate the visual direction across weeks so the feed does not look mechanical.
const direction = DIRECTIONS[((WEEK_OFFSET % DIRECTIONS.length) + DIRECTIONS.length) % DIRECTIONS.length];

const dateForDay = (dayName) => {
  const off = DAYS.indexOf(dayName);
  const d = new Date(monday);
  d.setDate(monday.getDate() + (off >= 0 ? off : 0));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const outPath = companyStatePath(BRAND, "weeks", `${weekId}.json`);
// Refuse BEFORE topic reservation or any paid API work. A failed overwrite check must change nothing.
assertArtifactsWritable(artifactsFor({ weekId }), { force: FORCE || target.incomplete === true });

console.log(`Generating week ${weekId} (${N} posts, direction: ${direction})…`);
// A bad/absent key throws here, on the FIRST paid call, before anything is reserved or written.
// Surface it as a readable cause instead of a raw stack trace — this is the most likely first-run
// failure, and an operator staring at an unhandled rejection cannot tell which credential is wrong.
let topics;
try {
  topics = await proposeTopics(N);
} catch (e) {
  const msg = String(e?.message || e);
  console.error(`\n❌ 揀題失敗：${msg.slice(0, 300)}`);
  if (/401|authentication|invalid.*key/i.test(msg)) {
    console.error("\n   ANTHROPIC_API_KEY 唔啱或者未設定。");
    console.error("   跑 node scripts/owl-standard/doctor.mjs 睇下讀唔讀到個 key。");
  } else if (/credit|quota|insufficient|billing/i.test(msg)) {
    console.error("\n   Anthropic 額度用完或者未充值 —— console.anthropic.com 加返 credit。");
  }
  console.error("\n   冇任何檔案寫咗落去，亦冇預留任何題目。修好之後直接再跑一次。");
  process.exit(1);
}
if (!topics.length) { console.log("No fresh topics available — the lens pool may be exhausted."); process.exit(2); }
if (topics.length < N) console.log(`WARN: only ${topics.length}/${N} fresh topics this run.`);

// Reserve every topic NOW, before generation, so an interrupted run cannot hand them out again.
appendLedger(topics.map((t, i) => ({
  id: `${weekId}-${pad(i + 1)}`,
  title: t.title,
  angle: t.angle || "",
  lens: t.lens || "",
  persona: t.persona || "",
  week: weekId,
  usedAt: weekId,
})));

ensureStateParent(outPath);
const posts = [];
for (let i = 0; i < topics.length; i++) {
  const t = topics[i];
  const name = `${weekId}-${pad(i + 1)}`;
  const dayName = SPREAD[i] || SPREAD[SPREAD.length - 1];
  const date = dateForDay(dayName);
  console.log(`\n[${i + 1}/${topics.length}] ${t.title}  (${dayName} ${date})`);
  try {
    // The lens description scopes the post; the publish date lets "how long is left" be computed from
    // the day readers see it, not the day it was written (up to five weeks earlier).
    const caption = await writeCaption({ ...t, publishDate: date, lensDesc: LENSES.find((l) => l.tag === t.lens)?.desc });
    const concept = await deriveConcept(t, caption);
    const conceptPath = writeConceptFile(name, concept);
    execFileSync(
      process.execPath,
      [genPoster, direction, name, "tl", conceptPath, "--no-report", ...(FORCE ? ["--force"] : [])],
      { stdio: "inherit", env: { ...process.env, SCE_SUPPRESS_WROTE: "1", IMG_QUALITY: process.env.IMG_QUALITY || "medium" } },
    );
    posts.push({
      i: i + 1, day: dayName, date, slug: name,
      title: t.title, angle: t.angle || "", lens: t.lens || "", persona: t.persona || "",
      direction, headline: concept.headline, marker: markerFor(caption), caption,
      poster: `companies/${BRAND}/posters/${name}.png`, status: "generated",
    });
  } catch (e) {
    console.log(`  !! ${name} failed: ${e.message}`);
    posts.push({
      i: i + 1, day: dayName, date, slug: name, title: t.title, angle: t.angle || "",
      direction, status: "failed", error: e.message,
    });
  }
}

const batch = { weekId, status: "generated", createdAt: new Date().toISOString(), posts };
writeFileSync(outPath, JSON.stringify(batch, null, 2), "utf8");
const ok = posts.filter((x) => x.status === "generated").length;
console.log(wroteLine(outPath));
console.log(`\n✅ Week ${weekId}: ${ok}/${posts.length} generated → companies/${BRAND}/weeks/${weekId}.json`);

// FAIL LOUDLY on any broken post. An exit 0 on an all-broken week is how the upstream repo once let
// broken posts flow through to auto-approval — the weekly runner and task-health both key off this code.
const failedCount = posts.length - ok;
if (failedCount > 0) {
  console.error(`⚠️ ${failedCount}/${posts.length} posts FAILED — week incomplete. Fix the API/keys and re-run; do NOT post this week.`);
  process.exitCode = 2;
}
