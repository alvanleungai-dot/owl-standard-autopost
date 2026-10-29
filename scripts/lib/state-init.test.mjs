import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStateDir, verifySeededState } from "../init-state-dir.mjs";
import { StateDirError } from "./paths.mjs";

const roots = [];
const temp = (name) => {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
};
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function seedSource(root, brand = "brand") {
  const dir = join(root, brand);
  mkdirSync(join(dir, "weeks"), { recursive: true });
  writeFileSync(join(dir, "weeks", "2026-W01.json"), '{"posts":[]}\n');
  writeFileSync(join(dir, "topics-ledger.json"), '{"topics":[]}\n');
}

test("seed verifier accepts parseable manifests and per-brand ledgers", () => {
  const source = temp("sce-source");
  const state = temp("sce-state");
  seedSource(source);
  mkdirSync(join(state, "companies", "brand", "weeks"), { recursive: true });
  writeFileSync(join(state, "companies", "brand", "weeks", "2026-W01.json"), '{"posts":[]}\n');
  writeFileSync(join(state, "companies", "brand", "topics-ledger.json"), '{"topics":[]}\n');
  assert.deepEqual(
    verifySeededState(state, { sourceCompanies: source }),
    { brands: 1, manifests: 1, ledgers: 1, publishLedgers: 0 },
  );
});

test("initializer creates, migrates, verifies, and is repeat-safe", () => {
  const sourceRoot = temp("sce-checkout");
  const source = join(sourceRoot, "companies");
  const state = temp("sce-state");
  seedSource(source);
  const options = { sourceCompanies: source, sourceRoot, assertRoot: () => {} };
  const first = initStateDir(state, options);
  const second = initStateDir(state, options);
  assert.equal(first.verified.manifests, 1);
  assert.equal(first.report.conflicts.length, 0);
  assert.equal(second.report.copied.length, 0);
  assert.ok(second.report.skipped.length >= 2);
  assert.equal(second.report.conflicts.length, 0);
});

test("a new brand with no week history boots with an empty ledger, and a later ledger is never overwritten", () => {
  const sourceRoot = temp("sce-checkout");
  const source = join(sourceRoot, "companies");
  mkdirSync(join(source, "brand"), { recursive: true }); // config only: no weeks/, no ledger
  const state = temp("sce-state");
  const options = { sourceCompanies: source, sourceRoot, assertRoot: () => {} };
  const first = initStateDir(state, options);
  const ledger = join(state, "companies", "brand", "topics-ledger.json");
  assert.deepEqual(first.verified, { brands: 1, manifests: 0, ledgers: 1, publishLedgers: 0 });
  assert.deepEqual(JSON.parse(readFileSync(ledger, "utf8")), []);
  writeFileSync(ledger, '[{"id":"kept"}]\n');
  initStateDir(state, options);
  assert.match(readFileSync(ledger, "utf8"), /kept/);
});

test("seed verifier fails closed on an empty disk", () => {
  const source = temp("sce-source");
  const state = temp("sce-empty");
  seedSource(source);
  assert.throws(
    () => verifySeededState(state, { sourceCompanies: source }),
    (error) => error instanceof StateDirError && /missing or invalid JSON/.test(error.message),
  );
});

test("seed verifier fails closed on malformed runtime JSON", () => {
  const source = temp("sce-source");
  const state = temp("sce-state");
  seedSource(source);
  mkdirSync(join(state, "companies", "brand", "weeks"), { recursive: true });
  writeFileSync(join(state, "companies", "brand", "weeks", "2026-W01.json"), "{broken");
  writeFileSync(join(state, "companies", "brand", "topics-ledger.json"), '{"topics":[]}\n');
  assert.throws(() => verifySeededState(state, { sourceCompanies: source }), StateDirError);
  assert.equal(readFileSync(join(state, "companies", "brand", "weeks", "2026-W01.json"), "utf8"), "{broken");
});
