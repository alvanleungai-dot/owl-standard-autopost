# Decisions (ADRs) — social-content-engine

Decisions that shape the build. Living doc. Newest context wins until superseded.

## D-01 — Publishing: browser automation, NOT Graph API
> **⚠️ SUPERSEDED by [D-13](#d-13--publishing-via-the-graph-api-not-browser-automation) (2026-06-22).** Kept for history. Browser posting is now a **last resort** only where no API/token is possible; the default is the Graph API.

**2026-06-10.** Owner can't get **admin** on the FB Pages (partner / Facebook permission issue), and Graph API content-publishing needs admin + app review. So **Graph API is OUT.** We publish by driving the Owner's **logged-in browser session** — the proven approach in `facebook-group-automation` (drives real Chrome, no bot account).

**Consequences (important):**
- **No backdating.** The Page composer / Business Suite Planner only schedules *forward* (future). Past-dating isn't automatable via the UI. → **We cannot fake aged history.** Instead we build a *full, active, current* feed (20–30 quality posts published now, spread over a few days so it doesn't look dumped).
- Requires the Owner's FB login to have at least **Editor / content access** to each Page (confirm per page — even without full admin).
- **Tooling:** reuse the proven **Playwright + real-Chrome-profile** base from `facebook-group-automation` as the deterministic runtime; use an **AI browser agent (Webwright)** to author & self-heal the per-page posting flow. Webwright *writes Playwright code* — that's why Playwright keeps coming up; they're a pair, not rivals. `browser-harness` = alternate runtime agent if needed. (Tool choice pending Owner OK.)

## D-02 — Structure: per-brand folders + shared family knowledge
Each brand = `companies/<brand>/company.md`. The 4 divorce brands share a `shared/divorce/` knowledge pack (`family: divorce`); the generator keeps each brand's posts distinct.

## D-03 — Divorce family content: distinct voice + distinct images, rare topic overlap
Topics may occasionally overlap, but **writing style and generated images MUST differ per brand.** Avoids the duplicate-content footgun across the 4 pages.

