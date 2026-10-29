import test from "node:test";
import assert from "node:assert/strict";
import { cancelFacebookBooking } from "./fb-cancel.mjs";

const NOW = Date.parse("2026-10-01T02:00:00Z"); // 10:00 HK on 2026-10-01
const booked = () => ({ slug: "2026-W41-01", date: "2026-10-06", fbPostId: "111_222" });
const fakeFetch = (status, body, calls = []) => async (url, init) => {
  calls.push({ url, method: init?.method });
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

test("a future booking is deleted on Meta, its ledger slot released and its id cleared", async () => {
  const post = booked();
  const calls = [];
  const released = [];
  const result = await cancelFacebookBooking({
    post, token: "t", nowMs: NOW, fetchImpl: fakeFetch(200, { success: true }, calls),
    release: (slot) => released.push(slot),
  });
  assert.deepEqual(result, { ok: true, reason: "cancelled" });
  assert.equal(calls[0].method, "DELETE");
  assert.match(calls[0].url, /\/111_222\?access_token=t$/);
  assert.deepEqual(released, [{ brand: "owl-standard", slug: "2026-W41-01", channel: "fb", planned_date: "2026-10-06" }]);
  assert.equal(post.fbPostId, undefined);
});

test("a Meta refusal keeps the booking recorded and the ledger untouched", async () => {
  const post = booked();
  const released = [];
  const result = await cancelFacebookBooking({
    post, token: "t", nowMs: NOW, fetchImpl: fakeFetch(400, { error: { message: "(#100) Invalid" } }),
    release: (slot) => released.push(slot),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Invalid/);
  assert.equal(post.fbPostId, "111_222", "still booked, so it must stay recorded");
  assert.deepEqual(released, []);
});

test("a post already live is never deleted from here", async () => {
  const post = { ...booked(), date: "2026-10-01" }; // its 10:00 HK slot is now
  const calls = [];
  const result = await cancelFacebookBooking({ post, token: "t", nowMs: NOW, fetchImpl: fakeFetch(200, {}, calls) });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], "no DELETE may be sent for public content");
});

test("an unbooked post needs nothing cancelled", async () => {
  assert.deepEqual(await cancelFacebookBooking({ post: { slug: "x", date: "2026-10-06" } }), { ok: true, reason: "not booked" });
});
