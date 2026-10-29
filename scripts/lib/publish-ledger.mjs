// lib/publish-ledger.mjs — a local transaction boundary in front of every live publish.
// The 2026-W28 duplicate-date records proved remote lookups are not an idempotency boundary. A slot is
// therefore blocked atomically before the commit call, and ambiguity always costs availability, not a duplicate.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runtimePath } from "./paths.mjs";

const VALID_CHANNELS = new Set(["fb", "ig"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const UNCERTAIN_ALERT_AFTER_MS = 24 * 60 * 60 * 1000;

export class PublishConflictError extends Error {
  constructor(slot, record) {
    super(`Publish identity conflict for ${slot.brand}/${slot.slug}/${slot.channel}; existing status=${record?.status || "uncertain"}.`);
    this.name = "PublishConflictError";
    this.kind = "publish_conflict";
    this.slot = slot;
    this.record = record;
  }
}

export class ConfirmedPublishError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConfirmedPublishError";
    this.kind = "confirmed_publish_failure";
    this.confirmedFailure = true;
  }
}

function validateSlot({ brand, slug, channel, planned_date }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(brand || "")) throw new TypeError(`Invalid brand: ${brand}`);
  if (!SLUG_RE.test(slug || "")) throw new TypeError(`Invalid slug: ${slug}`);
  if (!VALID_CHANNELS.has(channel)) throw new TypeError(`Invalid channel: ${channel}`);
  if (!DATE_RE.test(planned_date || "")) throw new TypeError(`Invalid planned_date: ${planned_date}`);
}

export function slotPath(slot) {
  validateSlot(slot);
  return runtimePath("publish-ledger", slot.brand, `${slot.slug}.${slot.channel}.json`);
}

export function readSlot(slot) {
  const path = slotPath(slot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...slot, status: "uncertain", note: "ledger record is incomplete or unparseable" };
  }
}

function replaceRecord(path, record) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temp, path);
}

