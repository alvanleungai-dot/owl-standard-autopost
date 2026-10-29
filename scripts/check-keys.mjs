// Verify .env API keys actually connect. Prints status only — never the key.
import { getEnv, readEnvFile } from "./lib/env.mjs";

// Report BOTH locations getEnv actually reads. Showing only the repo-root .env made a key that was
// correctly placed in secrets/owl-standard/.env (the location .env.example instructs) read as "empty".
const secretsEnv = Object.fromEntries(readEnvFile({ envFile: new URL("../secrets/owl-standard/.env", import.meta.url) }));
const rootEnv = Object.fromEntries(readEnvFile({ envFile: new URL("../.env", import.meta.url) }));
const tmpl = Object.fromEntries(readEnvFile({ envFile: new URL("../.env.example", import.meta.url) }));
// The full set Owl Standard actually needs — see .env.example for what each one is for.
const KEYS = [
  "ANTHROPIC_API_KEY",
  "HIGGSFIELD_API_KEY_ID", "HIGGSFIELD_API_KEY_SECRET", "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN_OWLSTANDARD", "TELEGRAM_BOT_TOKEN__OPS", "TELEGRAM_CHAT_ID", "TELEGRAM_OWNER_CHAT_ID",
  "FB_PAGE_TOKEN_OWLSTANDARD", "FB_PAGE_ID_OWLSTANDARD", "IG_USER_ID_OWLSTANDARD",
  "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET",
];
// PERPLEXITY_API_KEY is deliberately absent — nothing calls it (see .env.example).
const filled = (env, k) => !!(env[k] && env[k].length > 0);
const resolved = Object.fromEntries(KEYS.map((key) => [key, getEnv(key)]));

console.log("Where keys are (values never shown). getEnv reads, in order:");
console.log("  1. process.env   2. secrets/owl-standard/.env   3. .env\n");
console.log("  " + "KEY".padEnd(32) + "secrets/".padEnd(11) + ".env".padEnd(9) + "RESOLVED");
let leaked = false;
for (const k of KEYS) {
  const inSecrets = filled(secretsEnv, k) ? "set" : "-";
  const inRoot = filled(rootEnv, k) ? "set" : "-";
  const ok = !!resolved[k];
  if (filled(tmpl, k)) leaked = true;
  console.log("  " + k.padEnd(32) + inSecrets.padEnd(11) + inRoot.padEnd(9) + (ok ? "✅" : "—"));
}
if (leaked) console.log("\n  ⚠️  A real value is sitting in .env.example — that file is COMMITTED. Move it out.");

async function check(name, fn) {
  try {
    const status = await fn();
    const ok = status >= 200 && status < 300;
    console.log(`  ${name}: ${ok ? "✅ CONNECTED" : `❌ FAILED (HTTP ${status})`}`);
  } catch (e) {
    console.log(`  ${name}: ❌ ERROR (${e.message})`);
  }
}

console.log("\nLive connection test:");
const jobs = [];
if (filled(resolved, "ANTHROPIC_API_KEY"))
  jobs.push(check("Anthropic", async () => {
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": resolved.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    return r.status;
  }));
if (filled(resolved, "OPENAI_API_KEY"))
  jobs.push(check("OpenAI", async () => {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${resolved.OPENAI_API_KEY}` },
    });
    return r.status;
  }));

if (jobs.length === 0) console.log("  (no keys set in .env — nothing to test)");
await Promise.all(jobs);
