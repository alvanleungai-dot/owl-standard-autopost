// scripts/diag-openai-image.mjs — definitively test whether the OpenAI IMAGE API (gpt-image) works with the
// current key + billing. Minimal low-cost request. Prints SUCCESS or the EXACT error (e.g. billing limit),
// so we can separate an API/billing problem from a code/design problem. Never prints the key.
import { getEnv } from "./lib/env.mjs";
const key = getEnv("OPENAI_API_KEY");
console.log(`OPENAI_API_KEY: ${key ? "present (" + key.length + " chars)" : "❌ MISSING"}`);
if (!key) process.exit(1);

for (const model of ["gpt-image-2", "gpt-image-1"]) {
  try {
    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "a simple gold circle on a white background", size: "1024x1024", quality: "low", n: 1 }),
    });
    const j = await r.json();
    if (j.error) { console.log(`${model}: ❌ HTTP ${r.status} — [${j.error.type || j.error.code}] ${j.error.message}`); }
    else { console.log(`${model}: ✅ image generated — THE IMAGE API WORKS (this is NOT an API problem).`); break; }
  } catch (e) { console.log(`${model}: ❌ network ${String(e.message).slice(0, 120)}`); }
}
