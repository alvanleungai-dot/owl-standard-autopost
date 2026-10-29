// List image-capable models available to this OPENAI_API_KEY.
import { getEnv } from "./lib/env.mjs";
const key = getEnv("OPENAI_API_KEY");
const r = await fetch("https://api.openai.com/v1/models", {
  headers: { Authorization: `Bearer ${key}` },
});
const j = await r.json();
const ids = (j.data || []).map((m) => m.id).filter((id) => /image|dall/i.test(id)).sort();
console.log("HTTP", r.status);
console.log("Image-capable models:", JSON.stringify(ids, null, 2));
