# companies/ — tenants

Each subfolder is **one company** (a tenant). The shared engine in `src/` loads every `companies/*/company.md` at runtime. `companies/` is **data**; `src/` is **code**.

## Onboard a new company
1. Copy `_template/` → `companies/<company-id>/` (lowercase, hyphenated, e.g. `owl-square`).
2. Fill `company.md` frontmatter (channels, cadence, approver) + the brand-brief body.
3. Optional: fill `voice.md` (full voice rules) and `seeds.md` (seed pool).
4. Put secrets in `secrets/<company-id>/.env` — **never** in this folder.
5. Discuss + set this company's posting mechanism (`publish_via`) before go-live.

## Files per company
| File | Required? | Purpose |
|------|-----------|---------|
| `company.md` | ✅ | config (frontmatter) + brand brief (body) — the one file the engine needs |
| `voice.md` | optional | full voice contract Claude reads when drafting |
| `seeds.md` | optional | seed pool (markdown table) the generator rotates through |

`_template/` itself is **not** a tenant — the engine ignores leading-underscore folders.
