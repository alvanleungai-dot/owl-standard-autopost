# Status — 2026-W35 · Converted to a single-tenant Owl Standard engine

**Date:** 2026-08-25 · **Scope:** local checkout only (downloaded zip, no git remote, nothing pushed).

## What changed

This checkout was converted from the four-tenant HK-divorce engine into a **single-tenant Owl Standard**
engine. Owl Standard (簡樸房 / BHU compliance consultancy, Owl Square Group) is a different industry, so
reusing the divorce tenants' hardcoded topic pools was not viable.

### Deleted
- `companies/{better-life,bright-day,sunmood,tml}/` and `scripts/{better-life,bright-day,sunmood,tml}/`
- Divorce-hardcoded shared modules: `scripts/lib/topic-engine.mjs` (LENSES were HK-divorce strings),
  `scripts/lib/ledger.mjs` (hardwired to `companies/better-life`), `scripts/lib/brand-family.mjs`
  (cross-brand exclusion among the three divorce sisters — meaningless with one tenant)
- `scripts/gen-topics.mjs`, `scripts/gen-week.mjs`, `scripts/verify-family-dedup.mjs`
- ~25 divorce-only dev/probe tools (`fb-probe`, `gen-batch*`, `gen-poster-sunmood-v*`, `warm-chrome`, …)

### Added
- `companies/owl-standard/` — `company.md`, `voice.md`, `topics.md` (28 lens × 12 persona × 10 angle),
  `seeds.md` (27 real FAQs + post seeds), `assets/logo.png`
- `scripts/owl-standard/topic-engine.mjs` + `topic-engine.test.mjs` (6 tests) — an independent engine
  built from `topics.md`, with its own ledger/coverage under `companies/owl-standard/`

### Retargeted to `owl-standard`
`tg-bridge.mjs` · `write-caption.mjs` (rewritten with Owl Standard's compliance gate) ·
`derive-concept.mjs` · `gen-poster-v4.mjs` · `lib/fb-post.mjs` · `lib/poster-regen.mjs` ·
`lib/content-repair.mjs` · `lib/worker-jobs.mjs` (jobs + REVIEW_BOTS) · `repair.mjs` · `catchup.mjs` ·
`gatekeeper.mjs` · `contact-sheet.mjs` · `poster-qa-sweep.mjs` · `fb-topup.mjs` · `migrate-state.mjs`

## Verification
- **`node --test`: 498 tests, 497 pass, 0 fail, 1 skipped.**
- The 1 skip is `fonts.test.mjs` "sharp can actually DRAW Chinese" — skipped on `win32` only, because it
  discriminates via fontconfig family resolution, which Windows DirectWrite does not honour (it
  substitutes the same system CJK fallback for both family names, making the negative half undecidable).
  It still runs on the Linux/Render container the guard exists for.
- `scripts/selftest-cloud-import.mjs`: **checked=12 failed=0** — every scheduled job imports under a
  simulated cloud env.
- Every entry point (incl. `tg-bridge.mjs`) verified to import without error.

## Two real bugs found and fixed along the way
1. **`repair-wiring.test.mjs` was failing on Windows before any of this work** — it hardcoded
   `/tmp/week.json`, which resolves to `C:\tmp\week.json` (nonexistent) → ENOENT → the repair was HELD
   instead of confirmed. Now uses `mkdtempSync`.
2. **`tg-bridge.mjs` and `repair.mjs` imported files deleted mid-conversion** (`write-caption.mjs`,
   `derive-concept.mjs`, `lib/ledger.mjs`). The cloud-import selftest missed the `repair.mjs` case
   because that import is *dynamic, inside a function body*. Caught by importing entry points directly.

## Session 2 (same day) — the pipeline was then built

`scripts/owl-standard/` now holds the full loop, all registered as scheduled jobs:

| File | Role |
|---|---|
| `topic-engine.mjs` | picks a fresh topic from the 28 × 12 × 10 = 3,360-cell pool, least-used cells first |
| `gen-week.mjs` | topics → captions → concepts → posters → `weeks/<id>.json`; 3 posts/wk (TUE/WED/FRI) |
| `weekly-run.mjs` | runs the generator, sends each poster to Telegram for review; `OwlStandard-WeeklyAutopilot`, Thu 18:00, heavy |
| `api-schedule.mjs` | books approved posts to the FB Page via Graph API (native scheduling) |
| `api-ig-daily.mjs` | publishes that day's approved post to Instagram; `OwlStandard-IG-Daily`, 10:05 HK |

Poster art direction keeps the divorce layout (per owner instruction) with Owl Standard's palette
substituted throughout `gen-poster-v4.mjs`: paper `#FDF8F0`, ink `#14201c`, **orange `#EA6321`** replacing
the old crimson for the headline key phrase, card icons and pull-quote; footer band is ink with an orange
rule and reads "Owl Standard 簡樸房認證 / 一站式業主管理服務". Content-repair is now `supported: true`,
verified against the real generator rather than inferred.

Compliance is enforced in code, not just documented: `write-caption.mjs` and `derive-concept.mjs` both
reject guaranteed outcomes, 「5年」 (must be 「60個月」), 屋宇署-as-certifier (must be 房屋局), and implied
government endorsement. The caption retry NAMES the violated rule, because a bare "try again" reliably
reproduces the same slip. 9 new tests cover this gate.

### A real bug found while testing the gate
The 【hook】 check was **dead**. The footer contains 【Owl Standard 簡樸房認證】, so `/【.+?】/` on the
finished caption was always true — and it is inherited (upstream's footer carried the divorce brand's
name the same way). The knock-on is worse than a dead assertion: `markerFor()` takes the first line
containing 【, so a hookless caption would take the BRAND NAME as its publish-dedup marker — **identical
for every post** — and `api-schedule.mjs` would skip every post after the first as a duplicate. Fixed by
checking the hook BEFORE the footer is appended, via a shared `hookLine()` that excludes footer lines and
is used by both `write-caption.mjs` and `gen-week.mjs` so they cannot drift. Regression tests added.

## Still deliberately incomplete (each commented at the site)
| Gap | Consequence today |
|---|---|
| `companies/owl-standard/design.md` missing | poster art direction is inherited-layout + new palette; not written down as a spec |
| `schedule-week.mjs` (browser publisher) not ported | not needed — Owl Standard is `publish_via: graph_api`; the bot points at `api-schedule.mjs` |
| FB Page ID / IG user ID unset | both publishers **fail closed** with a named cause rather than guessing an account |

## Still required from the owner (cannot be derived from code)
Facebook Page ID · Instagram Business user ID · Telegram approver chat ID · the four API keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `TELEGRAM_BOT_TOKEN_OWLSTANDARD`) plus
`FB_PAGE_TOKEN_OWLSTANDARD`, in `secrets/owl-standard/.env`.
