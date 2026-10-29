// migrate-state.mjs — one-time, idempotent copy from the legacy checkout layout to persistent STATE_DIR.
// It never deletes source state and never overwrites a different destination file.
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { configPath } from "./lib/paths.mjs";
import {
  claimSlot,
  confirmSlot,
  markUncertain,
  PublishConflictError,
} from "./lib/publish-ledger.mjs";

const FILE_NAMES = new Set(["topics-ledger.json", "topic-coverage.json", "ig-fill.json", "active-week.json"]);
const DIR_NAMES = new Set(["weeks", "captions", "concepts", "posters", "research", "samples", "derived", "_probe", ".bg-cache"]);
const IG_ENABLED = new Set(["owl-standard"]);  // Owl Standard runs FB + IG (companies/owl-standard/company.md)

function sameFile(a, b) {
  const sa = statSync(a), sb = statSync(b);
  return sa.size === sb.size && readFileSync(a).equals(readFileSync(b));
}

function copyTree(source, target, report) {
  if (statSync(source).isDirectory()) {
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry), report);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    report.copied.push(target);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (sameFile(source, target)) report.skipped.push(target);
    else report.conflicts.push(target);
  }
}

export function migrateState(targetRoot, { sourceCompanies = configPath("companies"), sourceRoot = configPath() } = {}) {
  if (!targetRoot) throw new Error("Target STATE_DIR is required.");
  const target = resolve(targetRoot);
  const report = { copied: [], skipped: [], conflicts: [], seededClaims: [], uncertainClaims: [], existingClaims: [] };
  for (const brand of readdirSync(sourceCompanies).sort()) {
    if (brand.startsWith("_")) continue;
    const sourceBrand = join(sourceCompanies, brand);
    if (!statSync(sourceBrand).isDirectory()) continue;
    for (const entry of readdirSync(sourceBrand).sort()) {
      if (!FILE_NAMES.has(entry) && !DIR_NAMES.has(entry) && !entry.startsWith("topic-coverage.")) continue;
      const source = join(sourceBrand, entry);
      if (!existsSync(source)) continue;
      copyTree(source, join(target, "companies", brand, entry), report);
    }
  }
  for (const entry of ["publish-ledger", "ops"]) {
    const source = join(sourceRoot, entry);
    if (existsSync(source)) copyTree(source, join(target, entry), report);
  }

  const sourceLogs = join(sourceRoot, "logs");
  if (existsSync(sourceLogs)) copyTree(sourceLogs, join(target, "logs"), report);

  // Manifest IDs normally seed confirmed claims by immutable content identity. Duplicate IDs for one
  // slug/channel and IG-enabled posts with a missing IG id are uncertain. Distinct slugs may share a date.
  const previousStateDir = process.env.STATE_DIR;
  process.env.STATE_DIR = target;
  try {
    const targetCompanies = join(target, "companies");
    const slots = new Map();
    if (existsSync(targetCompanies)) {
      for (const brand of readdirSync(targetCompanies).sort()) {
        const weeks = join(targetCompanies, brand, "weeks");
        if (!existsSync(weeks)) continue;
        for (const file of readdirSync(weeks).filter((name) => name.endsWith(".json") && !name.startsWith("_")).sort()) {
          let manifest;
          try { manifest = JSON.parse(readFileSync(join(weeks, file), "utf8")); } catch { continue; }
          for (const post of manifest.posts || []) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date || "") || !post.slug) continue;
            const add = (channel, id, note = "") => {
              const key = `${brand}|${post.slug}|${channel}`;
              const current = slots.get(key) || {
                slot: { brand, slug: post.slug, channel, planned_date: post.date },
                ids: new Set(),
                sources: [],
                notes: [],
              };
              if (id) current.ids.add(String(id));
              current.sources.push(`companies/${brand}/weeks/${file}`);
              if (note) current.notes.push(note);
              slots.set(key, current);
            };
            for (const [channel, field] of [["fb", "fbPostId"], ["ig", "igPostId"]]) {
              if (post[field] && post[field] !== "SKIP-PAST") add(channel, post[field]);
            }
            if (IG_ENABLED.has(brand) && post.fbPostId && !post.igPostId) {
              add("ig", null, `IG id missing beside FB id ${post.fbPostId}`);
            }
          }
        }
      }
    }
    for (const current of slots.values()) {
      const ids = [...current.ids];
      const uncertain = ids.length !== 1 || current.notes.length > 0;
      const label = `${current.slot.brand}/${current.slot.slug}/${current.slot.channel}`;
      try {
        const claim = claimSlot(current.slot, { actor: "migrate-state" });
        if (uncertain) {
          markUncertain(claim, new Error(`Historical reconciliation required; ids=${ids.join(",") || "missing"}; ${current.notes.join("; ")}`));
          report.uncertainClaims.push(label);
        } else {
          confirmSlot(claim, { ids, sources: [...new Set(current.sources)] });
          report.seededClaims.push(label);
        }
      } catch (error) {
        if (error instanceof PublishConflictError) report.existingClaims.push(label);
        else throw error;
      }
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = previousStateDir;
  }
  // Copy only named runtime records from secrets/. Never enumerate/copy credentials, .env files, profiles,
  // or POSTING_FROZEN; the migration must not turn a state move into secret exfiltration.
  for (const relative of [
    "secrets/alert-state.json",
    "secrets/gatekeeper-state.json",
    "secrets/infra-repair-state.json",
  ]) {
    const source = join(sourceRoot, relative);
    if (existsSync(source)) copyTree(source, join(target, relative), report);
  }
  return report;
}

if (process.argv[1] && basename(process.argv[1]) === "migrate-state.mjs") {
  const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
  const target = targetArg?.slice("--target=".length) || process.env.STATE_DIR;
  if (!target) {
    console.error("STATE_DIR is required (set it or pass --target=<path>).");
    process.exit(2);
  }
  const report = migrateState(target);
  for (const path of report.copied) console.log(`COPIED=${path}`);
  for (const path of report.skipped) console.log(`SKIPPED=${path}`);
  for (const path of report.conflicts) console.error(`CONFLICT=${path}`);
  for (const slot of report.seededClaims) console.log(`SEEDED_CLAIM=${slot}`);
  for (const slot of report.uncertainClaims) console.error(`UNCERTAIN_CLAIM=${slot}`);
  for (const slot of report.existingClaims) console.log(`EXISTING_CLAIM=${slot}`);
  console.log(`SUMMARY copied=${report.copied.length} skipped=${report.skipped.length} conflicts=${report.conflicts.length} seeded_claims=${report.seededClaims.length} uncertain_claims=${report.uncertainClaims.length} existing_claims=${report.existingClaims.length}`);
  if (report.conflicts.length) process.exitCode = 3;
}
