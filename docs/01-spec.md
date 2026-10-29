# social-content-engine — Design Spec (v0.1, living)

**Owner:** lokairoy@gmail.com · **Started:** 2026-06-10 · **Status:** design / scaffolding

One engine, many companies. Auto-generates and publishes social content for a portfolio of businesses. **Plug-and-play:** onboarding a company means dropping a folder under `companies/` with one `company.md`; the shared engine in `src/` picks it up. No code changes per company.

This is the source-of-truth contract — a **living doc** we refine as we discuss each company. When it disagrees with another doc, this wins until the disagreement is logged in `02-decisions.md`.

---

## 1. Purpose & scope
- Publish to **Facebook Pages** now; **Instagram** is **phase 2**, per company, only where that company has an IG Business account.
- Serve **multiple companies** from one codebase — each with its own brand voice, channels, cadence.
- Onboard companies **one at a time**; each business differs and gets its own onboarding discussion.
- Reuse the proven model from `facebook-group-automation`: **seed pool + Claude drafting + Telegram weekly approval.**

**Out of scope (v0.1):** comment/DM replies, paid ads, analytics dashboards, networks beyond FB/IG.

## 2. Decisions locked so far
| # | Decision |
|---|----------|
| D1 | **New standalone repo** (not a fork of `facebook-group-automation`). Reuse its *patterns*, not its group-specific code. |
| D2 | **Content engine** = seed pool + Claude drafting + Telegram approval, with per-company voice + brief. |
| D3 | **Rollout** = multi-tenant design, onboard one company at a time; each gets its own discussion. |
| D4 | **Posting mechanism is per-company** via `publish_via`: `graph_api` (preferred) or `browser` (Playwright fallback). Webwright = dev-time repair of the browser path; Camoufox / browser-harness parked. |
| D5 | **`companies/` is data, `src/` is code.** Onboarding never edits `src/`. |

Open items: see §7.

## 3. Per-company contract — `company.md`
**YAML frontmatter = machine config** (parsed by code, *zero* LLM tokens). **Markdown body = the drafting brief** (the only part injected into Claude's prompt). Optional companions: `voice.md` (full voice rules), `seeds.md` (seed pool). Template: `companies/_template/`.

Frontmatter fields:
| Field | Meaning |
|-------|---------|
| `id` | folder-safe slug (matches the folder name) |
| `name` | display name |
| `status` | `pilot` \| `live` \| `paused` |
| `mode` | `training` \| `autopilot` (per-image approval vs batch-only) |
| `locale`, `timezone` | content language + posting timezone |
| `channels.facebook` | `{ enabled, page_id, publish_via: graph_api\|browser }` |
| `channels.instagram` | `{ enabled, ig_user_id }` — phase 2 |
| `cadence` | day → format map (drives the generator + seed rotation) |
| `post_window` | local time window for posting |
| `approver_telegram_id` | who approves this company's weekly batch |
| `budgets` | e.g. `image_usd_month` |

## 4. Engine modules (`src/`)
See [`src/README.md`](../src/README.md) for the full module map. Core: `tenants/` loads companies, `generator/` builds batches, `telegram/` approves, `publisher/` posts via the per-company channel.

## 5. Token-efficiency principles
1. **One small file is the unit of work** — drafting a company reads only its `company.md` (+ optional `voice.md`/`seeds.md`), never the repo.
2. **Frontmatter is parsed, not prompted** — config costs zero model tokens.
3. **Shared rules live once** in this spec/engine; per-company MD holds only deltas.
4. **Stable/volatile split** (`voice.md` stable, `seeds.md` volatile) is prompt-cache friendly.

## 6. Channel mechanics (reference)
- **Facebook Page (graph_api):** `POST /{page-id}/feed` (+ `/photos`), supports native `scheduled_publish_time`. Robust, ToS-compliant.
- **Instagram (graph_api, phase 2):** create container → publish; needs IG Business linked to the Page + App Review for content publishing; **no native scheduling** (we trigger publish at post time).
- **browser fallback:** Playwright driving the composer/Business Suite when a company can't get API access. Repaired with Webwright when the UI changes.

## 7. Open items (resolve in discussion)
- Final repo name (currently `social-content-engine`).
- Team / agent roster → `docs/agents/`.
- Pilot company selection; fill its `company.md`.
- Per-company posting mechanism + secrets (decided at each onboarding).
- Where seeds live per company (MD table vs Google Sheet).
- Image generation approach (reuse OpenAI `gpt-image` / Higgsfield from fb-group-automation?).

## Change log
- 2026-06-10 — v0.1 — Spec created; repo scaffolded. Decisions D1–D5 locked. Author: Project Lead (Claude), pending Owner review.