export function claimSlot(slot, { actor = `${process.pid}`, claimGroupId = randomUUID() } = {}) {
  validateSlot(slot);
  const path = slotPath(slot);
  mkdirSync(dirname(path), { recursive: true });
  const claimId = randomUUID();
  const record = {
    ...slot,
    status: "uncertain",
    phase: "claimed",
    claim_id: claimId,
    claim_group_id: claimGroupId,
    claimed_at: new Date().toISOString(),
    actor,
  };
  let fd;
  try {
    fd = openSync(path, "wx");
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (cause) {
    if (cause?.code === "EEXIST") throw new PublishConflictError(slot, readSlot(slot));
    throw cause;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { path, claimId, record };
}

function assertOwner(claim) {
  const current = readSlot(claim.record);
  if (!current || current.claim_id !== claim.claimId) {
    throw new PublishConflictError(claim.record, current);
  }
  return current;
}

export function confirmSlot(claim, remote = {}) {
  const current = assertOwner(claim);
  const record = {
    ...current,
    status: "confirmed",
    phase: "confirmed",
    confirmed_at: new Date().toISOString(),
    remote,
  };
  replaceRecord(claim.path, record);
  return record;
}

export function markUncertain(claim, error) {
  const current = assertOwner(claim);
  const record = {
    ...current,
    status: "uncertain",
    phase: "ambiguous_outcome",
    uncertain_at: new Date().toISOString(),
    error: String(error?.message || error),
  };
  replaceRecord(claim.path, record);
  return record;
}

export function releaseClaim(claim, reason = "confirmed failure") {
  assertOwner(claim);
  unlinkSync(claim.path);
  return { released: true, reason };
}

export function forceReleaseSlot(slot) {
  const path = slotPath(slot);
  const previous = readSlot(slot);
  if (!previous) return { released: false, previous: null, path };
  unlinkSync(path);
  return { released: true, previous, path };
}

/**
 * Resolve a slot that is stuck `uncertain` INTO `confirmed`, using an identity read back from Meta.
 *
 * Added 2026-08-04 with scripts/repair.mjs. `confirmSlot` cannot be used here: it asserts the caller
 * owns the original claim, and the process that made the claim is long dead — that is precisely why
 * the record is stuck. This is the narrow, deliberate exception, and it is narrow in three ways:
 *   • it refuses anything whose status is not `uncertain`, so it can never rewrite a confirmed slot;
 *   • it demands a remote id, because a confirmation with no identity is not a confirmation;
 *   • it records HOW it was resolved (`resolved_by`), so a repaired slot is never mistaken for one
 *     confirmed by the publisher itself.
 * The judgement of whether Meta really has the post lives in meta-publication.mjs; this only writes.
 */
export function adoptUncertainSlot(slot, remote = {}, { resolvedBy = "repair", nowIso = new Date().toISOString() } = {}) {
  const path = slotPath(slot);
  const current = readSlot(slot);
  if (!current) throw new PublishConflictError(slot, null);
  if (current.status !== "uncertain") {
    throw new PublishConflictError(slot, current);
  }
  if (!remote?.id) throw new TypeError("adoptUncertainSlot requires the remote id read back from Meta");
  const record = {
    ...current,
    status: "confirmed",
    phase: "confirmed_by_verification",
    confirmed_at: nowIso,
    resolved_by: resolvedBy,
    remote,
  };
  replaceRecord(path, record);
  return record;
}

/** Preserve historical manifest IDs during migration without overwriting an existing slot decision. */
export function seedConfirmedSlot(slot, remote = {}) {
  try {
    const claim = claimSlot(slot, { actor: "migrate-state" });
    return { seeded: true, record: confirmSlot(claim, remote) };
  } catch (error) {
    if (error instanceof PublishConflictError) return { seeded: false, record: error.record };
    throw error;
  }
}

export function claimChannels(brand, slug, channels, planned_date, options) {
  const claims = [];
  try {
    for (const channel of channels) claims.push(claimSlot({ brand, slug, channel, planned_date }, options));
    return claims;
  } catch (error) {
    // No remote action happened yet, so partially acquired multi-channel claims are safe to release.
    for (const claim of claims) releaseClaim(claim, "multi-channel claim rollback");
    throw error;
  }
}

export async function publishClaimed({ brand, slug, channels, plannedDate, publish, actor }) {
  const claimGroupId = randomUUID();
  const claims = claimChannels(brand, slug, channels, plannedDate, { actor, claimGroupId });
  try {
    const remote = await publish();
    for (const claim of claims) confirmSlot(claim, remote || {});
    return remote;
  } catch (error) {
    if (error?.confirmedFailure) {
      for (const claim of claims) releaseClaim(claim, error.message);
    } else {
      for (const claim of claims) markUncertain(claim, error);
    }
    throw error;
  }
}

function walkJson(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkJson(path, out);
    else if (entry.name.endsWith(".json")) out.push(path);
  }
  return out;
}

export function findStaleUncertainSlots({
  nowMs = Date.now(),
  olderThanMs = UNCERTAIN_ALERT_AFTER_MS,
} = {}) {
  const root = runtimePath("publish-ledger");
  const stale = [];
  for (const path of walkJson(root)) {
    let record;
    try { record = JSON.parse(readFileSync(path, "utf8")); }
    catch {
      stale.push({ path, status: "uncertain", phase: "unparseable", age_ms: Infinity });
      continue;
    }
    if (record.status !== "uncertain") continue;
    const since = Date.parse(record.uncertain_at || record.claimed_at || "");
    const ageMs = Number.isFinite(since) ? nowMs - since : Infinity;
    if (ageMs >= olderThanMs) stale.push({ ...record, path, age_ms: ageMs });
  }
  return stale;
}

/**
 * Reaper is deliberately alert-only. An uncertain record may mean Meta accepted
 * the publish before the process died, so automatic release would recreate the
 * double-post window. Visibility is restored without weakening the fail-closed block.
 */
export async function alertStaleUncertainSlots({
  alert,
  nowMs = Date.now(),
  olderThanMs = UNCERTAIN_ALERT_AFTER_MS,
} = {}) {
  if (typeof alert !== "function") throw new TypeError("alert callback is required");
  const stale = findStaleUncertainSlots({ nowMs, olderThanMs });
  if (!stale.length) return [];
  const identities = stale
    .map((record) => `${record.brand || "?"}/${record.slug || "?"}/${record.channel || "?"}`)
    .join(", ");
  await alert({
    source: "publish-ledger",
    kind: "stale-uncertain",
    severity: "crucial",
    text:
      `🔴 Publishing is blocked by ${stale.length} stale uncertain ledger record(s): ${identities}. ` +
      "Verify Meta before using the force-release command.",
  });
  return stale;
}
