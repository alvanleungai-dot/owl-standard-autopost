import { test } from "node:test";
import assert from "node:assert/strict";
import { weekIndex, EPOCH } from "./week-rotation.mjs";

// The fixed epoch is 2024-01-01, a Monday, at local midnight.
const epochMonday = new Date(EPOCH.y, EPOCH.m, EPOCH.d);

test("the epoch Monday returns 0", () => {
  assert.equal(weekIndex(epochMonday), 0);
});

test("consecutive Mondays differ by exactly 1", () => {
  for (let w = 0; w < 8; w++) {
    const monA = new Date(2024, 0, 1 + 7 * w);       // Monday of week w
    const monB = new Date(2024, 0, 1 + 7 * (w + 1)); // Monday of week w+1
    assert.equal(weekIndex(monB) - weekIndex(monA), 1, `week ${w}→${w + 1}`);
  }
});

test("every day of the same week maps to the same index", () => {
  // 2024-01-08 is a Monday → its Mon..Sun (8th..14th) all share one index.
  const monday = new Date(2024, 0, 8);
  const want = weekIndex(monday);
  for (let off = 0; off < 7; off++) {
    const day = new Date(2024, 0, 8 + off); // Mon..Sun of that week
    assert.equal(weekIndex(day), want, `+${off} days`);
  }
  // The next Monday must roll over to the following index.
  assert.equal(weekIndex(new Date(2024, 0, 15)), want + 1);
});

test("weekIndex(monday) % 4 cycles 0,1,2,3,0 across 5 consecutive weeks", () => {
  const cycle = [];
  for (let w = 0; w < 5; w++) {
    cycle.push(weekIndex(new Date(2024, 0, 1 + 7 * w)) % 4);
  }
  assert.deepEqual(cycle, [0, 1, 2, 3, 0]);
});

test("dates before the epoch clamp to a non-negative 0", () => {
  assert.equal(weekIndex(new Date(2023, 11, 25)), 0); // a week before epoch
});
