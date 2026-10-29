import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { postingFreezePath, readPostingControl } from "./publishable.mjs";

const enoent = () => {
  const error = new Error("missing");
  error.code = "ENOENT";
  throw error;
};

const cloudEnv = (extra = {}) => ({
  CLOUD: "1",
  STATE_DIR: resolve("durable-test-state"),
  ...extra,
});
const noCloudFreeze = (path) => {
  if (path.endsWith("POSTING_FROZEN")) return enoent();
};

test("cloud publishing fails closed without a positive durable environment signal", () => {
  const control = readPostingControl({ env: cloudEnv(), stat: noCloudFreeze });
  assert.equal(control.enabled, false);
  assert.equal(control.kind, "cloud_not_enabled");
});

test("cloud publishing requires exactly PUBLISHING_ENABLED=1", () => {
  assert.equal(readPostingControl({ env: cloudEnv({ PUBLISHING_ENABLED: "true" }), stat: noCloudFreeze }).enabled, false);
  assert.equal(readPostingControl({ env: cloudEnv({ PUBLISHING_ENABLED: "1" }), stat: noCloudFreeze }).enabled, true);
});

test("POSTING_FROZEN overrides a positive cloud signal", () => {
  const control = readPostingControl({
    env: cloudEnv({ PUBLISHING_ENABLED: "1" }),
    stat: () => {},
    read: () => "owner freeze",
  });
  assert.deepEqual(
    { enabled: control.enabled, kind: control.kind, reason: control.reason },
    { enabled: false, kind: "frozen", reason: "owner freeze" },
  );
});

test("an unreadable freeze control fails closed", () => {
  const error = new Error("denied");
  error.code = "EACCES";
  const control = readPostingControl({
    env: cloudEnv({ PUBLISHING_ENABLED: "1" }),
    stat: (path) => {
      if (path.endsWith("POSTING_FROZEN")) throw error;
    },
  });
  assert.equal(control.enabled, false);
  assert.equal(control.kind, "control_unreadable");
});

test("cloud emergency stop resolves on durable state, not the deploy checkout", () => {
  const env = cloudEnv({ PUBLISHING_ENABLED: "1" });
  const expected = resolve(env.STATE_DIR, "secrets", "POSTING_FROZEN");
  const calls = [];
  const control = readPostingControl({
    env,
    stat: (path) => {
      calls.push(path);
      if (path === expected) return enoent();
    },
  });
  assert.equal(postingFreezePath(env), expected);
  assert.deepEqual(calls, [dirname(expected), expected]);
  assert.equal(control.enabled, true);
});

test("missing STATE_DIR or emergency-stop directory fails cloud publishing closed", () => {
  const missingRoot = readPostingControl({
    env: { CLOUD: "1", PUBLISHING_ENABLED: "1" },
    stat: () => {},
  });
  assert.equal(missingRoot.kind, "control_unreadable");

  const missingDirectory = readPostingControl({
    env: cloudEnv({ PUBLISHING_ENABLED: "1" }),
    stat: enoent,
  });
  assert.equal(missingDirectory.enabled, false);
  assert.equal(missingDirectory.kind, "control_unreadable");
  assert.match(missingDirectory.reason, /emergency-stop directory unavailable/);
});

// --- booking window + Instagram mirroring (2026-09-18 review fixes) ---
import { instagramDue, lastBookableDate } from "./publishable.mjs";

test("the Facebook booking window ends 29 days out (Meta refuses beyond 30)", () => {
  assert.equal(lastBookableDate("2026-09-18"), "2026-10-17");
  assert.equal(lastBookableDate("2026-12-20"), "2027-01-18");
});

test("Instagram posts only an approved, Facebook-booked post on its own day or the day after", () => {
  const post = { slug: "2026-W40-01", date: "2026-10-02", status: "approved", fbPostId: "1_2" };
  assert.equal(instagramDue(post, "2026-10-02", "2026-10-01").due, true);
  assert.equal(instagramDue(post, "2026-10-03", "2026-10-02").due, true, "recovers a missed run next day");
  assert.equal(instagramDue(post, "2026-10-01", "2026-09-30").due, false, "not due before its date");
  assert.match(instagramDue(post, "2026-10-09", "2026-10-08").reason, /not posting late/, "no backlog dumps");
  assert.match(instagramDue({ ...post, fbPostId: undefined }, "2026-10-02", "2026-10-01").reason, /never posts alone/);
  assert.equal(instagramDue({ ...post, status: "generated" }, "2026-10-02", "2026-10-01").due, false, "not approved");
  assert.equal(instagramDue({ ...post, igPostId: "9" }, "2026-10-02", "2026-10-01").due, false, "already posted");
  assert.equal(instagramDue({ ...post, error: "poster-qa: x" }, "2026-10-02", "2026-10-01").due, false, "broken");
});
