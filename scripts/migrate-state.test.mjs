import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateState } from "./migrate-state.mjs";
import { resetStateRootForTests } from "./lib/paths.mjs";

test("migration copies idempotently and refuses to overwrite a different destination", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "sce-migrate-source-"));
  const target = mkdtempSync(join(tmpdir(), "sce-migrate-target-"));
  const sourceCompanies = join(sourceRoot, "companies");
  const ledger = join(sourceCompanies, "tml", "topics-ledger.json");
  try {
    mkdirSync(join(sourceCompanies, "tml"), { recursive: true });
    writeFileSync(ledger, "{\"topics\":[\"one\"]}\n");

    const first = migrateState(target, { sourceCompanies, sourceRoot });
    assert.equal(first.copied.length, 1);
    assert.equal(readFileSync(join(target, "companies", "tml", "topics-ledger.json"), "utf8"), "{\"topics\":[\"one\"]}\n");

    resetStateRootForTests();
    const second = migrateState(target, { sourceCompanies, sourceRoot });
    assert.equal(second.skipped.length, 1);
    assert.equal(second.conflicts.length, 0);

    writeFileSync(join(target, "companies", "tml", "topics-ledger.json"), "different\n");
    resetStateRootForTests();
    const third = migrateState(target, { sourceCompanies, sourceRoot });
    assert.equal(third.conflicts.length, 1);
    assert.equal(readFileSync(join(target, "companies", "tml", "topics-ledger.json"), "utf8"), "different\n");
    assert.equal(readFileSync(ledger, "utf8"), "{\"topics\":[\"one\"]}\n");
  } finally {
    delete process.env.STATE_DIR;
    resetStateRootForTests();
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("migration seeds confirmed fb and ig claims from copied manifests", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "sce-migrate-source-"));
  const target = mkdtempSync(join(tmpdir(), "sce-migrate-target-"));
  const sourceCompanies = join(sourceRoot, "companies");
  try {
    const weeks = join(sourceCompanies, "better-life", "weeks");
    mkdirSync(weeks, { recursive: true });
    writeFileSync(join(weeks, "2026-W31.json"), JSON.stringify({
      posts: [{ slug: "2026-W31-01", date: "2026-08-03", fbPostId: "fb-1", igPostId: "ig-1" }],
    }));
    const report = migrateState(target, { sourceCompanies, sourceRoot });
    assert.deepEqual(report.seededClaims.sort(), [
      "better-life/2026-W31-01/fb",
      "better-life/2026-W31-01/ig",
    ]);
    for (const channel of ["fb", "ig"]) {
      const path = join(target, "publish-ledger", "better-life", `2026-W31-01.${channel}.json`);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "confirmed");
    }
  } finally {
    delete process.env.STATE_DIR;
    resetStateRootForTests();
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("migration permits distinct slugs on one date and blocks each missing IG companion", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "sce-migrate-source-"));
  const target = mkdtempSync(join(tmpdir(), "sce-migrate-target-"));
  const sourceCompanies = join(sourceRoot, "companies");
  try {
    const weeks = join(sourceCompanies, "owl-standard", "weeks");
    mkdirSync(weeks, { recursive: true });
    writeFileSync(join(weeks, "a.json"), JSON.stringify({
      posts: [{ slug: "2026-08-03-01", date: "2026-08-03", fbPostId: "fb-1" }],
    }));
    writeFileSync(join(weeks, "b.json"), JSON.stringify({
      posts: [{ slug: "2026-08-03-02", date: "2026-08-03", fbPostId: "fb-2" }],
    }));
    const report = migrateState(target, { sourceCompanies, sourceRoot });
    assert.deepEqual(report.uncertainClaims.sort(), [
      "owl-standard/2026-08-03-01/ig",
      "owl-standard/2026-08-03-02/ig",
    ]);
    assert.deepEqual(report.seededClaims.sort(), [
      "owl-standard/2026-08-03-01/fb",
      "owl-standard/2026-08-03-02/fb",
    ]);
    for (const slug of ["2026-08-03-01", "2026-08-03-02"]) {
      assert.equal(JSON.parse(readFileSync(join(target, "publish-ledger", "owl-standard", `${slug}.fb.json`), "utf8")).status, "confirmed");
      assert.equal(JSON.parse(readFileSync(join(target, "publish-ledger", "owl-standard", `${slug}.ig.json`), "utf8")).status, "uncertain");
    }
  } finally {
    delete process.env.STATE_DIR;
    resetStateRootForTests();
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
