import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCaption, captionFingerprint, captionIsIdentifying,
  attemptWindow, judgePublication, listInstagramMediaBack,
  deriveInstagramAccount, lookupInstagramPublication,
} from "./meta-publication.mjs";
import { RemoteDedupUnavailableError } from "./meta-dedup.mjs";

const CAPTION = "離婚後份物業點算？三個你要知嘅重點 #離婚 #物業";
const ANCHOR = "2026-08-01T02:05:00.000Z";
const anchorMs = Date.parse(ANCHOR);
const record = (over = {}) => ({
  brand: "better-life", slug: "2026-W32-01", channel: "ig",
  status: "uncertain", planned_date: "2026-08-03", claimed_at: ANCHOR, ...over,
});
const at = (offsetMs) => new Date(anchorMs + offsetMs).toISOString();

const json = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: async () => body,
});
// A fetchImpl that serves a queue of responses and records the urls it was asked for.
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch: ${url}`);
    if (typeof next === "function") return next(url);
    return next;
  };
  impl.calls = calls;
  return impl;
}

// ── normalisation ────────────────────────────────────────────────────────────────────────────────

test("captions compare on words, not on whitespace/case/zero-width noise", () => {
  assert.equal(normalizeCaption("Hello   World"), "helloworld");
  assert.equal(normalizeCaption("a​b‍c﻿d"), "abcd");
  assert.equal(captionFingerprint("  離婚 後 份物業  ", 6), "離婚後份物業");
  assert.equal(captionIsIdentifying("短"), false);
  assert.equal(captionIsIdentifying(CAPTION), true);
});

// ── the attempt window ───────────────────────────────────────────────────────────────────────────

test("the window anchors on the CLAIM, not the planned date — that is when the publish was attempted", () => {
  const w = attemptWindow(record());
  assert.equal(w.anchor, "claim");
  assert.equal(w.startMs, anchorMs - 60 * 60 * 1000);
  assert.equal(w.endMs, anchorMs + 24 * 60 * 60 * 1000);

  // uncertain_at wins over claimed_at when both are present
  assert.equal(attemptWindow(record({ uncertain_at: "2026-08-02T00:00:00.000Z" })).anchorSource, "2026-08-02T00:00:00.000Z");
  // falls back to the planned date, and SAYS it fell back
  assert.equal(attemptWindow(record({ claimed_at: null })).anchor, "planned_date");
  // and gives up rather than inventing a window
  assert.equal(attemptWindow({ status: "uncertain" }), null);
});

// ── judging: the safety-critical branch table ────────────────────────────────────────────────────

test("found: a caption match inside the window returns Meta's own id", () => {
  const v = judgePublication({
    caption: CAPTION,
    window: attemptWindow(record()),
    media: [{ id: "17900", caption: CAPTION, timestamp: at(5 * 60 * 1000), permalink: "https://x" }],
    reachedWindowStart: true,
  });
  assert.equal(v.state, "found");
  assert.equal(v.remoteId, "17900");
});

test("absent: enumerated the whole window and the window is EMPTY of unexplained posts", () => {
  const v = judgePublication({
    caption: CAPTION,
    window: attemptWindow(record()),
    // outside the window, so it explains nothing about the attempt
    media: [{ id: "1", caption: "something else entirely, long enough to identify", timestamp: at(-10 * 24 * 3600_000) }],
    reachedWindowStart: true,
  });
  assert.equal(v.state, "absent");
});

test("NEGATIVE: an UNEXPLAINED post inside the attempt window blocks 'absent'", () => {
  // The caption is an identity heuristic. If it was edited after publishing, the unmatched post in
  // the window IS this post — and releasing the slot would publish it twice on a client's account.
  const v = judgePublication({
    caption: CAPTION,
    window: attemptWindow(record()),
    media: [{ id: "mystery", caption: "a different caption, long enough to be identifying", timestamp: at(30 * 60 * 1000) }],
    reachedWindowStart: true,
  });
  assert.equal(v.state, "undetermined");
  assert.match(v.reason, /sit inside the attempt window/);
});

test("NEGATIVE: never 'absent' when pagination stopped before the window start", () => {
  const v = judgePublication({
    caption: CAPTION,
    window: attemptWindow(record()),
    media: [{ id: "1", caption: "unrelated caption of sufficient length", timestamp: at(0) }],
    reachedWindowStart: false,
  });
  assert.equal(v.state, "undetermined");
  assert.match(v.reason, /pagination bound/);
});

test("NEGATIVE: never 'absent' when the caption is too short to identify anything", () => {
  const v = judgePublication({ caption: "短", window: attemptWindow(record()), media: [], reachedWindowStart: true });
  assert.equal(v.state, "undetermined");
  assert.match(v.reason, /too short/);
});

test("NEGATIVE: never 'absent' without a usable window", () => {
  const v = judgePublication({ caption: CAPTION, window: null, media: [], reachedWindowStart: true });
  assert.equal(v.state, "undetermined");
});

test("NEGATIVE: an identical caption OUTSIDE the window is not this attempt", () => {
  const w = attemptWindow(record());
  const v = judgePublication({
    caption: CAPTION,
    window: w,
    // same words, but published a week before the attempt — a rerun of an old post, not this claim
    media: [{ id: "old", caption: CAPTION, timestamp: at(-7 * 24 * 60 * 60 * 1000) }],
    reachedWindowStart: true,
  });
  assert.equal(v.state, "absent");
  assert.notEqual(v.remoteId, "old");
});

// ── enumeration: where reachedWindowStart is earned ──────────────────────────────────────────────

test("enumeration stops once it sees an item older than the window start, and says so", () => {
  const impl = fakeFetch([
    json({ data: [{ id: "a", caption: "x", timestamp: at(0) }, { id: "b", caption: "y", timestamp: at(-10 * 60 * 60 * 1000) }],
      paging: { next: "https://next" } }),
  ]);
  return listInstagramMediaBack({ igUserId: "1", token: "t", untilMs: anchorMs - 60 * 60 * 1000, fetchImpl: impl })
    .then((r) => {
      assert.equal(r.reachedWindowStart, true);
      assert.equal(r.pages, 1);
      assert.equal(r.media.length, 2);
    });
});

test("an exhausted feed also earns reachedWindowStart — there is nothing older to miss", async () => {
  const impl = fakeFetch([json({ data: [{ id: "a", caption: "x", timestamp: at(0) }] })]); // no paging.next
  const r = await listInstagramMediaBack({ igUserId: "1", token: "t", untilMs: anchorMs - 60 * 60 * 1000, fetchImpl: impl });
  assert.equal(r.reachedWindowStart, true);
});

test("NEGATIVE: running out of pages does NOT earn reachedWindowStart", async () => {
  const page = () => json({
    data: [{ id: "a", caption: "x", timestamp: at(60 * 60 * 1000) }],
    paging: { next: "https://next" },
  });
  const impl = fakeFetch([page(), page(), page()]);
  const r = await listInstagramMediaBack({
    igUserId: "1", token: "t", untilMs: anchorMs - 60 * 60 * 1000, fetchImpl: impl, maxPages: 3,
  });
  assert.equal(r.pages, 3);
  assert.equal(r.reachedWindowStart, false, "the bound was hit, so absence cannot be concluded");
});

test("NEGATIVE: a Graph error body throws rather than reading as an empty (== absent) feed", async () => {
  const impl = fakeFetch([json({ error: { message: "(#100) Invalid parameter" } }, { ok: false, status: 400 })]);
  await assert.rejects(
    () => listInstagramMediaBack({ igUserId: "1", token: "t", untilMs: 0, fetchImpl: impl }),
    (error) => error instanceof RemoteDedupUnavailableError && /Invalid parameter/.test(error.message),
  );
});

test("NEGATIVE: a non-JSON response throws rather than reading as an empty feed", async () => {
  const impl = fakeFetch([{ ok: true, status: 200, json: async () => { throw new Error("not json"); } }]);
  await assert.rejects(
    () => listInstagramMediaBack({ igUserId: "1", token: "t", untilMs: 0, fetchImpl: impl }),
    RemoteDedupUnavailableError,
  );
});

// ── identity derivation ──────────────────────────────────────────────────────────────────────────

test("the IG account id is derived from the token, never asserted from config", async () => {
  const impl = fakeFetch([json({ id: "1077001125507000", name: "Better Life", instagram_business_account: { id: "17841417101212436", username: "betterlifedivorce" } })]);
  const account = await deriveInstagramAccount({ token: "t", fetchImpl: impl });
  assert.equal(account.igUserId, "17841417101212436");
  assert.match(impl.calls[0], /\/me\?fields=id,name,instagram_business_account/);
});

test("NEGATIVE: a page with no linked Instagram account is an unavailable read, not an absent post", async () => {
  const impl = fakeFetch([json({ id: "1", name: "Page With No IG" })]);
  await assert.rejects(() => deriveInstagramAccount({ token: "t", fetchImpl: impl }), RemoteDedupUnavailableError);
});

// ── the whole lookup: every failure becomes undetermined, never absent ───────────────────────────

test("lookup: an unreachable Meta yields UNDETERMINED, never absent", async () => {
  const v = await lookupInstagramPublication({
    record: record(), caption: CAPTION, token: "t",
    deps: { deriveAccount: async () => { throw new RemoteDedupUnavailableError("Meta instagram media read failed: fetch failed"); } },
  });
  assert.equal(v.state, "undetermined");
  assert.match(v.reason, /fetch failed/);
});

test("lookup: a BUG in the verifier is named as ours, and still yields undetermined", async () => {
  const v = await lookupInstagramPublication({
    record: record(), caption: CAPTION, token: "t",
    deps: { deriveAccount: async () => { throw new TypeError("listMedia is not a function"); } },
  });
  assert.equal(v.state, "undetermined");
  assert.match(v.reason, /LOOKUP BUG \(TypeError\)/);
  assert.match(v.reason, /fault in the verifier, not in the account/);
});

test("lookup: a record with no usable timestamps yields undetermined before any network call", async () => {
  let called = false;
  const v = await lookupInstagramPublication({
    record: { status: "uncertain" }, caption: CAPTION, token: "t",
    deps: { deriveAccount: async () => { called = true; return {}; } },
  });
  assert.equal(v.state, "undetermined");
  assert.equal(called, false, "must not spend a Graph call on a record it cannot reason about");
});

test("lookup: the happy path threads identity → enumeration → judgement", async () => {
  const v = await lookupInstagramPublication({
    record: record(), caption: CAPTION, token: "t",
    deps: {
      deriveAccount: async () => ({ igUserId: "178414", igUsername: "betterlifedivorce" }),
      listMedia: async ({ untilMs }) => {
        assert.equal(untilMs, anchorMs - 60 * 60 * 1000, "enumeration must be told the window start");
        return { media: [{ id: "17900", caption: CAPTION, timestamp: at(60 * 1000) }], reachedWindowStart: true };
      },
    },
  });
  assert.equal(v.state, "found");
  assert.equal(v.remoteId, "17900");
  assert.equal(v.account.igUsername, "betterlifedivorce");
});
