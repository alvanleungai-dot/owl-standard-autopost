import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  claimSlot,
  confirmSlot,
  ConfirmedPublishError,
  alertStaleUncertainSlots,
  publishClaimed,
  readSlot,
  releaseClaim,
  PublishConflictError,
} from "./publish-ledger.mjs";
import { resetStateRootForTests } from "./paths.mjs";

let root;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sce-ledger-"));
  process.env.STATE_DIR = root;
  resetStateRootForTests();
});
test.afterEach(() => {
  delete process.env.STATE_DIR;
  resetStateRootForTests();
  rmSync(root, { recursive: true, force: true });
});

const slot = { brand: "tml", slug: "2026-08-03-01", channel: "fb", planned_date: "2026-08-03" };

test("claim blocks a second claimant and starts uncertain", () => {
  const claim = claimSlot(slot);
  assert.equal(readSlot(slot).status, "uncertain");
  assert.throws(() => claimSlot(slot), PublishConflictError);
  releaseClaim(claim);
});

test("confirmed failures release but ambiguous failures stay uncertain", async () => {
  await assert.rejects(
    publishClaimed({ brand: "tml", slug: slot.slug, channels: ["fb"], plannedDate: slot.planned_date, publish: async () => {
      throw new ConfirmedPublishError("API rejected request");
    } }),
    ConfirmedPublishError,
  );
  assert.equal(readSlot(slot), null);

  await assert.rejects(
    publishClaimed({ brand: "tml", slug: slot.slug, channels: ["fb"], plannedDate: slot.planned_date, publish: async () => {
      throw new Error("socket reset");
    } }),
    /socket reset/,
  );
  assert.equal(readSlot(slot).status, "uncertain");
});

test("confirmed claim remains blocked", () => {
  const claim = claimSlot(slot);
  confirmSlot(claim, { id: "remote-1" });
  assert.equal(readSlot(slot).status, "confirmed");
  assert.throws(() => claimSlot(slot), PublishConflictError);
});

test("two slugs may share a planned date but moving one slug does not create a new identity", () => {
  const first = claimSlot(slot);
  const secondSlot = { ...slot, slug: "2026-08-03-02" };
  const second = claimSlot(secondSlot);
  assert.equal(readSlot(first.record).slug, slot.slug);
  assert.equal(readSlot(second.record).slug, secondSlot.slug);
  assert.throws(
    () => claimSlot({ ...slot, planned_date: "2026-08-10" }),
    PublishConflictError,
  );
});

test("two concurrent processes produce exactly one atomic winner", async () => {
  const worker = new URL("./publish-ledger.worker.mjs", import.meta.url);
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(worker), JSON.stringify(slot)], {
      env: { ...process.env, STATE_DIR: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 3]);
  assert.match(results.find((result) => result.code === 3).stderr, /conflict.*tml\/2026-08-03-01\/fb/i);
  assert.equal(JSON.parse(readFileSync(join(root, "publish-ledger", "tml", "2026-08-03-01.fb.json"))).status, "uncertain");
});

test("killing a process after claim leaves an uncertain slot that refuses the next run", async () => {
  const worker = new URL("./publish-ledger.worker.mjs", import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(worker), JSON.stringify(slot), "--hold"], {
    env: { ...process.env, STATE_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("CLAIMED")) resolve();
    });
    child.on("error", reject);
  });
  child.kill();
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(readSlot(slot).status, "uncertain");
  assert.throws(() => claimSlot(slot), PublishConflictError);
});

test("stale uncertain records trigger an owner alert and remain blocked", async () => {
  const claim = claimSlot(slot);
  const alerts = [];
  const stale = await alertStaleUncertainSlots({
    nowMs: Date.parse(claim.record.claimed_at) + 25 * 60 * 60 * 1000,
    alert: async (payload) => { alerts.push(payload); },
  });
  assert.equal(stale.length, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /tml\/2026-08-03-01\/fb/);
  assert.throws(() => claimSlot(slot), PublishConflictError);
});
