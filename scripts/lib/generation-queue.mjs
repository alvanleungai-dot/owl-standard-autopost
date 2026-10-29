import { existsSync, readFileSync } from "node:fs";

export const GENERATION_QUEUE_HORIZON_WEEKS = 12;

/**
 * IS THIS WEEK ACTUALLY DONE? The single definition, shared by the generator and by catchup.
 *
 * A week file existing is not the same as a week having content. Measured 2026-07-31: Sun Mood's
 * failed runs left week manifests with an EMPTY posts array. catchup counted those files and
 * reported the brand 7/8 weeks deep while three of those weeks held nothing publishable — so it
 * never retried them, and the gaps were permanent and silent.
 *
 * The two callers previously disagreed twice over (any-artifact vs manifest-exists, then
 * manifest-exists vs has-content) and each disagreement created a stall nobody could see. They now
 * share this one predicate, which is the only way that class of bug stays fixed.
 */
export function weekManifestHasPosts(path, { exists = existsSync, read = readFileSync } = {}) {
  if (!exists(path)) return false;
  try {
    const week = JSON.parse(read(path, "utf8"));
    return Array.isArray(week.posts) && week.posts.length > 0;
  } catch {
    return false; // an unreadable manifest is not a finished week
  }
}

const pad = (value) => String(value).padStart(2, "0");

export function formatDateWeekId(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatIsoWeekId(date) {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((thursday - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${thursday.getUTCFullYear()}-W${pad(week)}`;
}

export function nextHongKongMonday(now = new Date()) {
  const hk = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
  const daysUntilMonday = ((8 - hk.getDay()) % 7) || 7;
  hk.setDate(hk.getDate() + daysUntilMonday);
  hk.setHours(0, 0, 0, 0);
  return hk;
}

function mondayFromDateWeekId(weekId) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekId);
  if (!match) throw new Error(`Invalid --week=${weekId}; expected YYYY-MM-DD`);
  const monday = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (formatDateWeekId(monday) !== weekId || monday.getDay() !== 1) {
    throw new Error(`Invalid --week=${weekId}; expected a real Monday in YYYY-MM-DD form`);
  }
  return monday;
}

function mondayFromIsoWeekId(weekId) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!match) throw new Error(`Invalid --week=${weekId}; expected YYYY-Www`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(year, 0, 4);
  const januaryFourthDay = (januaryFourth.getDay() + 6) % 7;
  const monday = new Date(year, 0, 4 - januaryFourthDay + (week - 1) * 7);
  monday.setHours(0, 0, 0, 0);
  if (formatIsoWeekId(monday) !== weekId) {
    throw new Error(`Invalid --week=${weekId}; expected a real ISO week in YYYY-Www form`);
  }
  return monday;
}

function explicitOffset(env) {
  if (!Object.prototype.hasOwnProperty.call(env, "WEEK_OFFSET")) return null;
  const value = Number(env.WEEK_OFFSET);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid WEEK_OFFSET=${env.WEEK_OFFSET}; expected an integer`);
  }
  return value;
}

function weeksBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / (7 * 86_400_000));
}

export function weekArg(argv = process.argv.slice(2)) {
  const arg = argv.find((value) => value.startsWith("--week="));
  if (!arg) return null;
  const value = arg.slice("--week=".length).trim();
  if (!value) throw new Error("--week= requires a week id");
  return value;
}

