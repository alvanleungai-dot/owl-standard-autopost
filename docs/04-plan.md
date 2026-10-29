# social-content-engine — Master Plan (consolidated)

**Last updated:** 2026-06-10 · Status: design complete, ready to build the pilot.
Single consolidated view of everything decided. Detail lives in `01-spec.md`, `02-decisions.md`, `03-pricing.md`, `portfolio.md`.

---

## 1. Goal
Automate **well-designed Facebook content** (Instagram = phase 2) for a portfolio of companies, **plug-and-play**, so new or stale pages look established for incoming **ad traffic**. Onboard one company at a time.

## 2. Portfolio — 6 brands, 3 domains
| Brand | Domain | FB | IG | Status |
|---|---|---|---|---|
| TM Health | Health (bioresonance/eczema) | ✅ | ✅ | live + ads |
| 收樓易 | Property (rent recovery) | ✅ | ❌ | live, stale |
| **Better Life 百達利** | Divorce | ✅ | ? | **new → PILOT** |
| Bright Day 晨曦 | Divorce | ✅ | ? | live + ads, stale |
| Sunmood 新活 | Divorce | — | — | launching soon |
| New Vista | Divorce? | — | — | launching soon |

The 4 divorce brands are one business under different entities → share a knowledge pack, but **content must differ per page** (duplicate content across pages is a footgun).

## 3. Pilot
**Better Life 百達利離婚事務所** — brand-new page. Needs a **launch batch of 20–30 posts** so it looks established when ads send people to it.

## 4. Architecture
- **Multi-tenant:** `companies/` (data) + `src/` (engine code). **Onboarding never touches `src/`** — a new brand is just a new `companies/<brand>/` folder.
- Per-brand `company.md` (config + brief). The 4 divorce brands share `shared/divorce/` (HK divorce facts/FAQ) via a `family` field; the generator keeps each brand's posts unique.

## 5. Posting mechanism — browser, NOT API
- Owner can't get Page **admin** (partner/FB permission issue), so the **Graph API is out**. We drive the Owner's **logged-in Chrome** (the proven `facebook-group-automation` approach); **Webwright** authors/repairs the script.
- **Consequence:** no backdating (FB UI only schedules forward). "Established" = a **full, active current feed** (20–30 quality posts published now, spread over a few days) — not faked history.
- Requires the Owner's login to have **Editor/content access** to each page (confirmed: Owner can post normally).

## 6. Content pipeline — per post
| # | Step | Tool/model | Does |
|---|---|---|---|
| 1 | Planner | Claude Haiku | Pick pillar + format; no repeats within brand or across siblings |
| 2 | Researcher | **Perplexity Sonar** | Verify HK facts + citations (factual posts only) |
| 3 | Writer | Claude Haiku | Draft copy in brand voice from verified facts |
| 4 | Compliance/voice | Sonnet (risky) / Haiku | Checklist: no legalese, no medical claims, on-voice, not duplicate |
| 5 | Image | **gpt-image-2 medium** | Clean, brand-styled visual (good Chinese) |
| 6 | Approve → Publish | You (Telegram) → browser | You approve the batch; browser posts on your session |

## 7. Models, tools & keys
- **Write/plan:** Claude **Haiku 4.5** · **Compliance gate:** **Sonnet 4.6** for health/legal-risk posts
- **Research:** **Perplexity Sonar** · **Images:** **gpt-image-2 medium** (NOT DALL·E 3 — it garbles Chinese)
- **Keys (3):** `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `PERPLEXITY_API_KEY` (in gitignored `.env`)

## 8. Voice & compliance
- **Divorce:** plain-language practical **opinions**, **no formal legal jargon** ("don't get into trouble"), empathetic, "come talk to us" — never formal legal advice.
- **Health (TM Health):** **no medical-cure claims**; educational/lifestyle/testimonial framing (FB health-ad policy + legal risk).
- **Compliance = two parts:** (a) **facts** verified online via Perplexity; (b) **policy/voice rules** = an LLM applies a written checklist stored in the engine.

## 9. Content topics — Better Life pillars (rotate)
"What actually happens" (process) · Money & assets · Kids (custody/access) · Emotional support · Real situations (anonymized Q&A) · Myth-busting · Soft CTA (~1 in 8).

## 10. Pricing (one page)
**~$1.5–2 / month** + ~$1.5 one-time launch (gpt-image-2 medium). Image quality is the only real dial. All 6 brands ≈ **$8–12/month**. (Full breakdown: `03-pricing.md`.)

## 11. Roadmap
| Phase | Deliverable |
|---|---|
| **P0** | Design + repo scaffold + docs — ✅ **done** |
| P1 | Engine core: config, `tenants/` loader, sqlite |
| P2 | Content pipeline: planner → researcher → writer → compliance |
| P3 | Image-gen: gpt-image-2 wiring |
| P4 | Publisher: browser automation, wired to Better Life |
| P5 | **Launch batch:** generate 20–30 Better Life posts → Owner approves → publish |
| P6 | Weekly cadence on Better Life; then onboard the next brand |

## 12. Open / needs Owner
- Confirm **New Vista** business type.
- Drop the 3 API keys into `.env` when ready (not needed to draft samples).
- **Next step:** approve voice via **3 sample Better Life posts** before building.
