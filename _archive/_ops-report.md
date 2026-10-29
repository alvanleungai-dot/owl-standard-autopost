# Operations report — Lane 1: immutable job baseline + Golf publish job #13

Date: 2026-07-30. Scope stayed inside `social-content-engine`. No git command, external API call, tenant `weeks|captions|posters` write, feedback-watcher port, or `_ops/projects.json` write was made. All Golf provider tests use injected fake transports.

## T1 — the original 12 jobs are pinned before job #13

- `scripts/lib/worker-jobs.baseline.json:1-86` records the original twelve entries, in order, with exactly the ruled fields: `name`, `entry`, `cron`, `env`, and `publisher`.
- `scripts/lib/worker-jobs.test.mjs:11-31` projects those exact fields, compares the first twelve entries to the baseline, and permits only appended jobs.
- `scripts/lib/worker-jobs.test.mjs:33-40` is the permanent negative test: changing an existing cron in a scratch copy must raise `AssertionError`.

Positive proof, run while `SCHEDULED_JOBS` still contained only the original twelve:

```text
node --test scripts/lib/worker-jobs.test.mjs
```

Result at that gate: 8 passed, 0 failed.

Independent scratch-copy mutation command:

```text
node --input-type=module -e "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {SCHEDULED_JOBS} from './scripts/lib/worker-jobs.mjs'; const baseline=JSON.parse(readFileSync('./scripts/lib/worker-jobs.baseline.json','utf8')); const scratch=SCHEDULED_JOBS.map(({name,entry,cron,env,publisher})=>({name,entry,cron,env,publisher})); scratch[0].cron='1 8 * * *'; assert.deepEqual(scratch.slice(0,baseline.length),baseline,'the 12 pre-existing jobs must not change — append new jobs, never edit these');"
```

Negative result: exit `1`, with this identifying diff:

```text
AssertionError [ERR_ASSERTION]: the 12 pre-existing jobs must not change — append new jobs, never edit these
+ actual - expected
  {
+   cron: '1 8 * * *',
-   cron: '0 8 * * *',
    entry: 'scripts/preflight.mjs',
    env: 'JOB_SCE_PREFLIGHT_ENABLED',
    name: 'SCE-Preflight',
    publisher: false
  }
```

## T2 — Golf publisher ported and registered as job #13

- `scripts/golf/publish.mjs:26-56` reads all six Golf values through the existing process-env-first `lib/env.mjs`: `NOTION_TOKEN`, `FB_PAGE_TOKEN_GOLFTRAVEL`, `GOLF_FACEBOOK_PAGE_ID`, `GOLF_INSTAGRAM_USER_ID`, `GOLF_INSTAGRAM_USERNAME`, and `GOLF_NOTION_BOARD_ID`. Any missing value fails before transport use.
- `scripts/golf/publish.mjs:59-64` resolves `golf/publish-log.json` and `golf/publish.lock` under `STATE_DIR` through `runtimePath`, and creates only their state parent.
- `scripts/golf/publish.mjs:97-151` preserves the token-checked exclusive lock and refuses a live second owner.
- `scripts/golf/publish.mjs:207-219` refuses every live run when a prior FB/IG outcome is inflight or an IG container has an unknown publish outcome.
- `scripts/golf/publish.mjs:253-270` preserves the wrong-account guard: the Page's linked `instagram_business_account.id` must equal `GOLF_INSTAGRAM_USER_ID`.
- `scripts/golf/publish.mjs:348-359` re-reads each row immediately before posting and requires it still be `Approved` with unchanged caption, image URL, and channel routing.
- `scripts/golf/publish.mjs:362-390` writes FB and IG inflight/done state atomically before proceeding; IG-only rows are also installed in the ledger before their first state write.
- `scripts/golf/publish.mjs:392-426` moves Notion to `Published` only after every requested platform is done. A transport or Notion status-flip failure exits nonzero so the shared supervisor alarm is truthful.
- `scripts/golf/publish.mjs:449-454` is a real Node `.mjs` entrypoint and supports import-only cloud validation without executing.
- `scripts/lib/worker-jobs.mjs:105-113` appends `Golf-Publish` as job #13, `publisher: true`, exact-true flag `JOB_GOLF_PUBLISH_ENABLED`, five-minute cap, and scheduled `--live --max 1`.
- `scripts/lib/worker-jobs.mjs:108` keeps a ten-minute cadence at minutes `7,17,27,37,47,57`, avoiding the named `0 18 * * 4` and `5 10 * * *` collision groups.
- `scripts/render-worker.mjs:32-39` still uses `process.execPath`, no shell, same environment, and the same scheduled supervisor; it now forwards an optional registered argv list.

