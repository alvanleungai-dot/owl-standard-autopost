Do not commit this eight-file batch as-is. Two files are safe, four need guardrail fixes, and two require security redesign before they should exist as trusted automation.

No scripts were executed. No files under `secrets/` or any `.env` contents were read. All seven executable files pass `node --check`.

| File | Verdict | One-line reason |
|---|---|---|
| [scripts/copilot/README.md](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/README.md:1) | COMMIT-WITH-FIXES | Documents unsafe live-write commands and overstates their identity/idempotency guarantees. |
| [scripts/copilot/add-views.mjs](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/add-views.mjs:1) | COMMIT-WITH-FIXES | Mutates a live Notion database by default and can create duplicate views. |
| [scripts/copilot/fb-dress-page.mjs](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/fb-dress-page.mjs:1) | COMMIT-WITH-FIXES | Defaults safely to probe, but action modes overwrite live page media without strong identity, idempotency, or success checks. |
| [scripts/copilot/notion-connect.mjs](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:1) | DO-NOT-COMMIT | Creates pages and grants integration access by default; an arbitrary existing page can expose its entire child-page subtree. |
| [scripts/copilot/warm-facebook.mjs](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/warm-facebook.mjs:1) | SAFE-TO-COMMIT | Only opens an interactive login and stores the session in the approved secrets directory; no automatic live mutation or credential output. |
| [scripts/copilot/warm-notion.mjs](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/warm-notion.mjs:1) | SAFE-TO-COMMIT | Only opens an interactive login and persists the session in the approved secrets directory. |
| [scripts/notion/init-db.mjs](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/init-db.mjs:1) | COMMIT-WITH-FIXES | Immediately creates a database and rows, chooses the first searchable page, and is explicitly non-idempotent. |
| [scripts/notion/seed-topics.mjs](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/seed-topics.mjs:1) | DO-NOT-COMMIT | Bulk-archives live rows by default, ignores mutation failures, and can leave the board empty, duplicated, or partially reset. |

## Required fixes

### `scripts/copilot/README.md` — COMMIT-WITH-FIXES

The documented Notion commands run live mutations with no warning or action flag ([lines 18–28](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/README.md:18)). The Facebook examples likewise present media replacement as a normal invocation ([lines 34–40](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/README.md:34)).

Exact fixes:

- Replace examples with dry-run-default commands and explicit `--apply` examples.
- Remove the claim that `existingPageUrl` is idempotent: it avoids creating another page, but the code does not detect an existing connection.
- Do not claim strong Facebook identity verification until the script verifies the exact page after switching identities.
- Clearly label page creation, connection grants, view creation, and cover/profile replacement as live mutations.

### `scripts/copilot/add-views.mjs` — COMMIT-WITH-FIXES

It accepts no action flag and immediately opens the configured board and creates two views ([lines 41–56](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/add-views.mjs:41)). It does not verify the database identity or inspect existing views. Running twice can attempt to create another Board and Calendar view.

The confirmation click silently ignores failure ([lines 35–38](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/add-views.mjs:35)), yet the script later reports success ([line 59](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/add-views.mjs:59)).

Exact fixes:

- Default to a read-only plan that reports the target and which views are missing; require `--apply` for clicks.
- Verify the expected database ID and title before any mutation.
- Enumerate existing views and skip matching Board/Calendar views; a second run must be a no-op.
- Remove the swallowed confirmation error and verify each new view appears before reporting success.
- Exit nonzero on any incomplete or ambiguous result.

Worst realistic accidental outcome: duplicate or unwanted views on the wrong authenticated database.

### `scripts/copilot/fb-dress-page.mjs` — COMMIT-WITH-FIXES

The default `probe` mode is non-mutating ([line 10](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/fb-dress-page.mjs:10)), which is good. The hardcoded numeric page ID ([line 11](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/fb-dress-page.mjs:11)) is not a token or credential.

Remaining gaps:

- Identity is only a substring search across the entire page body ([lines 30–34](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/fb-dress-page.mjs:30)); unrelated UI text could satisfy it.
- The page-switch click silently ignores failure ([lines 49–52](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/fb-dress-page.mjs:49)).
- Cover and profile saves overwrite live media ([lines 70–76](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/fb-dress-page.mjs:70), [99–106](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/fb-dress-page.mjs:99)) with no check that the same asset is already installed.
- Post-save verification is swallowed and the message only says upload “attempted.”
- Probe mode prints arbitrary authenticated top-region button labels/text to stdout ([lines 40–44](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/fb-dress-page.mjs:40)), potentially exposing account/UI metadata.

