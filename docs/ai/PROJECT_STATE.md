# PROJECT_STATE — social-content-engine

_Last updated: 2026-08-07 (Opus 5) — golf on a two-a-week cadence; the monthly batch ran for the
first time, failed three ways, and now has a weekly rehearsal standing over it. Prior narrative:
`state-archive/2026-08.md`._

## 👤 THE ASK — the owner's own words

> 2026-08-04: "There should be a self-healing and self-repair process running on the cloud, instead
> of me getting involved."
> **2026-08-07: "I need a solid answer for this project that is bulletproof, and things will be
> running on its own on the cloud."** — asked after three latent defects surfaced at once. His
> complaint was not the bugs; it was that they kept appearing. See THE LESSON OF 08-07 below.

**Done means:** he never touches Telegram unless he wants to STOP a post, nothing runs on his PC,
no broken picture reaches a client page, and **a fault the engine can repair, it repairs**. Read
this before deciding what to work on.

## 🎯 CURRENT FOCUS — the repair layer is LIVE; golf is DEPLOYED and on a two-a-week cadence

**`SCE-Repair`** (hourly, non-publisher) is LIVE — the engine repairs its own fail-closed blocks
instead of waiting for the owner. History + the two lessons it generalised:
`state-archive/2026-08.md` and `2026-08-04-cjk-font-and-repair-layer.md`. **Read those before
re-diagnosing any poster or delivery fault.**

**Golf, 2026-08-07:** moved off the 08-06 five-minute burst to **two posts a week, Tue + Fri**, after
the board was MEASURED empty (30 rows, all `Published`). Three things here outlive golf:

- **A backstop must sit BELOW the shortest scheduled interval, never at the average.** "2 a week"
  reads as a 3.5-day gap, which would have blocked the Friday post every week *silently* — a pacing
  hold is a normal quiet outcome nothing escalates. 48 h, pinned by a test proving the 3.5-day
  version swallows the post.
- **`RUN_JOB_ONCE` re-fires on every restart** — its consumed flag is an in-process boolean and this
  worker restart-loops after every deploy. Any paid one-off needs a DURABLE claim written **before**
  the first paid call. `scripts/golf/monthly-batch.mjs` now does; proven by sabotage.
- **A Render one-off job has NO disk.** Anything whose output must survive has to run on the worker,
  or it pushes to the outside world while its own state evaporates.

### 🔴 THE LESSON OF 08-07: A JOB THAT HAS NEVER RUN IS NOT GREEN, IT IS UNKNOWN

`Golf-Monthly-Batch` shipped 08-06, first run set for **09-01**, broken **three ways from birth**.
The unit tests were green — they exercised PARTS, and all three defects lived in the SEAMS:
`monthly-batch` spawns `build-batch --only <generated n>`, rejected by a leftover 1..30 cap (every
render died in <1 s); the prompt's field contract vs. what each poster style requires (two of five
directions could never be generated, and the batch **re-rolled the rejects so its accepted count
still looked healthy**); and `saveGenerated`→render→push, where a crash between stages stranded 14
paid-for posts that the day's claim then correctly refused to retry — **two correct guards,
deadlocked**.

**Countermeasure: `Golf-Rehearsal`** (Mon 08:40, `scripts/golf/rehearse-batch.mjs`, declared in
`_ops/instruments.json`) runs those seams weekly for one small copy call — no images, no Notion
writes, never touches the generated store — and escalates to Telegram if the 1st would fail. Proven
by live sabotage: reinstate either shipped defect and it names it. **A monthly job is untested for
thirty days at a time; the answer is execution on a cadence short enough to matter, not more unit
tests.** NEXT ACTION 3 — every other sparse-cron job still carries this risk.

## 🔴 ONE OWNER ACTION — has Bright Day's bot been STARTed?

**`@brightday_socialmedia_post_bot` returned `chat not found`: the owner had never pressed START, so
it can never message him. Fix: open Telegram, find that bot, press START** — pending posts arrive on
the next sweep (≤2 min). *The "warnings need a delivery path" scar exactly — a channel never proven
on a green day.* ⚠ **UNVERIFIED since 08-05**: re-probe the bot before reporting this either way.

## ✅ NOT A FAULT — do not "fix" these

- **`Meta rejected …: (#100) The specified scheduled publish time was invalid`** — those dates are
  outside Facebook's ~30-day scheduling window. `fb-topup.mjs` retries daily *by design* and books
  them when they come into range. Only the log wording looks like a failure.
- **Self-healing, leave alone:** Telegram poll `ETIMEDOUT` from Singapore; `STATE_SEED_FAILED`
  restart-looping ~6 min after a deploy (`init-state-dir.mjs` refusing while the old instance still
  holds the 5-min disk lease — the worker never reaches `render-worker.mjs`, so a paid one-off job
  cannot fire during it). **Linux-worker noise:** `SCE-Gatekeeper`'s `agent-verify` spawn failure
  and `spawn powershell.exe ENOENT`.

## 📍 WHERE IT RUNS — measured, never remembered

**Worker `srv-d9lbsr3m8hqs738cud5g`** (background_worker, starter, Singapore, `autoDeploy=no`).
**A push ships NOTHING.** Deploy via the API, confirm the commit from the service's own log.
Commands: `_ops/RUNBOOK.md`. **A restart does NOT reload env vars — only a deploy does.**

