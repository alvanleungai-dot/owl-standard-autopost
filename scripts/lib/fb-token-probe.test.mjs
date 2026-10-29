import test from "node:test";
import assert from "node:assert/strict";
import { FB_TOKEN_SLOTS, fbTokenVerdict, probeFbTokens } from "./fb-token-probe.mjs";
import { REVIEW_BOTS } from "./worker-jobs.mjs";

test("Facebook preflight derives token ownership from the worker brand roster", async () => {
  assert.deepEqual(
    Object.entries(FB_TOKEN_SLOTS),
    REVIEW_BOTS.map(({ brand, fbTokenEnv }) => [brand, fbTokenEnv]),
  );
  assert.equal("golftravel" in FB_TOKEN_SLOTS, false);

  const results = await probeFbTokens(
    (slot) => `fake:${slot}`,
    { probe: async () => ({ ok: true, detail: "fake live token" }) },
  );
  assert.equal(results.length, REVIEW_BOTS.length);
  assert.equal(results.some(({ brand }) => brand === "golftravel"), false);
});

test("Facebook preflight still fails when an owned brand token is missing", async () => {
  // FB_TOKEN_SLOTS is derived from REVIEW_BOTS, which the prune to Owl Standard reduced to one
  // entry — hence "1/1" below where it used to read "1/4".
  const missingSlot = FB_TOKEN_SLOTS["owl-standard"];
  await assert.rejects(
    fbTokenVerdict(
      (slot) => slot === missingSlot ? "" : `fake:${slot}`,
      {
        probe: async (_brand, token) =>
          token
            ? { ok: true, detail: "fake live token" }
            : { ok: false, detail: "token missing from env" },
      },
    ),
    /1\/1 FB page token\(s\) NOT valid: owl-standard \(token missing from env\)/,
  );
});