Exact fixes:

- Require both an action selection and `--apply`; reject unknown modes.
- Verify exact page ID and expected page name before and after switching into the Page.
- Fail if switching cannot be verified.
- Compare the intended asset with recorded/current state and no-op when already applied; require `--force` to replace a different current asset.
- Verify the saved media before recording success.
- Allowlist/redact probe output rather than dumping arbitrary authenticated DOM text.

Worst realistic outcome: overwriting the wrong page’s cover/profile, potentially generating public page activity on repeated runs.

### `scripts/copilot/notion-connect.mjs` — DO-NOT-COMMIT

With no arguments, it creates a live page and attaches an integration ([lines 16–18](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:16), [64–79](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:64), [95–102](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:95)). Re-running it creates another page.

The `existingPageUrl` mode accepts an arbitrary URL without verifying workspace, page ID, title, or ownership ([lines 56–63](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:56)). Most critically, the confirmation explicitly grants access to the page “and all its child pages” ([line 100](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:100)), contradicting the claim that access is limited to “ONLY this page.”

The integration match is substring-based and selects the first result ([line 97](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:97)). Page URLs/IDs are also printed to stdout ([lines 59–63](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:59), [80–106](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/copilot/notion-connect.mjs:80)).

Required redesign:

- Default to a read-only probe; require `--apply`.
- Require an explicit choice between `--new-page` and `--existing-page`; never create a page implicitly.
- Verify the expected workspace, exact page ID/title, and exact unique integration name.
- Present and require explicit acknowledgement of effective child-page access for an existing page.
- Detect an existing connection and no-op instead of reconnecting/failing.
- Verify the connection after mutation.
- Redact page URLs/IDs from normal logs.

Worst realistic outcome: granting the automation token read/write access to the wrong page and its entire descendant tree.

### `scripts/notion/init-db.mjs` — COMMIT-WITH-FIXES

It reads the token from repository-root `.env` ([lines 9–17](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/init-db.mjs:9)); no token is logged, but this conflicts with the project’s `secrets/<company>/.env` convention.

Without an explicit parent, it takes the first page returned by workspace search ([lines 19–27](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/init-db.mjs:19)). It then immediately creates a database and three rows ([lines 30–83](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/init-db.mjs:30)). Re-running duplicates both. Topic failures are logged and ignored, so a partial seed exits successfully ([line 83](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/init-db.mjs:83)).

Exact fixes:

- Use the tenant secrets file and retain the existing missing-token fail-closed behavior.
- Default to a plan and require `--apply`.
- Require an explicit parent page ID, then verify its workspace/title; never select search result zero.
- Detect and reuse the expected database by stable ID/marker.
- Upsert seed topics using stable IDs rather than blindly creating them.
- Check every HTTP response, exit nonzero on partial failure, and make reruns safely resume.
- Avoid printing complete page/database IDs and URLs in normal output.

Worst realistic outcome: duplicate boards and topics under an unintended accessible page, with a partially initialized board reported as successful.

### `scripts/notion/seed-topics.mjs` — DO-NOT-COMMIT

This is a destructive reset. It archives every row returned by the first query page with no dry-run or confirmation ([lines 26–32](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/seed-topics.mjs:26)). It does not:

- Check that `NOTION_TOKEN` exists ([lines 7–15](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/seed-topics.mjs:7)).
- Verify the configured database belongs to the expected tenant.
- Check the query response status.
- Paginate results.
- Check any archive `PATCH` result ([line 30](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/seed-topics.mjs:30)).
- Stop or exit nonzero when row creation fails ([lines 35–44](C:/Users/jimmi/Downloads/Jimmi-agent/social-content-engine/scripts/notion/seed-topics.mjs:35)).

Exact redesign required:

- Default to a complete diff/plan; require `--apply` plus confirmed database identity.
- Verify token, database ID, title, parent page, and tenant before mutation.
- Paginate all rows.
- Manage only rows owned by this tool using a stable marker/property; do not archive every database row.
- Make the operation an idempotent reconciliation/upsert.
- Check every query, archive, and create response; stop nonzero and report exact partial state.
- Ensure a rerun safely resumes after any mid-operation failure.

Worst realistic outcome: up to the first query page of live review rows disappears from the active board, followed by failed or partial insertion—leaving an empty, mixed, or duplicated workflow.