# 2026-08-04 — the "image/API problem" was a missing font, and the repair layer that shipped

_Rotated out of `PROJECT_STATE.md` on 2026-08-05: verified resolved, no longer live state.
Kept because the DIAGNOSIS is reusable — the same class of cloud-migration regression will recur.
Incident narrative + the 5 rules it produced: `_ops/retro-log.md` 2026-08-04._

## The repair layer (the owner's actual ask)

**The disease:** this engine DOES, DETECTS and ESCALATES well, but only Windows *infrastructure*
could REPAIR (`infra-repair-core.mjs`, 06-28). That permission was never extended to publishing, so
every fail-closed block stayed closed until the owner opened it by hand. **`SCE-Repair` is that
missing layer** (hourly, non-publisher, shipped on `0277582`).

Owner's words, 2026-08-04: *"I need to know what's going on and fix it as a whole; I don't need a
patch solution. There should be a self-healing and self-repair process running on the cloud,
instead of me getting involved."*

## DONE + VERIFIED LIVE 08-04

- **All 5 stuck ledger slots released** against Meta's own record — `better-life/2026-W32-01/ig`,
  `W34-01/ig`, `tml/2026-08-03-01/ig`, `08-10-01/ig`, `08-17-01/ig`. IG-Daily's daily `exit 3` was
  cleared. `meta-publication.mjs` is also the **publication verifier** the older state doc called
  the only real gap — one build, both.
- **Ops alarms moved to `@Jimmi_Ops_bot`** (`TELEGRAM_BOT_TOKEN__OPS`, pushed to Render). No
  fallback; `render-worker` refuses to boot without it. Delivery proven live BEFORE the dependency
  was created. `alert.mjs` used to read `TELEGRAM_BOT_TOKEN`, which **is** `@landlord_fbgroup_bot`
  — that is how brand alerts reached the landlord bot.
- **CJK font shipped in-repo** and configured before any job spawns.
- **PosterQA rotated + time-boxed**; running out of time is now itself an alert naming the brands
  it never reached.

## ⚠ THE REAL "IMAGE PROBLEM" — it was NEVER the API

The Anthropic outage was real (preflight exit 2 on 08-02/08-03) and is **over** — probed HTTP 200
on 08-04, Render env matches the vault by hash. But every withheld poster carried a **poster-qa**
error, and the better-life ones read *"boxed hexadecimal-looking codes (e.g. `76 90 52 96`)"* —
those are the **code points of 百達利離婚事務所** drawn as tofu. sharp renders the footer SVG through
fontconfig; the Render build (`npm ci && npx playwright install chromium`) installs **no fonts**.
A **cloud-migration regression invisible on Windows**, where Microsoft JhengHei exists. Same cause
as the separately-filed "TML WhatsApp button garbled hex glyphs".

**Two things compounded it and matter more than the font:** poster QA's auto-redraw retried a
**deterministic environmental** failure, so every redraw reproduced identical garbling and those
futile loops are what pushed the job past its 20-minute ceiling; and the alert blamed the API
(`修好 API 後重新生成`) — corrected in all four brand bridges.

**✅ VERIFIED (2026-08-04 18:40 UTC):** `poster-qa sweep: 10 inspected · 4 redrawn · 4 recovered ·
0 withheld` and `completed 4/4 brand(s)`. **10 posters self-repaired that day, 0 by the owner.**

The first attempt failed on an ordering bug — `ensureCjkFont` ran 55 ms AFTER `triggerRunOnce`, so
the one-shot inherited an env without it and redrew 6 posters with no font. Fixed in `0277582`; a
guard in `fonts.test.mjs` now asserts the ORDERING, not just the presence. **Caught only by running
it** — the presence assertion passed the whole time.

## The Bright Day delivery loop (resolved, lesson retained)

`@brightday_socialmedia_post_bot` returned `chat not found` because the owner had never pressed
START, so it could never message him — found on the first live monthly batch (19:16 UTC). The first
version then retried that undeliverable batch **every ~60 seconds, forever**, violating the rule
written into `_ops/retro-log.md` the same afternoon ("never retry a deterministic failure").
Bounded to 3 attempts/brand/month, then one escalation through the ops bot. Verified live:
`attempt 1/3` → `2/3` → `3/3` → `alert[review-delivery:undeliverable:bright-day:2026-08]: SENT`.
