// scripts/repair.mjs — SCE-Repair: the missing REPAIR layer.
//
// WHY THIS JOB EXISTS (2026-08-04, owner's words)
//   "There should be a self-healing and self-repair process running on the cloud, instead of me
//    getting involved."
//
//   Every failure path in this engine was already excellent at three of the four steps: DO, DETECT,
//   ESCALATE. The fourth — REPAIR — existed only for Windows infrastructure (infra-repair-core.mjs,
//   2026-06-28) and for one poster defect (poster-regen.mjs, 2026-07-31). Everywhere else, "detected"
//   went straight to "tell the owner", and the owner WAS the repair layer. On 2026-08-04 that showed
//   up as: five ledger slots blocked for days with IG exiting 3 every morning, and posts still broken
//   from a credit outage that had been over for a day.
//
//   This job asks, for each stuck thing, the question nobody was asking — "is this still true, and
//   can I fix it?" — and escalates ONLY what a machine genuinely cannot resolve.
//
// THE RULE IT ENCODES, WHICH IS THE POINT
//   A fail-closed block must ship with its resolution path. Blocking is half a mechanism; the other
//   half is who unblocks it, and if the answer is "a person", that must be a deliberate choice
//   rather than the default that nobody noticed making.
//
//   node scripts/repair.mjs --dry     # report everything, change NOTHING (how to learn live state)
//   node scripts/repair.mjs           # repair

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { assertStateDir, companyStatePath, runtimePath, ensureStateParent } from "./lib/paths.mjs";
import {
  findStaleUncertainSlots, forceReleaseSlot, adoptUncertainSlot, UNCERTAIN_ALERT_AFTER_MS,
} from "./lib/publish-ledger.mjs";
import { fetchFacebookInventory } from "./lib/meta-dedup.mjs";
import { lookupInstagramPublication, lookupFacebookPublication } from "./lib/meta-publication.mjs";
import {
  REPAIR_ACTIONS, planLedgerRepair, planContentRepair, isRepairableBreak, slotKey,
  rotateForFairness, advanceCursor, shouldAttemptRepair, recordRepairAttempt,
  LEDGER_REPAIR_DAILY_CAP, CONTENT_REPAIR_DAILY_CAP,
} from "./lib/publish-repair-core.mjs";
import { CONTENT_REPAIR_REGISTRY, isContentRepairSupported } from "./lib/content-repair.mjs";
import { FB_TOKEN_SLOTS } from "./lib/fb-token-probe.mjs";
import { getEnv } from "./lib/env.mjs";
import { escalate, resolve as resolveAlert } from "./lib/alert.mjs";
import { hkTodayStr } from "./lib/watchdog-core.mjs";

export const BRANDS = Object.freeze(["owl-standard"]);
export const REPAIR_STATE_FILE = () => runtimePath("secrets", "repair-state.json");
export const REPAIR_JOURNAL_FILE = () => runtimePath("secrets", "repair-journal.jsonl");

// ── durable bookkeeping ──────────────────────────────────────────────────────────────────────────
export function loadRepairState({ read = readFileSync, exists = existsSync, file = REPAIR_STATE_FILE } = {}) {
  try {
    const path = file();
    if (!exists(path)) return { ledger: {}, content: {}, cursor: 0 };
    const parsed = JSON.parse(read(path, "utf8"));
    return { ledger: parsed.ledger || {}, content: parsed.content || {}, cursor: Number(parsed.cursor) || 0 };
  } catch { return { ledger: {}, content: {}, cursor: 0 }; }
}

export function saveRepairState(state, { write = writeFileSync, file = REPAIR_STATE_FILE } = {}) {
  try { write(ensureStateParent(file()), `${JSON.stringify(state, null, 2)}\n`, "utf8"); } catch {}
}

