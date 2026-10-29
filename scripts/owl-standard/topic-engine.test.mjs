import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetStateRootForTests, DURABILITY_SENTINEL, DURABILITY_SENTINEL_CONTENT } from "../lib/paths.mjs";
import { LENSES, PERSONAS, ANGLES, loadLedger, isDuplicate, appendLedger } from "./topic-engine.mjs";

const original = { CLOUD: process.env.CLOUD, RENDER: process.env.RENDER, STATE_DIR: process.env.STATE_DIR };
test.afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetStateRootForTests();
});

function useTempState() {
  const root = mkdtempSync(join(tmpdir(), "sce-owl-state-"));
  process.env.STATE_DIR = root;
  delete process.env.CLOUD;
  delete process.env.RENDER;
  resetStateRootForTests();
  return root;
}

test("LENSES/PERSONAS/ANGLES are well-formed with no duplicate tags", () => {
  assert.ok(LENSES.length >= 20, "expected a real lens pool, not a stub");
  const tags = LENSES.map((l) => l.tag);
  assert.equal(new Set(tags).size, tags.length, "lens tags must be unique");
  for (const l of LENSES) {
    assert.ok(l.tag && /^[a-z0-9-]+$/.test(l.tag), `bad tag: ${l.tag}`);
    assert.ok(l.desc && l.desc.length > 4, `lens ${l.tag} missing a real description`);
  }
  assert.ok(PERSONAS.length >= 8);
  assert.ok(ANGLES.length >= 8);
  assert.equal(new Set(PERSONAS).size, PERSONAS.length, "personas must be unique");
  assert.equal(new Set(ANGLES).size, ANGLES.length, "angles must be unique");
});

test("no known-bad compliance wording leaks into the lens pool", () => {
  const text = LENSES.map((l) => l.desc).join(" ");
  // "第4.5年開始準備" (renewal-fee lens) is a legitimate decimal-year timing reference, not the banned
  // "認證有效期5年" claim — assert against the specific bad phrase, not bare "5年" (which false-positives).
  assert.ok(!text.includes("5年認證期"), "must not claim a 5年認證期 — use 60個月 (CLAUDE.md rule)");
  assert.ok(!/有效期.{0,4}5\s*年/.test(text), "must not phrase validity as X年 — use 60個月");
  assert.ok(!text.includes("屋宇署認證"), "must not credit 屋宇署 as the BHU certifying authority");
});

test("loadLedger returns [] when no ledger file exists yet", () => {
  useTempState();
  assert.deepEqual(loadLedger(), []);
});

test("appendLedger persists entries and loadLedger reads them back", () => {
  const root = useTempState();
  appendLedger([{ title: "測試主題A", angle: "拆解常見迷思", lens: "grace-deadline" }]);
  const ledger = loadLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].title, "測試主題A");
  const onDisk = join(root, "companies", "owl-standard", "topics-ledger.json");
  assert.ok(existsSync(onDisk), "ledger must be written under STATE_DIR/companies/owl-standard/");
  assert.deepEqual(JSON.parse(readFileSync(onDisk, "utf8")), ledger);
});

test("isDuplicate catches exact and substring-normalized repeats", () => {
  useTempState();
  appendLedger([{ title: "寬限期登記截止日提醒", angle: "數字/數據型" }]);
  const ledger = loadLedger();
  assert.equal(isDuplicate("寬限期登記截止日提醒", ledger), true, "exact repeat");
  assert.equal(isDuplicate("寬限期登記截止日提醒！你要知道", ledger), true, "superset must dedupe");
  assert.equal(isDuplicate("認證前評估係咩", ledger), false, "unrelated title must not dedupe");
});

test("appendLedger never overwrites earlier entries (accumulates across calls)", () => {
  useTempState();
  appendLedger([{ title: "主題一" }]);
  appendLedger([{ title: "主題二" }]);
  const ledger = loadLedger();
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger.map((e) => e.title), ["主題一", "主題二"]);
});
