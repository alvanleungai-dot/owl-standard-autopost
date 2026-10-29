# social-content-engine — Owl Standard edition

Auto-generates social content (**Facebook Page + Instagram**) for **Owl Standard 簡樸房認證** (Owl Square
Group's BHU compliance-consultancy brand). **Nothing is published until a person approves it in Telegram.**

> **Single-tenant fork.** Upstream served four HK divorce brands and hosted another client's golf pipeline;
> both were deleted here. Unused Windows-era tools are parked in `_archive/`. See
> `docs/05-status/2026-W35-owl-standard-conversion.md`.

## How it works
1. `companies/owl-standard/` holds the tenant data: `company.md` (config + brief), `voice.md` (tone),
   **`facts.md` (the only dates, fees, penalties and standards a post may cite)**, `topics.md`, `seeds.md`.
2. Thursday 18:00 HK (with catch-up Fri–Sun) `scripts/owl-standard/weekly-run.mjs` generates the next missing
   week — 3 posts, Tue/Wed/Fri — keeping about 5 weeks ready: topic → caption (`write-caption.mjs`) → poster
   concept (`derive-concept.mjs`) → poster (`gen-poster-v4.mjs`). Captions and concepts must pass the seven
   compliance red lines in `scripts/lib/compliance.mjs`.
3. The review bot (`scripts/tg-bridge.mjs`) sends the posters on the 1st of each month, plus anything publishing
   within 7 days that you have not seen. Tap ✅ / ❌ / 🔁. **Unapproved posts never publish**; a reminder comes
   24 hours before the publish time.
4. ✅ books the post on Facebook at once (`scripts/owl-standard/api-schedule.mjs`, native scheduling at 10:00 HK)
   and reports the result in the chat; `SCE-FB-Topup` re-runs it daily, and books posts more than 29 days out
   once they enter Meta's window. ❌ or 🔁 on a booked post cancels its Facebook booking.
5. `scripts/owl-standard/api-ig-daily.mjs` (10:05 HK) posts that day's approved, Facebook-booked post to Instagram.

## Layout
| Path | What |
|------|------|
| `companies/owl-standard/` | tenant **data** — config, voice, facts, topics, seeds, brand assets |
| `scripts/` | engine **code**; `scripts/owl-standard/` holds tenant-specific logic |
| `scripts/lib/` | shared libraries (paths, alerts, review, compliance, publish ledger, worker jobs) |
| `assets/fonts/` | the CJK font shipped with the repo (the Render container installs none) |
| `docs/` | spec, decisions, weekly status |
| `_archive/` | files no longer used, kept for reference (see its README) |
| `secrets/`, `data/` | gitignored (tokens, run state) |

## First run
```bash
node scripts/owl-standard/doctor.mjs
```
Free pre-flight check — files, keys and switch values (a wrong switch value silently turns a job off).
Then, with the Higgsfield keys set, `node scripts/owl-standard/verify-higgsfield.mjs` to find the image endpoint.

## Run the tests
```bash
npm install && node --test scripts/**/*.test.mjs scripts/*.test.mjs
```