Wiring and negative tests:

- `scripts/lib/worker-jobs.test.mjs:42-73` proves append position #13, publisher classification, exact-true/default-disabled behavior, runtime cap, live/max argv, and collision-free ten-minute cadence.
- `scripts/lib/golf-worker-wiring.test.mjs:41-67` proves cron uses the shared supervisor; the per-job flag, publisher brake, and disabled `RUN_JOB_ONCE` each refuse before spawn.
- `scripts/lib/golf-publish.test.mjs:133-464` uses only fake transports and negative-tests missing config, durable paths, dry-run, inflight refusal, wrong account, both lock-refusal forms, stale approval, changed content, changed channels, write-ahead order, Notion primary dedup/status flip, `--max 1`, ambiguous FB/IG outcomes, and Notion-update failure.
- `scripts/lib/scheduled-job-wiring.test.mjs:15-34` pins the shared registry → runtime → supervisor path and argv forwarding.

Focused proof:

```text
node --test scripts/lib/golf-publish.test.mjs scripts/lib/golf-worker-wiring.test.mjs scripts/lib/worker-jobs.test.mjs scripts/lib/scheduled-job-wiring.test.mjs
node scripts/selftest-cloud-import.mjs
node scripts/selftest-cloud-import.mjs --negative-direct-env
```

Results: 31 focused tests passed; all 13 job entrypoints imported from a clean cloud-shaped checkout; the deliberate direct-`.env` reader failed with `ENOENT` and exit `1`.

## What can make Golf publish

The worker can start a real Golf publish only when all of these are true:

1. `JOB_GOLF_PUBLISH_ENABLED=true` exactly.
2. Cloud publishing control returns enabled (`PUBLISHING_ENABLED=1`, readable durable emergency-stop directory, and no `STATE_DIR/secrets/POSTING_FROZEN`).
3. Its cron minute matches, or `RUN_JOB_ONCE=Golf-Publish` is requested; `RUN_JOB_ONCE` cannot override item 1 or 2.
4. All six Golf process-env values are present.
5. At least one Notion row is returned by the `Status = Approved` query with FB and/or IG selected and an image URL.
6. The configured Page exposes the configured linked IG id.
7. No unknown/inflight ledger record exists and the exclusive lock is acquired.
8. The row is still Approved with identical caption, image, and channels on the immediate re-read.

Intentional/manual surfaces to know:

- The registry supplies `--live --max 1`; without `--live`, the port remains dry-run by default.
- A human who directly runs `node scripts/golf/publish.mjs --live` bypasses the parent worker's per-job/global/freeze checks, just as direct execution of the existing publisher entrypoints does. It still retains the port's lock, inflight, re-read, wrong-account, ledger, and Notion gates. Treat direct `--live` as privileged operator action.
- `--ig-container-test` can create an unpublished IG container during an explicit direct dry invocation; it does not publish it.
- A human can deliberately reconcile/edit the durable ledger or wait for a dead/stale lock to be reclaimed. Clearing the wrong record can reopen publishing, so ledger reconciliation remains a live-account operation.
- `GOLF_INSTAGRAM_USERNAME` is display-only; the numeric linked IG id is the authoritative wrong-account guard.
- The job remains disabled by default. Merely deploying these files cannot publish Golf.

## Counts and additional checks

`node --test scripts/lib/` passed. That directory form launches a directory wrapper and ends with wrapper count `1`, so it is not the real test count.

Real count command:

