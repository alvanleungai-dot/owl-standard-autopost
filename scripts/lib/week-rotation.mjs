// scripts/lib/week-rotation.mjs — pure, deterministic week index for the weekly poster-direction rotation.
//
// THE PROBLEM: gen-week.mjs derived the rotating poster "direction" from WEEK_OFFSET, which is 0 on every
// real automated run — so the D1→D2→D3→D4 (and Sunmood v8→v5→v6) rotation never advanced and every week
// shipped the same direction forever. The rotation index must come from the ACTUAL week, not the backfill
// offset.
//
// THE FIX (this module): weekIndex(date) counts whole calendar weeks (Mondays) since a fixed Monday epoch.
// Callers do `DIRS[weekIndex(monday) % DIRS.length]`, so the direction advances by exactly 1 each calendar
// week. Because the `monday` passed in already folds in WEEK_OFFSET, each backfilled week still gets its
// own correct, distinct direction.
//
//   import { weekIndex } from "./week-rotation.mjs";
//   const dir = DIRS[weekIndex(monday) % DIRS.length];

// Fixed epoch: 2024-01-01 is a MONDAY, at local midnight. Week 0 starts here.
export const EPOCH = { y: 2024, m: 0, d: 1 };

const MS_PER_DAY = 86_400_000;

// Whole weeks (Mondays) between the epoch and `date`, as a non-negative integer.
// Advances by exactly 1 per calendar week; every day Mon..Sun of a week shares one index.
// We compare the LOCAL calendar day of each date via Date.UTC(Y,M,D) so the day count is immune to DST
// shifts (no I/O, deterministic). Dates before the epoch clamp to 0.
export function weekIndex(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dayMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const epochMs = Date.UTC(EPOCH.y, EPOCH.m, EPOCH.d);
  const days = Math.floor((dayMs - epochMs) / MS_PER_DAY);
  return Math.max(0, Math.floor(days / 7));
}