**Never write a deployed-commit reading here — it is stale the next time anyone deploys.**
`node _ops/scripts/render-status.mjs` compares the DEPLOYED commit to `origin/main` and exits 1 on a
gap (built after `8304a59` sat undeployed 08-02→08-04 with no gate noticing). Jobs + crons:
`scripts/lib/worker-jobs.mjs` (HK tz). Local Windows tasks are Disabled except
`FB-Landlord Weekly Generate` + `FBAutomation-Bot`, which run locally BY DESIGN.

⚠ **Env vars need a DEPLOY, not a restart, and must be written with the PER-KEY endpoint**
(`/v1/services/<srv>/env-vars/<KEY>`) — the bulk PUT REPLACES all 57 at once.

## 👥 WHO CAN SEE THIS REPO

`Crackcorn420/social-content-engine`, **private**, on the owner's PERSONAL account (not
`Auspicious-Global`). **OWNER RULING: read-only collaborators see HOW it is built; they may NEVER
use his Render, tokens or APIs** — the boundary holds by construction (a clone gets code and NO
keys). **Re-derive the collaborator list before stating it** (`GET /repos/.../collaborators` +
`/invitations`). Audit + forking caveat: `state-archive/2026-08.md`.

## 📬 HOW THE OWNER IS CONTACTED (changed 2026-08-04)

**ONE batch per calendar month, per brand, through that brand's own bot** — not the weekly Thursday
drip (~200 review messages a year for a man whose goal is "hands-off"). Trigger is **"the HK month
differs from the month last delivered"**, not "today is the 1st", so a bot down on the 1st catches
up instead of skipping. **Safety net:** anything within **7 days** of publishing that he has never
seen is delivered out of cycle, and a post is stamped "shown" **only after Telegram accepts it** —
stamping first would start the 48 h auto-approve on a poster he never received. Reversible with
`REVIEW_DELIVERY_MODE=weekly`. Bots: `@betterlife_socialmedia_bot` · `@tmhealth_socialmedia_bot` ·
`@sunmood_socialmedia_bot` · `@brightday_socialmedia_post_bot` · **`@Jimmi_Ops_bot` (problems only)**.
**Golf is the exception — it reviews on a Notion board, not Telegram.**

## ▶ NEXT ACTION

1. **Golf: CLEAR `RUN_JOB_ONCE`, `GOLF_MONTHLY_COUNT`, `GOLF_RESUME_NUMBERS` and ENABLE
   `JOB_GOLF_REHEARSAL_ENABLED`, in ONE deploy** (per-key env PUT/DELETE; the bulk PUT replaces all
   57 vars). Until then the 1 Sept cron would run at 16 posts and the one-off re-fires on every
   restart. **Do it only when no batch is mid-render — a deploy SIGTERMs the instance.**
2. **Content repair is wired for better-life only.** tml/sunmood/bright-day are DECLARED unsupported
   with reasons in `content-repair.mjs` — follow `poster-regen.mjs`'s precedent and verify a brand's
   generator end to end before wiring it. **tml poster regeneration is also unwired**
   (`RegenUnsupportedError`), so a garbled tml poster still cannot self-heal at all.
3. **THE GENERALISATION NOBODY HAS BUILT: no check asks "has this job's WORK path run since the
   code changed?"** `Golf-Rehearsal` solves it for ONE job. Every other entry in `SCHEDULED_JOBS`
   with a sparse cron — the four Thu-18:00 autopilots, `SCE-ContactSheet`, `Golf-Render-Selftest` —
   carries the identical risk that killed Golf-Monthly-Batch: registered, enabled, never executed,
   and green because silence is read as health. The fix is a detector over `SCHEDULED_JOBS`, not
   more unit tests. **Sized as its own session** — it touches every job and the watchdog.
4. **Two golf money-path changes from 08-06 never got the mandatory-tier second opinion**: the image
   retry budget and publish pacing. Codex adversarial pass on `image-fetch-budget.mjs`,
   `build-batch.mjs`'s `fetchImage`, `publish-pacing.mjs`.
5. **Measured render time is ~200 s, not the 165 s cited in comments** (14 renders, 2026-08-07:
   14:38:36→14:41:55 etc.). Two runtime ceilings were sized from 165; both still hold (100 min
   covers 16 × 200 s = 53 min), but re-derive from 200 before trusting either again.

*Owner policy set 08-04 (silent default): `SCE-Repair` republishes to a live client account ONLY on
a positive verdict of absence from Meta; anything ambiguous stays blocked and escalates.*

## ⚠️ KNOWN, NOT URGENT

- **Review liveness is still not accruing to the full 48 h window** — `review-liveness-gap` alerts
  firing since 08-02 for better-life, tml and sunmood. Fold into the repair work. Sun Mood also
  carries a `held` status with no review stamp; `held` posts are never auto-approved, so they wait
  indefinitely — confirm that is intended.
- **`Golf-Notion-Feedback` runs every 2 min and floods the log**, crushing Render log retention to
  ~2 hours. Post-hoc diagnosis of anything else needs the logs API with an explicit time window.
  Quieten it.
- **TML poster layout:** footer bar overlaps body text; the WhatsApp button renders garbled hex
  glyphs. A layout defect in the composite, not an AI one.
- **Never restate a credential's health here — cite the probe** (`fb-token-probe.mjs`, wired into
  `preflight.mjs`).