export function selectGenerationWeek({
  style,
  artifactsFor,
  explicitWeek = weekArg(),
  env = process.env,
  now = new Date(),
  exists = existsSync,
  read = readFileSync,
  horizonWeeks = GENERATION_QUEUE_HORIZON_WEEKS,
  // A week counts as finished only when its manifest holds at least one post — see
  // weekManifestHasPosts. Injectable so callers and tests can supply their own storage.
  manifestComplete = (path) => weekManifestHasPosts(path, { exists, read }),
}) {
  if (style !== "date" && style !== "iso") throw new Error(`Unknown week-id style: ${style}`);
  if (typeof artifactsFor !== "function") throw new TypeError("artifactsFor is required");
  if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1) {
    throw new Error("horizonWeeks must be a positive integer");
  }

  const firstMonday = nextHongKongMonday(now);
  const formatWeekId = style === "iso" ? formatIsoWeekId : formatDateWeekId;
  const parseWeekId = style === "iso" ? mondayFromIsoWeekId : mondayFromDateWeekId;

  if (explicitWeek) {
    const monday = parseWeekId(explicitWeek);
    return {
      status: "target",
      explicit: true,
      monday,
      weekId: explicitWeek,
      offsetWeeks: weeksBetween(firstMonday, monday),
    };
  }

  const offset = explicitOffset(env);
  if (offset !== null) {
    const monday = new Date(firstMonday);
    monday.setDate(monday.getDate() + offset * 7);
    return {
      status: "target",
      explicit: true,
      monday,
      weekId: formatWeekId(monday),
      offsetWeeks: offset,
    };
  }

  for (let offsetWeeks = 0; offsetWeeks < horizonWeeks; offsetWeeks += 1) {
    const monday = new Date(firstMonday);
    monday.setDate(monday.getDate() + offsetWeeks * 7);
    const weekId = formatWeekId(monday);
    const artifacts = artifactsFor({ monday, weekId });
    // THE WEEK MANIFEST IS THE ONLY PROOF A WEEK IS DONE — every artifactsFor returns it first.
    //
    // This used to skip any week where ANY artifact existed, which conflated "finished" with
    // "attempted". Measured 2026-07-31: Sun Mood's 2026-08-24 generation failed after writing its
    // caption but before the poster, leaving a caption with no manifest. Every later run then saw
    // that orphan, treated the week as done, skipped it, and generated a LATER week instead — while
    // catchup, which counts manifests, correctly saw the hole and reported no progress. The two
    // measures disagreed forever: the brand could never be filled and never reported an error.
    //
    // A week with debris but no manifest is INCOMPLETE, not done — target it and tell the caller to
    // overwrite the debris, which is exactly what the existing --force path already does safely.
    if (manifestComplete(artifacts[0])) continue;
    return {
      status: "target",
      explicit: false,
      monday,
      weekId,
      offsetWeeks,
      incomplete: artifacts.some((path) => exists(path)),
    };
  }

  const through = new Date(firstMonday);
  through.setDate(through.getDate() + (horizonWeeks - 1) * 7);
  return {
    status: "full",
    explicit: false,
    through: formatDateWeekId(through),
    horizonWeeks,
  };
}

/**
 * How many CONTIGUOUS weeks of content already exist, counting forward from `firstMonday`.
 *
 * Contiguous on purpose: a hole means the queue is not really deep. If 2026-08-10 is missing but
 * 2026-08-17 exists, the depth is 0, not 1 — otherwise catchup would report a healthy queue while
 * the very next Monday had nothing to publish.
 *
 * This is what lets catchup TOP THE QUEUE UP instead of only ever filling the single upcoming week,
 * which is why content used to stop dead a few weeks out: gen-week can already target any of the
 * next 12 weeks, but nothing ever asked it for more than one.
 */
export function contiguousQueueDepth({
  firstMonday,
  horizonWeeks = GENERATION_QUEUE_HORIZON_WEEKS,
  artifactsFor,
  exists = existsSync,
}) {
  if (typeof artifactsFor !== "function") throw new TypeError("artifactsFor is required");
  if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1) {
    throw new Error("horizonWeeks must be a positive integer");
  }
  let depth = 0;
  for (let offsetWeeks = 0; offsetWeeks < horizonWeeks; offsetWeeks += 1) {
    const monday = new Date(firstMonday);
    monday.setDate(monday.getDate() + offsetWeeks * 7);
    if (!artifactsFor({ monday, offsetWeeks }).some((path) => exists(path))) break;
    depth += 1;
  }
  return depth;
}

export function queueFullLine(through) {
  return `queue already full through ${through}, nothing to generate`;
}

export function parseQueueFull(stdout) {
  const match = String(stdout || "").match(
    /^queue already full through (\d{4}-\d{2}-\d{2}), nothing to generate$/m,
  );
  return match ? match[1] : null;
}
