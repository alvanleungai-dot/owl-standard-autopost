// Reproduce a Render checkout: scripts copied into a clean tree with no .env
// and no secrets/, then import every movable job without executing its main.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DURABILITY_SENTINEL,
  DURABILITY_SENTINEL_CONTENT,
} from "./lib/paths.mjs";
import { REVIEW_BOTS, SCHEDULED_JOBS } from "./lib/worker-jobs.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const checkout = mkdtempSync(join(repoRoot, ".cloud-import-checkout-"));
const state = mkdtempSync(join(repoRoot, ".sce-cloud-import-state-"));
const negative = process.argv.includes("--negative-direct-env");
const includeReviewBots = process.argv.includes("--include-review-bots");

function cleanup() {
  rmSync(checkout, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}

try {
  cpSync(join(repoRoot, "scripts"), join(checkout, "scripts"), { recursive: true });
  if (includeReviewBots) {
    // Review-bot dependency graphs read immutable brand voice/config at import.
    // Runtime state still comes only from the clean STATE_DIR below.
    cpSync(join(repoRoot, "companies"), join(checkout, "companies"), { recursive: true });
  }
  if (existsSync(join(checkout, ".env")) || existsSync(join(checkout, "secrets"))) {
    throw new Error("selftest setup error: clean checkout unexpectedly contains .env or secrets/");
  }
  writeFileSync(join(state, DURABILITY_SENTINEL), DURABILITY_SENTINEL_CONTENT, "utf8");
  mkdirSync(join(state, "secrets"), { recursive: true });

  let modules = SCHEDULED_JOBS.map((job) => ({ name: job.name, path: job.entry }));
  if (includeReviewBots) {
    modules.push(...REVIEW_BOTS.map((bot) => ({ name: bot.name, path: bot.entry })));
  }
  if (negative) {
    const path = "scripts/__negative-direct-env-reader.mjs";
    writeFileSync(
      join(checkout, path),
      [
        'import { readFileSync } from "node:fs";',
        'readFileSync(new URL("../.env", import.meta.url), "utf8");',
        "",
      ].join("\n"),
      "utf8",
    );
    modules = [{ name: "negative-direct-env-reader", path }];
  }

  const failures = [];
  for (const module of modules) {
    const url = pathToFileURL(resolve(checkout, module.path)).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], {
      cwd: checkout,
      encoding: "utf8",
      env: {
        // Cloud-shaped environment only. Values are inert placeholders; import-only
        // mode exits before any job main can call a provider or publisher.
        CLOUD: "1",
        STATE_DIR: state,
        SCE_INSTANCE_ID: "cloud-import-selftest",
        SCE_IMPORT_ONLY: "1",
        ANTHROPIC_API_KEY: "cloud-placeholder",
        OPENAI_API_KEY: "cloud-placeholder",
        TELEGRAM_OWNER_CHAT_ID: "0",
        TELEGRAM_CHAT_ID: "0",
        TELEGRAM_BOT_TOKEN_OWLSTANDARD: "cloud-placeholder-owl-standard",
        FB_PAGE_TOKEN_OWLSTANDARD: "cloud-placeholder",
        CLOUDINARY_CLOUD_NAME: "cloud-placeholder",
        CLOUDINARY_API_KEY: "cloud-placeholder",
        CLOUDINARY_API_SECRET: "cloud-placeholder",
        PATH: process.env.PATH || "",
        SystemRoot: process.env.SystemRoot || "",
      },
    });
    if (result.status === 0) {
      console.log(`CLOUD_IMPORT_OK=${module.name} module=${module.path}`);
    } else {
      const detail = `${result.stderr || result.stdout || `exit ${result.status}`}`.trim().replace(/\s+/g, " ");
      console.error(`CLOUD_IMPORT_FAIL=${module.name} module=${module.path} error=${detail.slice(0, 500)}`);
      failures.push(module.name);
    }
  }
  console.log(`CLOUD_IMPORT_SUMMARY checked=${modules.length} failed=${failures.length} clean_env=true clean_secrets=true`);
  if (failures.length) process.exitCode = 1;
} finally {
  cleanup();
}