```powershell
$testFiles = Get-ChildItem -LiteralPath 'scripts/lib' -Filter '*.test.mjs' -File | Sort-Object Name | ForEach-Object FullName
node --test --test-reporter=tap $testFiles
```

Result: **228 tests passed across 42 test files; 0 failed** (`1..228`, `# pass 228`). This is the prior 205-test contract suite plus 23 new/expanded gate tests. The only test file outside `scripts/lib`, `scripts/migrate-state.test.mjs`, also passed 3/3, so all repository `.test.mjs` files total **231 passed, 0 failed**.

`graphify update .` completed after the final code change (AST-only; no external API).

## Verbatim `node --test scripts/lib/` output

```text
✔ alertKey is stable per source+kind (0.6961ms)
✔ first occurrence of a crucial alert sends (0.1633ms)
✔ same alert within cooldown is suppressed (0.1022ms)
✔ alert sends again after the cooldown elapses (0.7288ms)
✔ noise severity never sends (0.1501ms)
✔ info cooldown is a full day (0.1078ms)
✔ clearKey resets so the next occurrence sends immediately (0.1325ms)
✔ prune drops stale entries (0.1877ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7.455
✔ failed owner delivery returns false, logs loudly, and remains retryable (1.1859ms)
✔ a thrown alert transport never crashes the caller and is reported as failed (0.921ms)
✔ a fake Telegram 401 is a failed escalation, never SENT (0.2843ms)
✔ only confirmed delivery returns true and enters cooldown (0.1985ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7.1783
✔ an existing dated artifact is a no-op failure unless forced (19.4777ms)
✔ WROTE handoff is absolute and exactly one line (2.9283ms)
✔ every uncaught artifact guard reports the dedicated idempotent no-op process outcome (224.2525ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 265.2317
✔ the divorce family is exactly the three sister brands (not tml) (2.097ms)
✔ each divorce brand has a DISTINCT seed offset (different lens cells = the spin) (1.3003ms)
✔ familySeed shifts with WEEK_OFFSET but keeps brands offset from each other (1.2583ms)
✔ familyUsedTopics(divorce brand) = UNION across all three brands, deduped (18.2556ms)
✔ non-family brand (tml) excludes ONLY its own topics — unchanged behaviour (2.8371ms)
✔ brandUsedTopics tolerates a missing/unknown brand (empty, no throw) (0.6409ms)
✔ brandUsedTopics reads BOTH ledger shapes (array-of-objects AND {topics:[…]}) (1.9528ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 42.028
✔ process environment is the primary cloud secret source (1.1479ms)
✔ local .env remains a fallback and missing values stay empty (0.6421ms)
✔ missing .env is never fatal (0.9612ms)
✔ parser handles quoted values and ignores non-assignments (1.1948ms)
✔ enable flags fail closed unless explicitly true (0.9631ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16.145
✔ Facebook preflight derives token ownership from the worker brand roster (1.6499ms)
✔ Facebook preflight still fails when an owned brand token is missing (0.6042ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8.4495
✔ top-up attempts every brand, alarms, and returns non-zero when children fail (1.4887ms)
✔ top-up success raises no alarm and clears the prior failure key (0.2317ms)
✔ top-up entry point propagates aggregate failure to process.exitCode (0.8655ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10.9571
✔ feed dedup rejects an empty or too-small scan (0.987ms)
✔ feed dedup rejects an empty marker instead of treating it as absent (0.1794ms)
✔ feed dedup accepts substantive text and non-empty markers (0.1305ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7.4571
✔ gatekeeper auto-fix is unreachable without the explicit --autofix request (1.8675ms)
✔ gatekeeper refuses the whole auto-fix request unless authorisation is confirmed (1.9116ms)
✔ only explicit request plus exact authorisation creates the required capability (0.6031ms)
✔ gatekeeper agent verification defaults off and requires exact true (0.5786ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 17.662
✔ benign / disabled tasks produce no finding (0.9373ms)
✔ obsolete browser task → recommend Disable-ScheduledTask (0.4628ms)
✔ monitor exit-2 is the 'found+escalated' signal → benign, not a failure (0.1776ms)
✔ a monitor crashing with a non-signal code → who-watches-the-watcher finding (0.1563ms)
✔ day-1 task finding is amber, day-3+ is red (0.1749ms)
✔ coverage: empty Monday (no scheduled, no backlog) → red gap (0.3184ms)
✔ coverage: backlog-only Monday → amber (auto top-up) (0.1322ms)
✔ coverage: scheduled Mondays → no finding (0.0806ms)
✔ buildDigest: worst severity wins; healthy when empty (0.1805ms)
✔ updatePersistence: bumps day on a new calendar day, holds same day, resets on clear (0.2484ms)
✔ nextMondays returns the upcoming Mondays from a Friday (0.8924ms)
✔ furthestScheduled finds the latest fbPostId-bearing date (0.1807ms)
✔ triage findings carry a `kind` discriminator the classifier reads (0.1616ms)
✔ classifyRemediation: AUTO-SAFE only for the 2 whitelisted cases (0.1297ms)
✔ classifyRemediation: a PERSISTED task failure is no longer transient → agent-verify, not another blind re-run (1.5982ms)
✔ classifyRemediation: monitor-crash and zeroweek → agent-verify (read-only diagnosis) (0.1347ms)
✔ classifyRemediation: everything destructive / money-spending / obsolete → ESCALATE (0.0844ms)
✔ planAutoSafeFix: builds ONLY the 2 whitelisted plan shapes; null for everything else (0.305ms)
✔ planAutoSafeFix: POSTING_FROZEN blocks the fb-topup fix (never schedule while frozen) (0.2136ms)
✔ stampRemediation: annotates each finding with class + plan; frozen downgrades fb-topup to escalate (0.2934ms)
✔ stampRemediation: never invents a plan for an escalate/agent-verify finding (0.0776ms)
✔ classifyRemediation: ANY crashed monitor → agent-verify (Gatekeeper never re-registers; task-health does) (0.0569ms)
✔ planAutoSafeFix: a monitor-crash NEVER builds a plan (no elevated re-register in the Gatekeeper) (0.0366ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 18.8029
✔ cloud gatekeeper has no generation-log signal that can report a false green (1.2348ms)
✔ every Gatekeeper auto-fix execution consumes the explicit authorization capability (0.1978ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6.6247
✔ all four weekly generator pairs share queue selection, full-queue no-op, and failure escalation (2.2371ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7.0902
✔ automatic generation skips occupied future weeks without producing an alarm outcome (17.4445ms)
✔ a full bounded queue is a successful no-op with a clear through-date line (0.6128ms)
✔ an explicit colliding --week target still reaches the overwrite guard and refuses (3.4041ms)
✔ an explicitly set WEEK_OFFSET wins over automatic gap selection (0.9066ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28.6888
✔ Golf config is process-env-first and all six values are required (2.6939ms)
✔ Golf ledger and lock resolve beneath STATE_DIR (3.0167ms)
✔ dry-run is the default and cannot call either publish endpoint or patch Notion (5.8655ms)
✔ a live run refuses an inflight ledger before any transport call (4.6066ms)
✔ wrong-account guard refuses a mismatched linked Instagram account before posting (3.206ms)
✔ exclusive lock rejects a second live owner and preserves the first owner's lock (7.3723ms)
✔ a held lock stops a live run before any platform publish (6.253ms)
✔ live publish skips a row that is no longer Approved on re-read (9.438ms)
✔ live publish skips content changed after the Approved scan (9.6391ms)
✔ live publish skips channel routing changed after the Approved scan (10.7006ms)
✔ live publish writes ahead for FB and IG, then flips Notion to Published (16.1177ms)
✔ scheduled --max 1 cannot dump a second Approved row in the same run (7.9693ms)
✔ a Facebook transport failure exits nonzero and leaves the write-ahead inflight refusal (8.7421ms)
✔ an Instagram-only unknown outcome is persisted as inflight and exits nonzero (8.354ms)
✔ a failed Notion status flip exits nonzero while retaining completed platform ids (20.9912ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 135.3519
✔ Golf cron dispatches through the shared scheduled-job supervisor (2.5053ms)
✔ Golf's per-job flag blocks cron dispatch before the supervisor (0.1843ms)
✔ Golf's publisher brake blocks RUN_JOB_ONCE before the supervisor (0.2885ms)
✔ RUN_JOB_ONCE cannot override Golf's disabled per-job flag (0.1197ms)
✔ Golf's enable flag remains exact-true opt-in (0.5084ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10.577
✔ publish and enabled-job HTTP sites cannot regress to raw fetch (6.2024ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13.5781
✔ a transport that never settles rejects within its deadline (28.9955ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35.9937
✔ looksCorrectlyQuoted: true for the outer-quoted cmd form, false for the broken collapse (1.43ms)
✔ verifyReregister: ok only when present, enabled, AND correctly quoted (0.2152ms)
✔ registry contains ONLY monitor/infra tasks, never a posting/generation/browser task (1.5518ms)
✔ the Gatekeeper (tonight's failure) is auto-repairable, pointing at its committed script (0.4473ms)
✔ task-health is auto-repairable too (so the two monitors can heal each other) (0.2844ms)
✔ a non-infra task is NOT auto-repairable → planInfraRepair returns null (0.2517ms)
✔ shouldAttemptRepair allows the first repair of the day, then blocks once the cap is hit (0.4001ms)
✔ the retry counter resets on a new day (0.2336ms)
✔ recordRepairAttempt counts within a day and is independent per task (0.3846ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 18.225
✔ an exited long-lived child is restarted with backoff and the restart is logged (1.6795ms)
✔ a crash loop stops at the restart cap and escalates through the alert path (1.2751ms)
✔ a failed crash-loop delivery is a named loud worker failure (0.362ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11.2341
✔ remote dedup fails closed on a Meta error envelope (1.2675ms)
✔ remote dedup fails closed when a data array is absent (0.3737ms)
✔ remote dedup fails closed when the Meta transport hangs (32.6219ms)
✔ remote inventory yields caption and HK-date collision facts (3.1146ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 40.8274
✔ local default preserves the current in-repo layout (1.0508ms)
✔ cloud mode without STATE_DIR fails closed and names STATE_DIR (0.5362ms)
✔ an explicit STATE_DIR owns runtime paths (1.8734ms)
✔ cloud mode rejects a STATE_DIR that is not writable as a directory (2.1741ms)
✔ runtime paths cannot escape STATE_DIR (1.6501ms)
✔ cloud durability rejects temp paths and a missing sentinel (0.5041ms)
✔ a valid sentinel accepts a non-temp non-checkout state root (0.1697ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14.0949
✔ daily non-publisher preflight reaps the publish ledger before provider probes (1.4644ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8.7165
✔ claim blocks a second claimant and starts uncertain (20.45ms)
✔ confirmed failures release but ambiguous failures stay uncertain (26.3912ms)
✔ confirmed claim remains blocked (19.2724ms)
✔ two slugs may share a planned date but moving one slug does not create a new identity (27.3508ms)
✔ two concurrent processes produce exactly one atomic winner (273.839ms)
✔ killing a process after claim leaves an uncertain slot that refuses the next run (200.5102ms)
✔ stale uncertain records trigger an owner alert and remain blocked (11.3421ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 588.6486
✔ cloud publishing fails closed without a positive durable environment signal (2.0648ms)
✔ cloud publishing requires exactly PUBLISHING_ENABLED=1 (0.2272ms)
✔ POSTING_FROZEN overrides a positive cloud signal (1.0156ms)
✔ an unreadable freeze control fails closed (0.2558ms)
✔ cloud emergency stop resolves on durable state, not the deploy checkout (0.2978ms)
✔ missing STATE_DIR or emergency-stop directory fails cloud publishing closed (0.3548ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11.6037
✔ publisher gate rejects a live writer missing every shared guard (1.348ms)
✔ shared fb-post core itself carries freeze, approval, and ledger boundaries (0.7694ms)
✔ publisher gate rejects repo-relative mutable state reads (0.2248ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9.5639
✔ a hung sweep reaches its deadline and cannot prevent the next getUpdates (44.815ms)
✔ more than six minutes without an HTTP-ok poll exits one with a named fatal line (1.4205ms)
✔ only an ok getUpdates result refreshes liveness (0.5104ms)
✔ sweeps receive no liveness credit until getUpdates is HTTP-ok (0.3822ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 52.0054
✔ all four review bots use the shared deadline, sweep, and watchdog runtime (1.5296ms)
✔ all four bot transports share the bounded Telegram request helper (1.8941ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7.8413
✔ callback round-trips (1.6378ms)
✔ poster keyboard has three decide buttons (0.1976ms)
✔ bulk keyboard offers approve-all (0.1152ms)
✔ redo prompt embeds a recoverable slug (0.1929ms)
✔ auto-approve deadline is +48h (0.1339ms)
✔ stampReview sets a fresh, undecided review (0.3365ms)
✔ decidePost flips status, stamps who decided, returns a label (0.2188ms)
✔ decidedCaption reflects the resolved state (0.2042ms)
✔ remainingLabel buckets days/hours/minutes (0.2098ms)
✔ digestDue gates on the 10:00-HK boundary (0.217ms)
✔ planSweep auto-approves past-deadline undecided posts only (0.3735ms)
✔ expired wall clock without proven bot liveness never auto-approves (0.1787ms)
✔ only accumulated intervals bounded by successful polls can complete the 48h window (0.1117ms)
✔ planSweep raises a last-call once inside the 3h window (0.1401ms)
✔ planSweep builds a digest listing only undecided posts (0.21ms)
✔ SLUG_RE matches both date and ISO-week slugs (0.1186ms)
✔ postLabel falls back across brand fields (0.0527ms)
✔ posterKeyboard can omit the regen button (TML) (0.142ms)
✔ isBroken flags failed or errored posts (0.0795ms)
✔ planSweep never auto-approves broken posts; surfaces them instead (0.2997ms)
✔ planSweep digest excludes broken posts (they need regen, not a decision) (0.1327ms)
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13.046
✔ every weekly autopilot is a registered, non-publishing scheduled job (0.7217ms)
✔ every weekly autopilot routes review photos through the delivery gate (1.9252ms)
✔ no weekly autopilot starts the review clock itself (0.8518ms)
✔ the delivery gate stamps only on success and alarms on failure (0.4019ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10.8349
✔ failed photo delivery leaves the post unstamped and raises an alarm naming the slug (2.1917ms)
✔ only confirmed deliveries are stamped and failures do not stop later attempts (0.2438ms)
✔ all four weekly runners use the shared delivery-confirmed review gate (0.7814ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8.4077
✔ date guard recognizes the intended date in common input formats (0.8491ms)
✔ cross-post date guard fails when either channel kept the wrong date (0.1635ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6.3689
✔ a hung scheduled child is terminated, force-killed, and alarmed by name (1.6417ms)
✔ failed overrun alarm is itself a distinct loud worker failure (0.8348ms)
✔ a normal exit clears its deadline, frees the job slot, and raises no alarm (0.2506ms)
✔ a non-zero scheduled child exit raises an alarm with job name and exit code (0.2883ms)
✔ the dedicated idempotent no-op exit is resolved and never alarmed (0.3055ms)
✔ shutdown exits do not raise scheduled-job failure alarms (0.2179ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8.5351
✔ Render worker gives cron and RUN_JOB_ONCE the same max-runtime supervisor (0.8471ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6.8905
✔ a fresh sibling lease makes startup fail (10.2218ms)
✔ a hard kill still recovers by replacing a stale sibling lease (19.7352ms)
✔ clean shutdown releases only the lease owned by this process (12.3491ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 55.2582
✔ seed verifier accepts parseable manifests and per-brand ledgers (18.6548ms)
✔ initializer creates, migrates, verifies, and is repeat-safe (95.2786ms)
✔ seed verifier fails closed on an empty disk (13.6563ms)
✔ seed verifier fails closed on malformed runtime JSON (16.9609ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 189.2101
✔ toHex formats as unsigned hex (2.5651ms)
✔ benign set covers success / running / never-run only (0.5514ms)
✔ unhealthyTasks flags only watched, enabled, non-benign tasks (2.3459ms)
✔ unhealthyTasks tolerates empty / unwatched inputs (0.3522ms)
✔ BrightDay tasks are watched (regression: WATCH + the scheduler query both derive from one brand list) (0.7192ms)
✔ exit 2 is benign for MONITOR tasks (by-design 'found+escalated'), not for others (0.8731ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28.1973
✔ a Telegram call rejects when its fake fetch transport never resolves (32.4575ms)
✔ Telegram transport forwards a live abort signal to fetch (13.3445ms)
✔ an HTTP-ok Telegram API error still throws for the bot loop to log (3.2248ms)
✔ a fake Telegram HTTP 401 is rejected before any success is reported (10.5555ms)
✔ an empty sendMessage is refused before the fake Telegram transport is reached (1.1651ms)
✔ a Telegram HTTP error includes the API description from the response body (1.5726ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 78.0624
✔ isApproved gates on status (1.8272ms)
✔ hkTodayStr is the HK calendar day (0.3763ms)
✔ weekdayDate maps a Better Life day to this week's date (0.3642ms)
✔ postDate prefers explicit date, else weekday (1.4316ms)
✔ isOverdue is true only for days strictly before today (0.4643ms)
✔ reconcile splits live vs missing by marker (1.5651ms)
✔ classifyFailure buckets login / billing / transient / unknown (0.9075ms)
✔ escalationMsg returns brand-labelled guidance (0.5149ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 20.7109
✔ the epoch Monday returns 0 (0.8399ms)
✔ consecutive Mondays differ by exactly 1 (0.2679ms)
✔ every day of the same week maps to the same index (0.1454ms)
✔ weekIndex(monday) % 4 cycles 0,1,2,3,0 across 5 consecutive weeks (0.6812ms)
✔ dates before the epoch clamp to a non-negative 0 (1.0625ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10.7754
✔ a failed brand-channel error report escalates instead of vanishing (0.7787ms)
✔ a delivered brand-channel error report does not create a second alarm (0.363ms)
✔ an idempotent child outcome is propagated without any failure report or alarm (0.6399ms)
✔ a real weekly fault still returns non-zero and alarms when its error report fails (0.4929ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11.7171
✔ unknown RUN_JOB_ONCE fails loudly and prevents scheduler startup (2.5679ms)
✔ disabled publisher trigger reaches cloud_not_enabled brake and never starts a child (0.8268ms)
✔ disabled publisher trigger reaches frozen brake with positive cloud signal and never publishes (0.5222ms)
✔ clear brakes cannot let RUN_JOB_ONCE override a disabled publisher flag (0.4699ms)
✔ trigger is consumed once and does nothing while unset (1.9153ms)
✔ cron and RUN_JOB_ONCE both enter the same supervisor with the registered runtime cap (0.656ms)
✔ enabled publisher completion reports its supervised exit code and published verdict (0.8135ms)
✔ RUN_JOB_ONCE reports an idempotent exit as no_op instead of failed (0.5597ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22.5073
✔ the twelve pre-existing scheduled jobs are immutable and new jobs may only be appended (1.4008ms)
✔ the immutable baseline rejects a changed cron in an existing entry (4.1295ms)
✔ Golf publish is appended as job thirteen, is a publisher, and defaults disabled (0.7036ms)
✔ Golf keeps a ten-minute cadence without joining the named cron collisions (0.551ms)
✔ every scheduled job has a finite maximum runtime and publishers have tighter ceilings (0.1838ms)
✔ gatekeeper is alarm-capable, advisory by default, and scheduled ahead of publishers (0.2437ms)
✔ every scheduled job defaults disabled and malformed values stay disabled (1.0207ms)
✔ publisher jobs are a second gate behind PUBLISHING_ENABLED (0.165ms)
✔ four review bots use distinct per-brand token variables and default off (0.2933ms)
✔ cron matcher preserves Hong Kong trigger minutes (15.9752ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 31.6173
✔ scripts/lib test suite (7069.2703ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7169.7687
```
