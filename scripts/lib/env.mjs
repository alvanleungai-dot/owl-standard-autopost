import { readFileSync } from "node:fs";
import { configPath } from "./paths.mjs";

// WHERE SECRETS LIVE (fixed 2026-08-31).
// CLAUDE.md's hard rule and .env.example both tell the operator to put credentials in
// `secrets/<company>/.env`. This module only ever read the repo-root `.env`, so following the
// documented instructions produced "No API key configured" with the key sitting right there on disk.
// Both locations are now read, most-specific first:
//   1. process.env                      — Render sets everything here; always wins
//   2. secrets/owl-standard/.env        — the documented per-tenant location
//   3. .env                             — repo root, kept for local convenience and older setups
// A key found earlier in this list wins. Missing files are skipped silently (that is the normal case:
// on Render neither file exists).
export const ENV_FILE_CANDIDATES = () => [
  configPath("secrets", "owl-standard", ".env"),
  configPath(".env"),
];

export function parseEnvText(text) {
  const values = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return values;
}

export function readEnvText({
  envFile = configPath(".env"),
  read = readFileSync,
} = {}) {
  try { return read(envFile, "utf8"); }
  catch { return ""; }
}

// Read ONE env file. `envFile` still defaults to the repo-root `.env` so existing callers that name a
// specific file (scripts/check-keys.mjs, tests) keep their exact behaviour.
export function readEnvFile({
  envFile = configPath(".env"),
  read = readFileSync,
} = {}) {
  return parseEnvText(readEnvText({ envFile, read }));
}

// Merge every candidate file into one map, earlier candidates winning.
export function readAllEnvFiles({ files = ENV_FILE_CANDIDATES(), read = readFileSync } = {}) {
  const merged = new Map();
  for (const envFile of files) {
    for (const [key, value] of readEnvFile({ envFile, read })) {
      if (!merged.has(key) && value !== "") merged.set(key, value);
    }
  }
  return merged;
}

export function readEnvValue(key, {
  env = process.env,
  envFile,            // when given, read ONLY that file (preserves the old single-file contract)
  files,
  read = readFileSync,
} = {}) {
  if (env[key] !== undefined && String(env[key]).trim() !== "") return String(env[key]).trim();
  if (envFile) return readEnvFile({ envFile, read }).get(key) || "";
  return readAllEnvFiles({ files: files || ENV_FILE_CANDIDATES(), read }).get(key) || "";
}

export const getEnv = (key, options) => readEnvValue(key, options);

// Safety-sensitive enable flags are opt-in. Only the literal value "true"
// enables them; absent, blank, "1", "yes", and malformed values all disable.
export function readEnabledFlag(key, options) {
  return readEnvValue(key, options).trim().toLowerCase() === "true";
}
