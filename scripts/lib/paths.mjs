// lib/paths.mjs — the only place that decides whether a path is immutable repo config or mutable state.
// Render wipes the checkout on deploy. Falling back to it in cloud mode would erase the dedup history and
// recreate the double-publish window found during the 2026-W28 reconciliation.
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSingleInstance } from "./single-instance.mjs";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DURABILITY_SENTINEL = ".sce-durable-state-v1";
export const DURABILITY_SENTINEL_CONTENT = "social-content-engine durable state v1\n";

export class StateDirError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "StateDirError";
    this.kind = "state_dir";
  }
}

const cloudMode = () => process.env.RENDER === "true" || process.env.CLOUD === "1";
let checkedRoot = null;

function verifyWritable(root) {
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK);
    const probe = join(root, `.state-dir-probe-${process.pid}-${Date.now()}`);
    const fd = openSync(probe, "wx");
    try {
      writeFileSync(fd, "ok");
    } finally {
      closeSync(fd);
      unlinkSync(probe);
    }
  } catch (cause) {
    throw new StateDirError(`STATE_DIR is not writable: ${root}`, { cause });
  }
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertDurableStateRoot(root, {
  exists = existsSync,
  read = readFileSync,
} = {}) {
  const resolved = resolve(root);
  const ephemeralRoots = [resolve(tmpdir()), resolve("/tmp"), resolve("/var/tmp")];
  if (inside(REPO_ROOT, resolved)) {
    throw new StateDirError(`STATE_DIR must not be inside the deploy checkout: ${resolved}`);
  }
  if (ephemeralRoots.some((candidate) => inside(candidate, resolved))) {
    throw new StateDirError(`STATE_DIR must not use an ephemeral temp path: ${resolved}`);
  }
  const sentinel = join(resolved, DURABILITY_SENTINEL);
  if (!exists(sentinel)) {
    throw new StateDirError(
      `Durability sentinel is missing at ${sentinel}; refusing to publish from an empty/wiped disk. ` +
      "Run scripts/init-state-dir.mjs deliberately once on the mounted disk.",
    );
  }
  let content;
  try { content = read(sentinel, "utf8"); }
  catch (cause) { throw new StateDirError(`Durability sentinel is unreadable: ${sentinel}`, { cause }); }
  if (content !== DURABILITY_SENTINEL_CONTENT) {
    throw new StateDirError(`Durability sentinel is invalid: ${sentinel}`);
  }
  return resolved;
}

export function stateRoot() {
  const configured = process.env.STATE_DIR?.trim();
  if (cloudMode() && !configured) {
    throw new StateDirError("STATE_DIR is required when RENDER=true or CLOUD=1; refusing to use the deploy checkout.");
  }
  const root = configured ? resolve(configured) : REPO_ROOT;
  if ((configured || cloudMode()) && checkedRoot !== root) {
    verifyWritable(root);
    if (cloudMode()) {
      assertDurableStateRoot(root);
      assertSingleInstance({ root });
    }
    checkedRoot = root;
  }
  return root;
}

export function assertStateDir() {
  return stateRoot();
}

function beneath(root, parts, label) {
  const candidate = resolve(root, ...parts);
  if (!inside(root, candidate)) {
    throw new StateDirError(`${label} path escapes its root: ${candidate}`);
  }
  return candidate;
}

export const configPath = (...parts) => beneath(REPO_ROOT, parts, "Config");
export const companyConfigPath = (brand, ...parts) => {
  const root = configPath("companies", brand);
  return beneath(root, parts, "Company config");
};
export const runtimePath = (...parts) => {
  const root = stateRoot();
  return beneath(root, parts, "Runtime");
};
export const companyStatePath = (brand, ...parts) => {
  const root = runtimePath("companies", brand);
  return beneath(root, parts, "Company runtime");
};
export function companyArtifactPath(brand, reference) {
  const normalized = String(reference || "").replace(/\\/g, "/");
  const prefix = `companies/${brand}/`;
  return companyStatePath(brand, ...(normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized).split("/"));
}
export function ensureStateParent(path) {
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

// Tests change environment variables in one process; production never needs to call this.
export function resetStateRootForTests() {
  checkedRoot = null;
}
