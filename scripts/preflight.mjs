// scripts/preflight.mjs — API supply-chain guardian. Cheap probes to detect "credits exhausted /
// key erroring" so billing/key problems surface BEFORE generation day instead of as a failed run.
// Anthropic gets a 1-token call (fractions of a cent a month); the image provider in use and the FB
// page token are checked without spending anything. Perplexity is deliberately NOT probed: nothing in
// this engine calls it, so probing it only produced a daily false alarm. Escalates to the ops
// Telegram channel (TELEGRAM_BOT_TOKEN__OPS → owner) only when something is wrong.
//   node scripts/preflight.mjs            # probe; ping ops only if a provider is down
//   node scripts/preflight.mjs --report   # also ping ops when everything is healthy
import { askText } from "./lib/anthropic.mjs";
import { escalate, resolve, inform } from "./lib/alert.mjs";
import { fbTokenVerdict } from "./lib/fb-token-probe.mjs";
import { getEnv } from "./lib/env.mjs";
import { AI_TEXT_HTTP_TIMEOUT_MS, fetchWithDeadline } from "./lib/http-deadline.mjs";
import { reapPublishLedger } from "./lib/publish-ledger-alert.mjs";
import { backendName } from "./lib/image-backend.mjs";

const OPENAI = getEnv("OPENAI_API_KEY");
const REPORT = process.argv.includes("--report");

const lowRe = /credit|billing|insufficient_quota|hard.?limit|quota|exceeded your current|too low/i;
const verdict = (e) => (lowRe.test(String(e)) ? "💳 額度滿 (credits low)" : `⚠️ ${String(e).slice(0, 120)}`);
const probe = async (fn) => { try { await fn(); return "ok"; } catch (e) { return verdict(e?.message || e); } };

const PROBES = {
  Anthropic: () => askText("hi", { maxTokens: 1 }),
  // Report on the image provider actually in use (IMAGE_BACKEND). Probing OpenAI when the pipeline
  // renders through Higgsfield would alarm the owner about a provider nothing calls.
  ...(backendName() === "openai" ? {
    OpenAI: async () => {
      const r = await fetchWithDeadline("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${OPENAI}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      }, { timeoutMs: AI_TEXT_HTTP_TIMEOUT_MS, label: "OpenAI preflight probe" });
      if (r.status !== 200) throw new Error(await r.text());
    },
  } : {
    // Higgsfield exposes no cheap health endpoint, and a real generation costs credits — so preflight
    // checks configuration only. A live failure surfaces per-poster with a named cause instead.
    Higgsfield: async () => {
      if (!getEnv("HIGGSFIELD_API_KEY_ID") || !getEnv("HIGGSFIELD_API_KEY_SECRET")) {
        throw new Error("HIGGSFIELD_API_KEY_ID / HIGGSFIELD_API_KEY_SECRET not set");
      }
    },
  }),

  // 2026-07-26 (incident retro): the ONLY thing asserting these tokens were valid was a
  // dated "✅ VERIFIED (measured)" heading in docs/ai/PROJECT_STATE.md — prose, written
  // once, never re-measured, and standing behind unattended publishing to FIVE LIVE CLIENT
  // PAGES. Page tokens expire and FB_SYSTEM_USER_TOKEN (the non-expiring path) is empty in
  // the vault, so an expiry would have surfaced as a failed post on a client's page instead
  // of an alert beforehand. Read-only GET /me per token; no writes, no scheduling.
  "FB page tokens": () => fbTokenVerdict(getEnv),
};

async function runAll() { const r = {}; for (const [k, fn] of Object.entries(PROBES)) r[k] = await probe(fn); return r; }

if (process.env.SCE_IMPORT_ONLY === "1") process.exit(0);
await reapPublishLedger();
const results = await runAll();
console.log("Preflight:", JSON.stringify(results));

for (const [name, v] of Object.entries(results)) {
  if (v === "ok") { resolve("preflight", name); continue; }
  // Screen each provider independently: re-probe before alarming (a one-off blip self-resolves),
  // then dedupe so a persistent low-credit reminds at most ~once/12h until the owner fixes it.
  await escalate({
    source: "preflight", kind: name, severity: "crucial",
    text: `🔴 內容引擎 API：${name} ${v}（出帖前要搞掂）。\n額度：Anthropic → console.anthropic.com · OpenAI → platform.openai.com（Plans & Billing / Limits）。`,
    verify: async () => (await probe(PROBES[name])) !== "ok",
  });
}

const bad = Object.entries(results).filter(([, v]) => v !== "ok");
if (bad.length) process.exitCode = 2;
else if (REPORT) await inform(`✅ 每日 API 檢查全部正常（${Object.keys(PROBES).join(" · ")}）。`);
