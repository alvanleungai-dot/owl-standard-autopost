# Brand assets — &lt;company&gt;

Mandatory, standard location for every company's **non-secret** brand assets:
`companies/<id>/assets/`. Onboarding expects the logo here.

## Logo — put it here
- `logo.png`      ← primary logo, transparent background, ≥1024px long edge (preferred)
- `logo.svg`      ← vector if available (best — scales cleanly)
- `logo-mark.png` ← square icon-only mark → Facebook profile picture (≥512×512)
- `cover.png`     ← optional cover/banner; otherwise generated from the palette

Brand colors get sampled from the logo into `company.md` (`assets.brand_colors`), which then
drive post-image art direction and page dressing.

## Rules
- **Non-secret only.** Tokens / cookies / sessions → `secrets/<id>/.env`, never here.
- **Per company** — each brand keeps its own `assets/`; no shared logo pile.
