---
id: company-id                 # folder-safe slug; must match the folder name
name: Company Name
status: pilot                  # pilot | live | paused
mode: training                 # training (per-image approval) | autopilot (batch-only)
locale: en                     # content language (e.g. en, zh-HK)
timezone: Asia/Hong_Kong
channels:
  facebook:
    enabled: true
    page_id: ""                # Facebook Page ID
    publish_via: graph_api     # graph_api (preferred) | browser
  instagram:
    enabled: false             # phase 2 — set true only if this company has IG Business
    ig_user_id: ""
cadence:                       # day -> content format (drives the generator + rotation)
  mon: story
  wed: image
  fri: tip
  sun: reflection
post_window: "21:00-22:00"     # local time window for posting
approver_telegram_id: 0        # who approves this company's weekly batch
budgets:
  image_usd_month: 30
assets:                        # MANDATORY — brand binaries live in companies/<id>/assets/
  logo: "companies/<id>/assets/logo.png"   # drop logo here (see that folder's README)
  brand_colors: []             # sampled from the logo during onboarding
---

# Company Name — Brand Brief

**One-liner.** <what the company does, in one sentence>

**Audience.** <who we're talking to>

**Voice.** <2–3 words>. See `voice.md` for full rules. <or inline the essentials if no voice.md>

**Topics (rotate).** <topic> · <topic> · <topic> · <topic>

**CTA rule.** ~1 in N posts links to <url>. The rest is pure value.

**Assets.** logo `companies/<id>/assets/logo.png` · brand colors `<hex>` / `<hex>` (sampled from logo)