## D-04 — Images: OpenAI gpt-image (ChatGPT), per-brand style
Feed images via OpenAI gpt-image (reuse `facebook-group-automation`'s gpt-image-2 wiring). Per-brand distinct visual style.

## D-05 — Voice (divorce family): plain-language opinions, no legal jargon
Owner rule of thumb: (1) give practical legal **opinions / guidance**; (2) **avoid formal legal terminology** so we don't imply practicing law / invite regulatory trouble. Empathetic, plain Chinese, "come talk to us" — never formal legal advice.

## D-06 — Pilot: Better Life 百達利離婚事務所
First brand built end-to-end. Brand-new Page → needs the launch batch (20–30 posts).

## D-07 — Research: Perplexity (Sonar)
**Final 2026-06-10.** Owner chose Perplexity for research. The Researcher step calls Perplexity Sonar (~$0.012/call: $5/1k requests + $1/$1 tokens), returns facts + citations to the writer. (Research vendor cost is negligible — Perplexity/ChatGPT/Claude all ~1–2¢/call; chosen on quality.)
**Keys needed (3): `PERPLEXITY_API_KEY` (research) + `OPENAI_API_KEY` (images) + `ANTHROPIC_API_KEY` (Haiku writing).**

## D-11 — Every post is a well-designed image post — gpt-image-2 medium
All posts carry an image. **Model = gpt-image-2** (~99% text accuracy, native Chinese) — **NOT DALL·E 3** (~60%, garbles Chinese regardless of quality). Chinese strength is model-level, so **medium** quality (~$0.04–0.06/img) renders legible Chinese cheaply. Avoid the mini/low tier (character flips). High quality (~$0.17–0.21) only for hero polish. Belt-and-suspenders: Chinese copy can also live in the caption (always perfect text).

## D-08 — Models: Haiku writes, Sonnet guards the risky posts
- **Planner + Writer → Claude Haiku 4.5** (`claude-haiku-4-5`) — Owner's cost choice; cheap, the compliance step is the safety net.
- **Compliance/voice gate → Claude Sonnet 4.6** (`claude-sonnet-4-6`) for health-claim and legal-process posts (highest risk); Haiku otherwise.
- Costs are tiny (text « $1/mo; images are the main spend at a few ¢ each) — model choice is about risk, not pennies.

## D-09 — Compliance = two parts (only one is "online")
1. **Factual accuracy** → verified online via Perplexity (with citations).
2. **Policy + voice rules** (no legalese, no medical-cure claims, FB ad-policy adherence, on-brand tone) → an LLM applies a **written checklist stored in the engine**, not a live lookup per post.
**Rejected:** Publitio (media CDN) and Sonix (audio transcription) — neither checks written content; not used for compliance.

## D-10 — Secrets handling
Shared API keys live in a gitignored `.env` (template: `.env.example`). Keys are never pasted into chat or committed.

## D-12 — Instagram: ON for Better Life; FB+IG via one Business Suite composer; cross-post is a hard rule
**2026-06-17.** Better Life opened an Instagram account, **linked to its FB Page in Meta Business Suite.** We **reuse the proven TML pattern** (`scripts/tml/schedule-week.mjs`): one Business Suite composer schedules the Page + linked IG together in a single pass — **no new tooling, no Graph API** (still no admin; consistent with D-01).

**Hard rule (cross-post):** for any tenant with `instagram.enabled: true`, every new post publishes to **FB + IG together** — never one channel only. IG-enabled: **TML, Better Life.**

**Launch fill:** all ~40 existing Better Life pieces (launch 1–25 + batch-2 26–40, posters `01`–`40`) burst-published to IG over ~3–4 days. Per **D-01 there is no backdating** — the grid fills with current-dated posts; the *full grid* (not old timestamps) is what reads as established. Captions post **as-is** (hashtags already present); the only IG adaptation is **link-in-bio** for WhatsApp/site, since IG caption links aren't tappable. FB/IG kept **consistent** (same brand) — the per-brand differentiation rule (D-03) governs sister *brands*, not the two channels of one brand.

## D-13 — Publishing via the Graph API, NOT browser automation
**2026-06-22. Supersedes [D-01](#d-01--publishing-browser-automation-not-graph-api).** Once the owner got **page admin**, we migrated Facebook posting to the **official Graph API**: a long-lived (non-expiring) **PAGE token** + scheduling by exact `scheduled_publish_time`. Proven on Better Life — **12/15 posts scheduled + verified at the correct dates**, hands-off and reliable. **Runbook (replicable, per brand): [`docs/runbooks/facebook-graph-api-onboarding.md`](runbooks/facebook-graph-api-onboarding.md).**

**Why — browser automation defeated us THREE times on Meta Business Suite (all confirmed live, DOM-proven):**
1. **Page-switch.** The "active page" is **account-level** with no scriptable switcher. It had drifted to **Sunmood**, so *every* brand's scheduler composed onto the **wrong page**. The Business Suite header page-name is a static non-clickable `<div>`; the home "switcher" entries are cross-asset feed cards; `asset_id` errors on the composer. A platform ceiling, not a Playwright/Webwright gap.
2. **Date-picker.** Typing a date **silently reverts to TODAY** — a real batch scheduled **15 Sunmood posts to "tonight"** instead of across a month, and wrongly reported success. Even a calendar-click that works in one composer didn't stick in another.
3. **Delete a scheduled post.** The control is **hover-only / unlabelled** and won't script — so even cleanup was manual.

**The API removes all three:** post by `page_id` (no active-page concept) · schedule by exact timestamp (no date-picker) · `DELETE /{post_id}` (clean reversal). See the runbook for the exact gotchas (NPE empty `/me/accounts`, API-id ≠ URL-id, the consent "Manage posts" toggle defaulting OFF, the ~30-day window).

**Consequences:**
- **Default posting mechanism is `graph_api`** (per-company `publish_via`); set it per brand at onboarding.
- **One Meta app for the portfolio** — `FB_APP_ID` + `FB_APP_SECRET` shared; each brand needs only its own **page token + page API id**. Token lives in the gitignored vault (`FB_PAGE_TOKEN_<BRAND>`) → project `.env`, never committed.
- **Browser stays a last resort** only where no API/token is possible (e.g. a page the owner can't get admin on). The browser guards (verify-and-abort page pin, date-verify hard guard, `POSTING_FROZEN` kill-switch) remain in place for any brand still on that path.
- **Instagram is phase 2** and still heavier — needs `instagram_content_publish` (usually App Review) + public image URLs + a publish-at-time job (the IG API can't native-schedule). IG-enabled brands keep the Business Suite one-composer cross-post (D-12) until then.

## D-14 — Cadence: 1 post/week (Monday 10:00 HK), reuse the paid backlog
**2026-06-25.** Going-forward generation is **1 post/week, Monday 10:00 Asia/Hong_Kong** for every brand (was 3/week Mon-Wed-Fri, was 5/week before that). **Reason = cost control** (images are the main spend). The already-PAID scheduled content is **re-spaced to consecutive Mondays** (`scripts/rebalance-dates.mjs`) so it stretches **~3 months → almost no new image generation until ~October**. `scripts/fb-topup.mjs` + `SCE-FB-Topup` (daily) schedules each backlog Monday into FB as Meta's ~30-day window rolls; per-brand `*-IG-Daily` jobs publish the IG side. `company.md` cadence fields updated per brand.

## D-15 — Gatekeeper: ONE triaged CEO digest, recommend-not-mutate
**2026-06-26.** The owner is the CEO — they get **ONE** proactive, already-triaged health report (severity + concrete recommendation per issue), **never raw repeating monitor alerts**, and never have to first-notice a problem. `scripts/gatekeeper.mjs` + pure `scripts/lib/gatekeeper-core.mjs` (13 tests) gathers task-health + per-brand posting coverage + a generation-log scan, triages each finding 🟢/🟡/🔴, and **escalates by persistence** (day 1 note → day 3+ louder) via `secrets/gatekeeper-state.json`. **It recommends only — it never auto-disables a task or touches FB/IG.** Routed through `alert.mjs` (dedupe + escalate). **In progress:** a self-healing "level b" layer that auto-fixes **only a strict 2-item whitelist** (re-run a transient day-1 task failure · `fb-topup` a coverage gap), uses a **strictly read-only agent** to diagnose, and **escalates anything risky** (gated by `GATEKEEPER_AUTOFIX`, default on).

## D-16 — Self-healing infra repair runs elevated from a user-writable checkout (accepted residual)
**2026-06-29.** task-health auto-repairs a broken monitor/scheduler task by re-running its committed
`register-*.ps1` — which needs admin, so **SCE-TaskHealth runs S4U + RunLevel Highest** (the single elevated
repairer; the Gatekeeper was de-escalated to **Limited** to keep ONE narrow elevated surface). A Codex
adversarial review flagged [critical] that an elevated task executing scripts from a **user-writable**
checkout (`C:\Users\jimmi\Downloads\…`) lets any code already running as the user tamper with
`task-health.mjs` and gain admin execution with no UAC.

**Decision: ACCEPT the residual on this personal single-admin PC; minimize the surface; do NOT add lockdown
machinery.** Rationale:
- **The threat is incremental here.** Any program already running as the user on a personal box can read the
  secrets vault + FB tokens, exfiltrate, and reach admin by other means (UAC-bypass, DLL hijack, or just
  waiting for the user to elevate anything). Tamper-proofing one scheduled-task script adds little on top.
- **The "proper" fixes cost more than they save *here*.** ACL-locking the tracked scripts breaks `git`
  pull/checkout on them; a protected-copy + deliberate elevated deploy adds staleness risk + recurring UAC
  friction — disproportionate to the marginal risk on a single-user machine.
- **Surface is minimized instead:** only **one** task (task-health) is elevated; the Gatekeeper + all its
  LLM / alert / read-only-agent code run **Limited**. The elevated path runs ONLY committed `register-*.ps1`
  (no FB/IG, no spend, no network beyond Task Scheduler).

**FLIP THIS DECISION IF the runtime moves off the personal box** — a shared machine, a server, or the offered
**cloud VPS**. There, do the full fix: run the elevated repairer from an **admin-owned, ACL-locked directory**
(`C:\ProgramData\SCE\` or `/opt/sce`), deployed by a deliberate elevated step; the repo stays the editable
source, the protected copy is what runs elevated. (Codex's recommendation — deferred, not rejected.)

## Open
- New Vista business type (divorce?).
- Per-page confirmation that the Owner's login can post (Editor access).
- IG handles: **TM Health ✅ live** (`@info.allegies`, now via Graph API), **Better Life ✅ live** (`@betterlifedivorce`, via Graph API). **Sunmood + Bright Day are FB-only** (no IG). All four brands now post FB via the Graph API (see [D-13](#d-13--publishing-via-the-graph-api-not-browser-automation)).