// A repair that leaves no trace is indistinguishable from a repair that never happened — and this
// job's whole promise is that the owner can stop watching. One append-only line per action.
export function journal(entry, { append = (path, line) => writeFileSync(path, line, { flag: "a" }), file = REPAIR_JOURNAL_FILE } = {}) {
  try { append(ensureStateParent(file()), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch {}
}

// ── reading the week manifests ───────────────────────────────────────────────────────────────────
export function weekFilesFor(brand, { readdir = readdirSync, exists = existsSync } = {}) {
  const dir = companyStatePath(brand, "weeks");
  if (!exists(dir)) return [];
  return readdir(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort().map((f) => `${dir}/${f}`);
}

export function findPostBySlug(brand, slug, deps = {}) {
  for (const path of weekFilesFor(brand, deps)) {
    let week;
    try { week = JSON.parse((deps.read || readFileSync)(path, "utf8")); } catch { continue; }
    const post = (week.posts || []).find((p) => p.slug === slug);
    if (post) return { post, week, path };
  }
  return null;
}

// ── REPAIRER 1: stuck ledger slots ───────────────────────────────────────────────────────────────
export async function repairLedgerSlots({
  dry = false,
  nowMs = Date.now(),
  state,
  todayStr,
  findStale = findStaleUncertainSlots,
  lookupIg = lookupInstagramPublication,
  lookupFb = lookupFacebookPublication,
  adopt = adoptUncertainSlot,
  release = forceReleaseSlot,
  findPost = findPostBySlug,
  tokenFor = (brand) => getEnv(FB_TOKEN_SLOTS[brand] || ""),
  log = console.log,
  record = journal,
} = {}) {
  const stale = findStale({ nowMs });
  const repaired = [];
  const held = [];

  for (const row of stale) {
    const slot = { brand: row.brand, slug: row.slug, channel: row.channel, planned_date: row.planned_date };
    const key = slotKey(row);
    const found = findPost(row.brand, row.slug);
    const token = tokenFor(row.brand);

    let verdict;
    if (!found) {
      verdict = { state: "undetermined", reason: `no week manifest holds post ${row.slug} — cannot recover its caption to identify the post` };
    } else if (!token) {
      verdict = { state: "undetermined", reason: `no page token configured for ${row.brand} (${FB_TOKEN_SLOTS[row.brand] || "no slot"})` };
    } else if (row.channel === "ig") {
      verdict = await lookupIg({ record: row, caption: found.post.caption, token });
    } else if (row.channel === "fb") {
      verdict = await lookupFb({ record: row, caption: found.post.caption, token, deps: { fetchInventory: fetchFacebookInventory } });
    } else {
      verdict = { state: "undetermined", reason: `unknown channel ${row.channel}` };
    }

    const plan = planLedgerRepair({
      record: row,
      verdict,
      ageMs: row.age_ms,
      attemptsToday: attemptsFor(state.ledger, key, todayStr),
    });
    log(`  ledger ${key}: ${verdict.state} → ${plan.action} — ${plan.reason}`);

    if (plan.action === REPAIR_ACTIONS.HOLD) {
      held.push({ key, reason: plan.reason, escalate: plan.escalate });
      continue;
    }
    if (dry) { repaired.push({ key, action: plan.action, reason: `${plan.reason} (dry — not applied)`, dry: true }); continue; }

    state.ledger = recordRepairAttempt(state.ledger, key, todayStr);
    try {
      if (plan.action === REPAIR_ACTIONS.CONFIRM) {
        adopt(slot, { id: plan.remoteId, source: "meta-publication-verifier" });
        // The ledger now knows; the week manifest must agree, or the publisher will try again.
        if (found) {
          const field = row.channel === "ig" ? "igPostId" : "fbPostId";
          if (!found.post[field]) {
            found.post[field] = plan.remoteId;
            writeFileSync(found.path, JSON.stringify(found.week, null, 2), "utf8");
          }
        }
      } else {
        release(slot);
      }
      repaired.push({ key, action: plan.action, reason: plan.reason });
      record({ repairer: "ledger", key, action: plan.action, verdict: verdict.state, reason: plan.reason, remoteId: plan.remoteId });
    } catch (error) {
      const reason = `repair write failed: ${error?.message || error}`;
      log(`  ledger ${key}: ${reason}`);
      held.push({ key, reason, escalate: true });
    }
  }

  return { stale, repaired, held };
}

function attemptsFor(bucket, key, todayStr) {
  const entry = (bucket || {})[key];
  return entry && entry.date === todayStr ? (entry.attempts || 0) : 0;
}

// ── REPAIRER 2: posts left broken by a generation failure ────────────────────────────────────────
export async function repairBrokenContent({
  dry = false,
  state,
  todayStr,
  brands = BRANDS,
  providerHealthy,
  regenerate,
  log = console.log,
  record = journal,
} = {}) {
  const repaired = [];
  const held = [];
  const seen = [];
  // Rotate so a run that dies mid-sweep does not always starve the same tail brand.
  const order = rotateForFairness(brands, state.cursor);

  for (const brand of order) {
    for (const path of weekFilesFor(brand)) {
      let week;
      try { week = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
      let changed = false;

      for (const post of week.posts || []) {
        if (!isRepairableBreak(post) && !String(post.error || "").startsWith("poster-qa:")) continue;
        const key = `${brand}/${post.slug}`;
        const plan = planContentRepair({
          post, providerHealthy, todayStr, attemptsToday: attemptsFor(state.content, key, todayStr),
        });
        seen.push({ key, date: post.date, error: String(post.error || post.status || "").slice(0, 120), plan: plan.action, reason: plan.reason });

        if (plan.action !== "regenerate") {
          log(`  content ${key} (${post.date}): skip — ${plan.reason}`);
          if (plan.escalate) held.push({ key, reason: plan.reason, escalate: true });
          continue;
        }
        if (!isContentRepairSupported(brand)) {
          const reason = CONTENT_REPAIR_REGISTRY[brand]?.reason || "brand not wired for content repair";
          log(`  content ${key}: UNSUPPORTED — ${reason}`);
          held.push({ key, reason: `cannot auto-regenerate: ${reason}`, escalate: true });
          continue;
        }
        if (dry) { repaired.push({ key, reason: "would regenerate (dry — not applied)", dry: true }); continue; }

        state.content = recordRepairAttempt(state.content, key, todayStr);
        const result = await regenerate(brand, post);
        if (result.ok) {
          Object.assign(post, result.patch);
          delete post.error;
          changed = true;
          repaired.push({ key, reason: result.reason });
          record({ repairer: "content", key, action: "regenerate", reason: result.reason });
          log(`  content ${key}: ✅ ${result.reason}`);
        } else {
          log(`  content ${key}: ❌ ${result.reason}`);
          held.push({ key, reason: result.reason, escalate: !result.unsupported });
        }
      }

      if (changed && !dry) writeFileSync(path, JSON.stringify(week, null, 2), "utf8");
    }
  }

  state.cursor = advanceCursor(state.cursor, order.length, brands.length);
  return { repaired, held, seen };
}

// ── the job ──────────────────────────────────────────────────────────────────────────────────────
export async function runRepair({ dry = false, log = console.log } = {}) {
  const nowMs = Date.now();
  const todayStr = hkTodayStr(nowMs);
  const state = loadRepairState();

  log(`SCE-Repair ${dry ? "(DRY — nothing will change)" : ""} · ${todayStr} · uncertain-threshold ${UNCERTAIN_ALERT_AFTER_MS / 3600000}h`);

  log("ledger slots:");
  const ledger = await repairLedgerSlots({ dry, nowMs, state, todayStr, log });

  // Ask ONCE whether the writing provider is up. planContentRepair skips quietly when it is not,
  // because preflight.mjs already owns that alarm and two alarms for one fault is noise.
  const providerHealthy = await probeProvider();
  log(`content (writing provider: ${providerHealthy ? "healthy" : "NOT healthy — regeneration skipped, preflight owns that alarm"}):`);
  const { regenerateContent } = await import("./lib/content-repair.mjs");
  const [{ loadLedger }, { writeCaption }, { deriveConcept, writeConceptFile }] = await Promise.all([
    // loadLedger now comes from Owl Standard's own topic engine — the old shared lib/ledger.mjs was
    // hardwired to companies/better-life and was deleted with that tenant.
    import("./owl-standard/topic-engine.mjs"), import("./write-caption.mjs"), import("./derive-concept.mjs"),
  ]);
  const content = await repairBrokenContent({
    dry, state, todayStr, providerHealthy, log,
    regenerate: (brand, post) => regenerateContent(brand, post, {
      loadLedger, writeCaption, deriveConcept, writeConceptFile,
    }),
  });

  if (!dry) saveRepairState(state);

  const summary =
    `SCE-Repair: ${ledger.repaired.length} ledger slot(s) resolved, ${ledger.held.length} still blocked · ` +
    `${content.repaired.length} post(s) regenerated, ${content.held.length} still broken${dry ? " (DRY)" : ""}`;
  log(summary);
  for (const row of content.seen) log(`  seen: ${row.key} ${row.date} [${row.plan}] ${row.error}`);

  // ESCALATE ONLY WHAT A MACHINE CANNOT RESOLVE. Everything else was just fixed and needs no message
  // — the whole point is that the owner stops being the repair layer.
  const needsPerson = [...ledger.held, ...content.held].filter((h) => h.escalate);
  if (!dry) {
    if (needsPerson.length) {
      await escalate({
        source: "repair",
        kind: `unrepairable:${needsPerson.length}`,
        severity: "crucial",
        text:
          `🔧 自動修復做唔到 ${needsPerson.length} 項，要你睇下：\n` +
          needsPerson.slice(0, 10).map((h) => `• ${h.key} — ${h.reason}`).join("\n") +
          (ledger.repaired.length || content.repaired.length
            ? `\n\n（同時自動修好咗 ${ledger.repaired.length + content.repaired.length} 項，唔使你做嘢。）`
            : ""),
      });
    } else {
      resolveAlert("repair", "unrepairable");
    }
  }

  return { ledger, content, summary, needsPerson };
}

async function probeProvider() {
  try {
    const { askText } = await import("./lib/anthropic.mjs");
    await askText("hi", { maxTokens: 1 });
    return true;
  } catch { return false; }
}

if (process.env.SCE_IMPORT_ONLY !== "1") {
  assertStateDir();
  // REPAIR_DRY=1 gives the same safety as --dry for a run triggered by RUN_JOB_ONCE, which can only
  // launch a job with its REGISTERED args. The first cloud run of a repairer that can touch live
  // client accounts should MEASURE, not act — "measure with instruments, reason with models".
  const result = await runRepair({ dry: process.argv.includes("--dry") || getEnv("REPAIR_DRY") === "1" });
  // A repair job that could not repair something a person must handle is not a healthy exit.
  if (result.needsPerson.length) process.exitCode = 2;
}
