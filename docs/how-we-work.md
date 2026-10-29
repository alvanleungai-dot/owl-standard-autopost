# How We Work — Collaboration & Craft Playbook

> A living memory of how the owner and Claude work best together, and the traps that waste time and money.
> **General principles — apply across every brand and project, not just one.** Read this at the start of any
> substantial design / content / build session. Agents: this is part of the session-start "read first" set,
> so you inherit it automatically. When you hit a new friction or find a better way, **add a row** — this doc
> should get better every time we work.

## Why this exists
We have lost time and money going in circles — most painfully on design: reinventing instead of reusing what
already works, building without an agreed spec, showing unvetted work, and over-asking. This records the
lessons so we don't repeat them.

## The owner in one line
**Wants good work — decided and shown — not a stream of questions or generic AI-slop.** Bring results and
clear choices; don't make the owner run the work for you.

## Part 1 — What gets us stuck (and the fix)

| Trap (what wasted time) | Do this instead |
|---|---|
| **Reinventing** an approach when the project already has one that works | **Copy what works first.** Study the proven example in the project, replicate its *method*, then adapt. Never invent a new lane unasked. |
| **No spec → drift.** Building without an agreed contract, so the work drifts and gets rejected | **Contract-first.** Write the rules (do's/don'ts, palette, voice, format, size) as a short spec, get a quick sign-off, then build to it. |
| **Showing unvetted / bad work** — costs trust, time, money | **Self-vet hard before showing.** Check against the contract + correctness (language, layout, nothing cut off, right size). If it fails, fix it silently. Only surface work you'd stand behind — and flag any real flaw honestly rather than overselling. |
| **Going over and over** in big batches | **One thing at a time.** Show a single item, get a clear verdict (lock / tweak), lock it, move on. Don't batch four when one decision unblocks the rest. |
| **Over-asking** ("what do you want?") | **Decide and show.** Make the sensible call, state it, show the result. Ask only when it's genuinely the owner's call and you truly can't infer it. |
| **Generic "AI-slop"** (text pasted on a background, default fonts, the same SaaS look) | **Cohesive craft.** Build/render the whole artifact as one designed piece; anchor to a quality exemplar; no "stuck-on" elements. |
| **Wasting spend** (re-generating paid assets repeatedly) | **Get the direction right before volume.** Nail one sample, lock the style into the contract, then scale. Be explicit about cost. |

## Part 2 — The cadence that works
1. **Anchor** → find the proven example; understand *why* it's good.
2. **Contract** → write the short spec; get a quick yes.
3. **One sample** → build one, **self-vet**, show it, get a verdict.
4. **Lock & move** → lock the approved piece into the contract; do the next one.
5. **Automate** → once the pattern is locked, wire it into the repeatable system.

## Part 3 — Craft principles (design / content)
- **Reuse the engine, swap the identity.** One proven system + per-item config (colour, voice, format) beats
  bespoke one-offs — and keeps siblings distinct while each stays internally consistent.
- **Whole-artifact, not composite.** Generate the complete designed piece; don't paste parts together.
- **Make it real to the audience.** Correct language / idiom, content-driven titles, nothing clipped, right
  dimensions, full-bleed where expected.
- **Distinct but consistent.** Sibling brands must not read as the same company; one brand's pieces must read
  as one system. Vary content/format so a feed never looks duplicated.

## Part 4 — So we don't forget (memory)
- **Record as we go:** decisions → ADRs; status → the weekly status doc; per-item rules → its own contract
  (e.g. a brand's `design.md` + `company.md`).
- **Read before acting:** at session start, read the latest status + this playbook + the relevant contract.
  Don't replay chat history or re-litigate a settled call.
- **Agents auto-apply this:** it's in the session-start "read first" set in `CLAUDE.md`, so every agent and
  every new session inherits it without being told.

## Part 5 — Second opinion + guardrails (the review standard)
> Adopted 2026-06-28. A single author (Claude) misses real bugs — Codex caught several here that tests **and**
> a live run did not. The fix is structural, not "try harder." Full protocol lives in
> `~/.claude/CLAUDE.md` → **"Second-opinion review (Codex)"**; this is the project-specific surface.

**Three layers, in order** (the second opinion is the TOP layer, not a replacement for the others):
1. **Guardrails first.** Any **destructive / live-account / irreversible** action **defaults to `--dry` and needs
   an explicit flag to act.** (The 2026-06-28 `delete-scheduled.mjs` bug — a page-global delete with no row
   guard and no dry-run — is exactly the class a dry-run-by-default invariant prevents.) **Branch-per-feature**
   so unfinished work in the tree never ambushes a later session or review.
2. **Tests + actually run it.**
3. **Codex second opinion** on the high-risk tier.

**This project's HIGH-RISK surfaces — ANY of these → mandatory Codex review before commit / go-live:**
- posting to or **deleting** on a live FB / IG page (browser *or* Graph API)
- new paid image / LLM API spend (gpt-image, Haiku, Perplexity)
- Graph API **page tokens / secrets** handling
- **scheduled tasks / Task Scheduler / cron**, and anything **elevated / unattended** (the Gatekeeper,
  task-health, the `*-IG-Daily` / FB-Topup jobs)
- a new external integration

**How it converges:** Codex proposes → Claude verifies each against the code (confirmed / plausible / refuted,
quoting the line) → disputes settled by a **reproducing test** → unresolved items and any **intent / risk**
call escalate to the owner. `/codex:adversarial-review` at plan-time for risky designs; `/codex:review` on the
diff before commit.

## Keep improving
This doc is the project's memory of *how to work*. Whenever a session surfaces a new trap or a better way,
add it here — small and general — so the next session starts smarter than the last.
