// scripts/owl-standard/verify-higgsfield.mjs — find the endpoint that serves GPT Image on YOUR account,
// then optionally render one real poster through it.
//
// WHY THIS EXISTS: Higgsfield's per-model endpoint paths are account-dependent and only two are
// published (`flux-pro/kontext/max/text-to-image`, `/v1/text2image/soul`). The pipeline needs GPT Image
// specifically, because the posters render Traditional Chinese INSIDE the image. Rather than guess a
// path and silently render through the wrong model, this probes candidates against the real account.
//
// HOW THE PROBE AVOIDS SPENDING CREDITS: it POSTs an intentionally EMPTY body. A path that exists
// rejects it with a validation error (400/422); a path that does not exist returns 404. Neither
// generates an image. Only `--generate` spends anything.
//
//   node scripts/owl-standard/verify-higgsfield.mjs                 # probe the candidate list
//   node scripts/owl-standard/verify-higgsfield.mjs --generate      # render one real test poster
//   node scripts/owl-standard/verify-higgsfield.mjs --generate --endpoint=<path>
import { writeFileSync } from "node:fs";
import { getEnv } from "../lib/env.mjs";
import { AI_IMAGE_HTTP_TIMEOUT_MS, fetchWithDeadline } from "../lib/http-deadline.mjs";
import { generateHiggsfield } from "../lib/image-backend.mjs";
import { companyStatePath, ensureStateParent } from "../lib/paths.mjs";

const BASE = "https://api.higgsfield.ai";
const ID = getEnv("HIGGSFIELD_API_KEY_ID"), SECRET = getEnv("HIGGSFIELD_API_KEY_SECRET");
if (!ID || !SECRET) {
  console.log("❌ HIGGSFIELD_API_KEY_ID / HIGGSFIELD_API_KEY_SECRET not set in secrets/owl-standard/.env");
  console.log("   Get them from cloud.higgsfield.ai -> API.");
  process.exit(1);
}
const headers = { authorization: `Key ${ID}:${SECRET}`, "content-type": "application/json" };

// Candidates follow the two CONFIRMED naming patterns:
//   bytedance/seedream/v4/text-to-image   flux-pro/kontext/max/text-to-image
// The GPT Image path is not published, so these are guesses to be TESTED, never assumed. The two
// confirmed paths are included as controls: if they also 404, the probe itself is wrong, not the account.
const CANDIDATES = [
  "/openai/gpt-image/v2/text-to-image",
  "/openai/gpt-image-2/text-to-image",
  "/openai/gpt-image/text-to-image",
  "/gpt-image/v2/text-to-image",
  "/gpt-image-2/text-to-image",
  "/openai/gpt-image/v2/standard/text-to-image",
  // controls — these two are documented and should NOT 404
  "/flux-pro/kontext/max/text-to-image",
  "/bytedance/seedream/v4/text-to-image",
];

async function probe(path) {
  try {
    const r = await fetchWithDeadline(`${BASE}${path}`, {
      method: "POST", headers, body: JSON.stringify({}),
    }, { timeoutMs: 20_000, label: `probe ${path}` });
    const body = (await r.text()).slice(0, 120).replace(/\s+/g, " ");
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: e.message.slice(0, 120) };
  }
}

const verdict = (status) => {
  if (status === 404) return "❌ does not exist";
  if (status === 401 || status === 403) return "🔒 exists, but your key lacks access";
  if (status === 400 || status === 422) return "✅ EXISTS (rejected the empty body, as expected)";
  if (status === 200 || status === 202) return "⚠️  accepted an EMPTY body — unexpected, inspect manually";
  if (status === 0) return "⚠️  network/timeout";
  return `⚠️  HTTP ${status}`;
};

const endpointArg = process.argv.find((a) => a.startsWith("--endpoint="))?.split("=")[1];

