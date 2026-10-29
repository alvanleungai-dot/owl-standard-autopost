import test from "node:test";
import assert from "node:assert/strict";
import {
  facebookDedupFacts,
  fetchFacebookInventory,
  RemoteDedupUnavailableError,
} from "./meta-dedup.mjs";

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

test("remote dedup fails closed on a Meta error envelope", async () => {
  await assert.rejects(
    fetchFacebookInventory({
      pageId: "page",
      token: "token",
      fetchImpl: async () => response({ error: { message: "expired token" } }),
    }),
    RemoteDedupUnavailableError,
  );
});

test("remote dedup fails closed when a data array is absent", async () => {
  await assert.rejects(
    fetchFacebookInventory({
      pageId: "page",
      token: "token",
      fetchImpl: async () => response({}),
    }),
    /no data array/,
  );
});

test("remote dedup fails closed when the Meta transport hangs", async () => {
  await assert.rejects(
    fetchFacebookInventory({
      pageId: "page",
      token: "token",
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}),
    }),
    (error) =>
      error instanceof RemoteDedupUnavailableError &&
      error.cause?.kind === "deadline" &&
      /published_posts/.test(error.message),
  );
});

test("remote inventory yields caption and HK-date collision facts", async () => {
  const replies = [
    response({ data: [{ message: "Alpha!", created_time: "2026-08-03T02:00:00+0000" }] }),
    response({ data: [{ message: "Beta!", scheduled_publish_time: Date.parse("2026-08-10T02:00:00Z") / 1000 }] }),
  ];
  const inventory = await fetchFacebookInventory({
    pageId: "page",
    token: "token",
    fetchImpl: async () => replies.shift(),
  });
  const facts = facebookDedupFacts({
    ...inventory,
    normalize: (value) => String(value || "").replace(/\W/g, ""),
  });
  assert.equal(facts.existingNorm, "Alpha|Beta");
  assert.deepEqual([...facts.occupiedDates].sort(), ["2026-08-03", "2026-08-10"]);
});
