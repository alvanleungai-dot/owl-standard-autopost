// Locate which .env file your keys actually landed in.
// Reports only WHICH keys are filled per file — never the values.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "./lib/env.mjs";

const ROOT = "C:/Users/jimmi/Downloads/Jimmi-agent";
const KEYS = ["PERPLEXITY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN"];
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".vercel"]);
const found = [];

function walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
    } else if (e.name === ".env" || e.name.startsWith(".env.")) {
      const p = join(dir, e.name);
      const env = Object.fromEntries(readEnvFile({ envFile: p }));
      const hits = KEYS.filter((k) => env[k] && env[k].length > 0);
      found.push({ p: p.replace(ROOT, "."), hits });
    }
  }
}

walk(ROOT);
console.log("All .env files in the workspace (filled keys only — values never shown):\n");
if (found.length === 0) console.log("  (no .env files found)");
for (const f of found) {
  console.log("  " + f.p.padEnd(60) + " -> " + (f.hits.length ? f.hits.join(", ") : "(none filled)"));
}
