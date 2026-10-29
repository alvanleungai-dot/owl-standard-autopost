# Archive — 2026-07-31 session: five defects, queue depth, and the live verification

Rotated out of `docs/ai/PROJECT_STATE.md` on 2026-08-04. Kept because the *disease* named here
recurred on 2026-08-04 in a third variant (see the live state doc): **two measures of "is this
thing done" disagreeing, both sides exiting 0, nothing alarming.**

⚠ **Corrections applied 2026-08-04 — do not act on this file without re-deriving:**

- "**NEXT ACTION 1 — auto-regenerate a poster the image check rejects**" was **built and deployed**
  the same evening (`0a47cbd`, "feat(qa): redraw a rejected poster automatically, then judge",
  live 2026-07-31T21:55 UTC). The list below predates it.
- "`SCE-PosterQA` withholds and alarms but does not redraw" is therefore stale. The live problem
  is different: **PosterQA is killed at its 20-minute ceiling** (measured 07-31T22:22 and
  08-03T22:20 UTC), so it does not finish at all.
- The queue-depth and "8 weeks deep" measurements are 07-31 readings. Re-measure, never quote.

---

## FIXED 2026-07-31 — five defects, three of them the SAME disease

**1. Timed auto-approval had NEVER fired in production.** Every approved post carried
`decidedBy="manual"` — the owner was the only thing publishing. Each bot swept only the week
`active-week.json` points at, but `weekly-run.mjs` moves that pointer every Thursday, stranding
undecided posts at `pending` forever. Fixed by `scripts/lib/review-weeks.mjs` (`9e63e8e`).

**2. Nothing ever asked for more than one week of content.** `gen-week` could always target any of
the next 12 weeks; catchup only asked whether NEXT Monday existed. Content stopped dead a few weeks
out and September was never coming. Catchup now tops up to 8 weeks, time-boxed (`8aa49cc`, `ade85a6`).

**3. `list` / `keep all` still read the pointer** — with a deep queue they would have acted on a week
two months out while next Monday stayed undecided (`5443eb4`).

**4 + 5. THE SAME DISEASE, TWICE: two measures of "is this week done" disagreeing.**

- `selectGenerationWeek` counted ANY artifact, so an orphan caption from a failed run made it skip
  that week forever while catchup counted manifests and saw the hole (`798b6c7`).
- Then it counted the manifest FILE, so an EMPTY manifest from a failed run counted as a full week
  and three Sun Mood weeks could never be retried (`a0d3f38`).

**The lesson, and the enforcement:** every disagreement was invisible and permanent — both sides
exited 0 and nothing alarmed. `weekManifestHasPosts` became the SINGLE shared predicate used by the
generator and by catchup's depth. *Enforced by:* `generation-queue.test.mjs` carries both
regressions, including the exact Sun Mood shape (08-24 half-written, 08-31 complete) asserting
selection goes BACK. `review-weeks.test.mjs` carries the stranded-week regression **plus a control**
proving an ACTIVE week still auto-approves, so the suite cannot pass by breaking auto-approval
outright. **291 tests passed.**

> **2026-08-04 postscript — the same disease, third variant.** `weekManifestHasPosts` answers
> `posts.length > 0`, which is blind to posts that are *present but broken* (`status:"failed"` /
> `error` set). A week where generation failed for one post counts as finished, so catchup never
> revisits it and the broken post is permanent until a human runs `weekly-run.mjs` by hand. Making
> the predicate shared fixed the *disagreement*; it did not make the predicate *right*.

**Diagnosability:** catchup discarded the child's streams and printed only `Command failed`, which is
why Sun Mood failed silently for hours. It now prints stdout/stderr tails (`17712a5`).

## VERIFIED LIVE (2026-07-31, Meta Graph, read-only) — a 07-31 reading, re-derive before use

All four brands published **2026-07-27 10:00 HKT** and all four had **2026-08-03 booked**. Meta's own
scheduler publishes booked posts, so a booked post does not depend on this PC or on Render staying up.

Measured 2026-07-31 19:43: every brand 8 weeks deep, content to 21 September, 33 posts, 0 missing
posters. Sun Mood recovered on its own after the queue fixes. `SCE-Catchup` generated 11 weeks in one
24-minute unattended run; a brand-week costs ~2.5 min on the worker.

⚠️ **Derive each page id from `GET /me` with that brand's token.** `companies/<brand>/company.md`
`page_id` holds the **profile-URL id** for better-life, tml and sunmood — a Graph call against it
returns `(#100) nonexisting field`. Real graph ids: better-life `1077001125507000`, tml
`664363790084028`, sunmood `1209203835608287`, bright-day `327675207098381` (correct in both senses).
The publishers are unaffected: they act through the token's own page context.

## What "48 h of proven bot uptime" was waiting for

Stranded posts carry no liveness credit, so they needed 48 h of proven bot uptime from `9e63e8e`
landing — not 48 h of wall clock. The check: `review.decidedBy === "auto"` appearing for the first
time. **Superseded 2026-08-04** — the review bots have since emitted
`alert[<brand>:review-liveness-gap:…]` repeatedly (measured in the Render log, 08-02), which says
liveness is still not accruing to the full window. Fold this into the repair work rather than
tracking it as its own waiting game.
