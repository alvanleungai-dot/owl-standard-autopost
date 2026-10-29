import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const INSTANCE_LEASE_NAME = ".sce-instance-lease.json";
export const INSTANCE_LEASE_MAX_AGE_MS = 5 * 60 * 1000;
const processOwnerToken = randomUUID();

export class SiblingInstanceError extends Error {
  constructor(owner) {
    super(`Sibling Render instance is active: ${owner.instance_id} (last seen ${owner.seen_at}).`);
    this.name = "SiblingInstanceError";
    this.kind = "sibling_instance";
    this.owner = owner;
  }
}

const instanceIdentity = (env) =>
  env.RENDER_INSTANCE_ID?.trim() ||
  env.SCE_INSTANCE_ID?.trim() ||
  hostname();

function recordOf(instanceId, nowMs) {
  return {
    instance_id: instanceId,
    seen_at: new Date(nowMs).toISOString(),
    pid: process.pid,
    owner_token: processOwnerToken,
  };
}

function createLease(path, record) {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function replaceLease(path, record) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temp, path);
}

export function assertSingleInstance({
  root,
  env = process.env,
  nowMs = Date.now(),
  maxAgeMs = INSTANCE_LEASE_MAX_AGE_MS,
} = {}) {
  if (!root) throw new TypeError("single-instance root is required");
  mkdirSync(root, { recursive: true });
  const path = join(root, INSTANCE_LEASE_NAME);
  const instanceId = instanceIdentity(env);
  const record = recordOf(instanceId, nowMs);
  try {
    createLease(path, record);
    return record;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let owner;
  try {
    owner = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new SiblingInstanceError({ instance_id: "unknown/unreadable", seen_at: "unknown", cause: String(cause) });
  }
  const seenMs = Date.parse(owner.seen_at);
  const fresh = Number.isFinite(seenMs) && nowMs - seenMs <= maxAgeMs;
  if (owner.instance_id !== instanceId && fresh) throw new SiblingInstanceError(owner);

  if (owner.instance_id === instanceId) {
    replaceLease(path, record);
    return record;
  }

  const stale = `${path}.stale.${randomUUID()}`;
  try {
    renameSync(path, stale);
  } catch (error) {
    if (error?.code === "ENOENT") return assertSingleInstance({ root, env, nowMs, maxAgeMs });
    throw error;
  }
  try {
    createLease(path, record);
  } finally {
    try { unlinkSync(stale); } catch {}
  }
  return record;
}

export function releaseSingleInstance({ root, lease } = {}) {
  if (!root) throw new TypeError("single-instance root is required");
  if (!lease?.instance_id || !lease?.owner_token) {
    throw new TypeError("owned single-instance lease record is required");
  }
  const path = join(root, INSTANCE_LEASE_NAME);
  let owner;
  try {
    owner = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const owned =
    owner.instance_id === lease.instance_id &&
    owner.pid === lease.pid &&
    owner.owner_token === lease.owner_token;
  if (!owned) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