if (!process.argv.includes("--generate")) {
  console.log("Probing candidate endpoints (no credits spent — empty bodies only)\n");
  const found = [];
  for (const path of CANDIDATES) {
    const { status, body } = await probe(path);
    const v = verdict(status);
    console.log(`  ${v.padEnd(48)} ${path}`);
    if (status === 400 || status === 422) found.push(path);
    if (status !== 404 && status !== 400 && status !== 422) console.log(`      ${body}`);
  }
  const gpt = found.filter((p) => p.includes("gpt-image"));
  console.log("\n" + "─".repeat(78));
  if (gpt.length) {
    console.log("✅ GPT Image endpoint(s) that exist on your account:");
    gpt.forEach((p) => console.log(`     ${p}`));
    console.log(`\n   Put it in secrets/owl-standard/.env:\n     HIGGSFIELD_ENDPOINT=${gpt[0]}`);
    console.log(`\n   Then render one real test poster:\n     node scripts/owl-standard/verify-higgsfield.mjs --generate`);
  } else {
    console.log("❌ None of the guessed GPT Image paths exist on this account.");
    console.log("   The naming pattern is {vendor}/{model}/{version}/text-to-image, but the GPT Image");
    console.log("   path is not published — ask support@higgsfield.ai for it, or read it off the API");
    console.log("   section of cloud.higgsfield.ai, then pass it directly:");
    console.log("     node scripts/owl-standard/verify-higgsfield.mjs --generate --endpoint=<path>");
    if (found.length) console.log(`\n   (These non-GPT paths DO work, if you want to compare: ${found.join(", ")})`);
    else console.log("\n   ⚠️  Even the documented control paths failed — check the credentials first.");
  }
  process.exit(0);
}

// ── --generate: one real poster, one real charge ──────────────────────────────────────────────────
if (endpointArg) process.env.HIGGSFIELD_ENDPOINT = endpointArg;
const endpoint = getEnv("HIGGSFIELD_ENDPOINT") || "(default: flux-pro)";
console.log(`Rendering ONE test poster via ${endpoint} — this spends credits.\n`);

// The same Traditional Chinese load the real posters carry: a headline, four card labels, a pull-quote.
const PROMPT =
  "Create a good-looking vertical poster. Direction: INFOGRAPHIC. Hero visual at the top: a clean, orderly " +
  "interior of a compliant Hong Kong subdivided residential unit — measured floor space, tidy partition wall, " +
  "a closed fire door, neat independent water and electricity meters, soft daylight, no people. " +
  "Headline 「認證前，先評估」, then a horizontal row of FOUR dark cards, each an ORANGE icon and one short " +
  "Traditional Chinese label: 面積要夠 / 樓底2.3米 / 獨立廁所 / 水電獨立錶. Below them a short orange " +
  "pull-quote: 唔係每個單位都值得改. " +
  "Brand colours: warm off-white paper (#FDF8F0), deep charcoal-green ink (#14201c), vivid ORANGE accent " +
  "(#EA6321) used sparingly. Reserve the top-left corner as a plain light area and the bottom 18% as empty " +
  "space. ALL TRADITIONAL CHINESE TEXT MUST BE PERFECT AND LEGIBLE — this is the whole point of the test.";

try {
  const { buffer, model } = await generateHiggsfield({
    prompt: PROMPT, width: 1024, height: 1536, label: "higgsfield-verify",
  });
  const out = ensureStateParent(companyStatePath("owl-standard", "posters", "_higgsfield-verify.png"));
  writeFileSync(out, buffer);
  console.log(`\n✅ Rendered via ${model}`);
  console.log(`   ${out}`);
  console.log("\n   NOW LOOK AT IT. The only question that matters:");
  console.log("   are 認證前，先評估 / 面積要夠 / 樓底2.3米 / 獨立廁所 / 水電獨立錶 /");
  console.log("   唔係每個單位都值得改 all rendered correctly, with no missing strokes or garbled glyphs?");
  console.log("\n   If yes  -> keep IMAGE_BACKEND=higgsfield, you are done.");
  console.log("   If no   -> set IMAGE_BACKEND=openai and use the OpenAI fallback instead.");
} catch (e) {
  console.log(`\n❌ ${e.message}`);
  process.exitCode = 1;
}
