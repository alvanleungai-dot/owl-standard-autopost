// lib/artifacts.mjs — dated generators must identify their output and never silently replace it.
// The wrong-week incident came from callers guessing with directory sort; WROTE is the hand-off contract.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { companyStatePath, ensureStateParent } from "./paths.mjs";
import { IDEMPOTENT_NOOP_EXIT_CODE } from "./process-outcome.mjs";

const BOUNDARY_INSTALLED = Symbol.for("sce.artifactNoopBoundaryInstalled");

function installArtifactNoopBoundary() {
  if (process[BOUNDARY_INSTALLED]) return;
  process[BOUNDARY_INSTALLED] = true;
  process.on("uncaughtException", (error) => {
    if (error instanceof ArtifactExistsError) {
      process.stderr.write(`IDEMPOTENT_NOOP reason=artifact_exists detail=${error.message}\n`);
      process.exitCode = IDEMPOTENT_NOOP_EXIT_CODE;
      return;
    }
    throw error;
  });
}

export class ArtifactExistsError extends Error {
  constructor(paths) {
    super(`Refusing to overwrite existing artifact${paths.length === 1 ? "" : "s"}: ${paths.join(", ")} (use --force)`);
    this.name = "ArtifactExistsError";
    this.code = "ARTIFACT_EXISTS";
    this.kind = "artifact_exists";
    this.paths = paths;
  }
}

installArtifactNoopBoundary();

export function assertArtifactsWritable(paths, { force = false } = {}) {
  const absolute = paths.map((path) => resolve(path));
  if (force) return absolute;
  const existing = absolute.filter((path) => existsSync(path));
  if (existing.length) throw new ArtifactExistsError(existing);
  return absolute;
}

export function wroteLine(path) {
  return `WROTE=${resolve(path)}`;
}

export function wrote(path) {
  const absolute = resolve(path);
  console.log(`WROTE=${absolute}`);
  return absolute;
}

export function parseWrote(stdout, label = "generator") {
  const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.startsWith("WROTE="));
  if (lines.length !== 1 || !lines[0].slice(6).trim()) {
    const error = new Error(`${label} must print exactly one WROTE=<absolute path> line; got ${lines.length}`);
    error.name = "GeneratorOutputError";
    error.code = "GENERATOR_OUTPUT_INVALID";
    error.kind = "generator_output";
    throw error;
  }
  const path = lines[0].slice(6).trim();
  if (!resolve(path) || resolve(path) !== path) {
    const error = new Error(`${label} returned a non-absolute WROTE path: ${path}`);
    error.name = "GeneratorOutputError";
    error.code = "GENERATOR_OUTPUT_NOT_ABSOLUTE";
    error.kind = "generator_output";
    throw error;
  }
  return path;
}

export function setActiveWeek(brand, manifestPath) {
  const path = companyStatePath(brand, "active-week.json");
  const temp = `${path}.${process.pid}.tmp`;
  ensureStateParent(path);
  writeFileSync(temp, `${JSON.stringify({ manifest: resolve(manifestPath), weekFile: basename(manifestPath) }, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return path;
}

export function activeWeekPath(brand) {
  const pointer = companyStatePath(brand, "active-week.json");
  if (!existsSync(pointer)) {
    throw new Error(`ActiveWeekMissingError: ${brand} has no active-week.json; generate/review a week or pass an explicit week.`);
  }
  const data = JSON.parse(readFileSync(pointer, "utf8"));
  const path = data.manifest ? resolve(data.manifest) : companyStatePath(brand, "weeks", data.weekFile);
  if (!existsSync(path)) throw new Error(`ActiveWeekMissingError: ${brand} active manifest does not exist: ${path}`);
  return path;
}

export const wrotePathFrom = (stdout) => parseWrote(stdout);
