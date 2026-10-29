// Initialize and seed the durable Render state disk before the worker starts.
// Repeat-safe: existing files are never overwritten; differing runtime files are
// reported as conflicts and then verified in place.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  assertDurableStateRoot,
  configPath,
  DURABILITY_SENTINEL,
  DURABILITY_SENTINEL_CONTENT,
  StateDirError,
} from "./lib/paths.mjs";
import { migrateState } from "./migrate-state.mjs";

const SKELETON_DIRS = [
  "weeks",
  "captions",
  "concepts",
  "posters",
  "research",
  "samples",
  "derived",
];

function parseJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (cause) { throw new StateDirError(`${label} is missing or invalid JSON: ${path}`, { cause }); }
}

function brandsAt(sourceCompanies) {
  if (!existsSync(sourceCompanies)) {
    throw new StateDirError(`Source companies directory is missing: ${sourceCompanies}`);
  }
  return readdirSync(sourceCompanies)
    .filter((brand) => !brand.startsWith("_"))
    .filter((brand) => statSync(join(sourceCompanies, brand)).isDirectory())
    .sort();
}

function verifyJsonTree(root, label) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) count += verifyJsonTree(path, label);
    else if (entry.endsWith(".json")) {
      parseJson(path, label);
      count++;
    }
  }
  return count;
}

export function verifySeededState(root, { sourceCompanies = configPath("companies") } = {}) {
  const brands = brandsAt(sourceCompanies);
  if (!brands.length) throw new StateDirError("No source brands found; refusing to accept an empty state disk.");
  let manifests = 0;
  let ledgers = 0;

  for (const brand of brands) {
    // A brand whose checkout carries week history must find that history on the disk. A NEW brand
    // has no history to protect (Owl Standard started this way), so it only needs its ledger —
    // demanding seed weeks made the very first Render boot fail every time.
    const sourceWeeks = join(sourceCompanies, brand, "weeks");
    const targetWeeks = join(root, "companies", brand, "weeks");
    const weekFiles = existsSync(sourceWeeks)
      ? readdirSync(sourceWeeks).filter((name) => name.endsWith(".json") && !name.startsWith("_")).sort()
      : [];
    for (const file of weekFiles) {
      parseJson(join(targetWeeks, file), `${brand} week manifest`);
      manifests++;
    }

    const ledger = join(root, "companies", brand, "topics-ledger.json");
    parseJson(ledger, `${brand} topics ledger`);
    ledgers++;
  }

  const publishLedgers = verifyJsonTree(join(root, "publish-ledger"), "publish ledger record");
  return { brands: brands.length, manifests, ledgers, publishLedgers };
}

export function initStateDir(root, {
  sourceCompanies = configPath("companies"),
  sourceRoot = configPath(),
  assertRoot = assertDurableStateRoot,
} = {}) {
  const resolved = resolve(root || "");
  if (!root) throw new StateDirError("Pass --root=<mounted STATE_DIR> or set STATE_DIR.");

  // Validate the location before creating anything. The injected sentinel only
  // bypasses its existence check; checkout/temp rejection remains active.
  assertRoot(resolved, { exists: () => true, read: () => DURABILITY_SENTINEL_CONTENT });
  mkdirSync(resolved, { recursive: true });
  const sentinel = join(resolved, DURABILITY_SENTINEL);
  if (!existsSync(sentinel)) {
    writeFileSync(sentinel, DURABILITY_SENTINEL_CONTENT, { encoding: "utf8", flag: "wx" });
  }
  assertRoot(resolved);

  const brands = brandsAt(sourceCompanies);
  for (const brand of brands) {
    for (const dir of SKELETON_DIRS) mkdirSync(join(resolved, "companies", brand, dir), { recursive: true });
    mkdirSync(join(resolved, "secrets", brand), { recursive: true });
  }
  for (const dir of ["publish-ledger", "ops", "logs", "secrets"]) {
    mkdirSync(join(resolved, dir), { recursive: true });
  }

  const report = migrateState(resolved, { sourceCompanies, sourceRoot });
  // A new brand has no ledger to migrate: start it empty (never overwriting one that exists).
  for (const brand of brands) {
    const ledger = join(resolved, "companies", brand, "topics-ledger.json");
    if (!existsSync(ledger)) writeFileSync(ledger, "[]\n", { encoding: "utf8", flag: "wx" });
  }
  const verified = verifySeededState(resolved, { sourceCompanies });
  return { root: resolved, report, verified };
}

if (process.argv[1] && basename(process.argv[1]) === "init-state-dir.mjs") {
  const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
  const root = rootArg?.slice("--root=".length) || process.env.STATE_DIR;
  try {
    const { root: initialized, report, verified } = initStateDir(root);
    console.log(
      `STATE_SEEDED=${initialized} brands=${verified.brands} manifests=${verified.manifests} ` +
      `ledgers=${verified.ledgers} copied=${report.copied.length} skipped=${report.skipped.length} ` +
      `conflicts=${report.conflicts.length}`,
    );
    for (const path of report.conflicts) console.log(`PRESERVED_RUNTIME_CONFLICT=${path}`);
  } catch (error) {
    console.error(`STATE_SEED_FAILED=${error?.message || error}`);
    process.exitCode = 1;
  }
}
