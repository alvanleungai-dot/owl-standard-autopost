# CLAUDE.md — social-content-engine

> ## ⚠️ SESSION START — READ FIRST
> 1. **Before assessing state or answering "where are we", READ the latest [`docs/05-status/<YYYY-WW>.md`](docs/05-status/).** Do NOT infer state from globbing files or from the aspirational `docs/04-plan.md`. (A 2026-06-17 session wrongly declared the project "empty scaffolding" by skipping this — the work was all on disk under `scripts/` + `companies/`.)
> 2. **The engine is `scripts/*.mjs`.** Shared libs in `scripts/lib/`, tenant-specific in `scripts/owl-standard/`. (The old `src/` placeholder was deleted 2026-08-25 — it never held real code.)
> 3. **COMMIT + PUSH at the end of every work session** (`git push origin main`). This repo was once 67 files / months of work uncommitted with no remote — don't let it drift again.
> 4. **Before any substantial design / content / build work, READ [`docs/how-we-work.md`](docs/how-we-work.md)** — the collaboration & craft playbook (copy what works · contract-first · self-vet before showing · one-thing-at-a-time · decide, don't over-ask). It exists so we stop repeating the loops that waste time and money.

**SINGLE-TENANT (Owl Standard) fork.** Was a four-brand HK-divorce engine; converted 2026-08-25 — those
tenants are deleted and every shared path retargeted to `owl-standard`. Read
[`docs/05-status/2026-W35-owl-standard-conversion.md`](docs/05-status/2026-W35-owl-standard-conversion.md)
FIRST. `scripts/` = shared engine code, `companies/owl-standard/` = tenant data. Publishes to
**Facebook Page + Instagram** together.

## Source of truth (in order)
1. [`docs/01-spec.md`](docs/01-spec.md) — the design contract (living doc).
2. [`docs/02-decisions.md`](docs/02-decisions.md) — ADRs. Read before re-litigating an architecture choice.
3. [`docs/05-status/<YYYY-WW>.md`](docs/05-status/) — where we are. Read this first for "where are we?".

## Hard rules
- **Onboarding is data, not code.** A new company = a new folder under `companies/<id>/`. Tenant-specific logic, if genuinely needed, goes in `scripts/<id>/` — never into `scripts/lib/`.
- **Posting mechanism is per-company** (`publish_via` in `company.md`): `graph_api` (default/preferred) or `browser`. Decide per company during its onboarding discussion — never globally.
- **Instagram cross-post (hard rule).** Owl Standard has `instagram.enabled: true`, so **every new post publishes to Facebook + Instagram together**. Never ship a new post to only one channel.
- **Compliance rules are enforced in code, not just documented.** `scripts/write-caption.mjs` rejects a caption that guarantees an outcome, writes 「5年」instead of「60個月」, credits 屋宇署 instead of 房屋局, or implies government endorsement. Sources: `companies/owl-standard/company.md` "Compliance red-lines" + `content/ordinance-cap658.md` (Cap. 658).
- **Browser tooling:** obey the global pre-flight gate + ledger at `~/.claude/browser-tooling.md`. API-first; deterministic committed scripts at runtime; route page snapshots through context-mode.
- **Secrets** live in `secrets/<company>/.env` — never in `companies/` and never in code.
- **Brand assets** live in `companies/<id>/assets/` (non-secret): logo at `logo.png`, colors sampled into `company.md` `assets.brand_colors`. Mandatory for every company — secrets still go in `secrets/<id>/.env`, never here.
- **`_template/` is not a tenant** — the engine ignores leading-underscore folders.

## Team model
This project runs as a small team of named specialists (PM, voice, engineering, QA, docs). Roster + charters live in `docs/agents/` — **to be defined in the next discussion.**

## Conventions (inherited from facebook-group-automation)
- TypeScript strict, ESM. Ports + factories; components don't import each other's impls — deps injected at the CLI layer.
- Zod-validated config. `node:sqlite` (no native build). Pin timezones explicitly.
- No `console.log` — use a child logger. All thrown errors carry an explicit `kind`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
