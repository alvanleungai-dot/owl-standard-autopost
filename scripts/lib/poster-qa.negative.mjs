// scripts/lib/poster-qa.negative.mjs — PROVE THE CHECKER STILL CATCHES REAL DEFECTS.
//
// The unit tests in poster-qa.test.mjs prove the decision logic. They cannot prove the thing that
// actually matters: that the vision model SEES a defect in a real poster. On 2026-07-31 the first
// version of this gate passed all four sample posters including two with defects confirmed by eye —
// a gate that always passes, which is worse than no gate because it manufactures confidence.
//
// This is the negative test that caught it, kept runnable so a model or prompt change cannot quietly
// disable the check. It costs a few vision calls and needs ANTHROPIC_API_KEY, so it is NOT part of the
// unit suite — run it deliberately:
//
//   node scripts/lib/poster-qa.negative.mjs <dir-with-the-four-sample-posters>
//
// Expected: the two defective posters FAIL and the two clean posters PASS. Any other result means the
// gate is no longer measuring the surface it claims to measure — fix that before shipping.
import { argv, exit } from "node:process";
import { join } from "node:path";
import { inspectPoster, verdictSummary, QA_MODEL } from "./poster-qa.mjs";
import { askImageJSON } from "./anthropic.mjs";

// The four posters this gate was calibrated against, with what a correct checker must say.
export const SAMPLES = Object.freeze([
  { file: "tml-2026-09-07.jpg", expect: "fail", why: "body text clipped by the white footer bar" },
  { file: "tml-2026-09-21.jpg", expect: "fail", why: "grey placeholder rectangle below the After panel" },
  { file: "tml-0810.jpg", expect: "pass", why: "clean before/after case photo with branding" },
  { file: "tml-2026-08-24.jpg", expect: "pass", why: "clean mascot poster" },
]);

const dir = argv[2];
if (!dir) { console.error("usage: node poster-qa.negative.mjs <dir-with-sample-posters>"); exit(2); }

const ask = (req) => askImageJSON({ ...req, model: QA_MODEL, maxTokens: 1500 });
let wrong = 0;
console.log(`poster-qa negative test — model ${QA_MODEL}`);
for (const s of SAMPLES) {
  const v = await inspectPoster(join(dir, s.file), { ask, mediaType: "image/jpeg" });
  const got = v.pass ? "pass" : "fail";
  const ok = got === s.expect;
  if (!ok) wrong += 1;
  console.log(`  ${ok ? "OK  " : "WRONG"} ${s.file.padEnd(24)} expected ${s.expect}, got ${got} — ${verdictSummary(v).slice(0, 110)}`);
}
if (wrong) {
  console.error(`\n${wrong} sample(s) judged wrongly — the gate is NOT measuring what it claims. Do not ship.`);
  exit(1);
}
console.log("\nAll four judged correctly: the gate still sees real defects and does not cry wolf.");
