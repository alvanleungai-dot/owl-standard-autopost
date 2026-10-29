# Runbook — Facebook posting via the Graph API (brand onboarding)

> **Purpose.** Get a brand's Facebook posting onto the **official Graph API** instead of browser automation.
> This is the **proven, reliable path** (Better Life, 2026-06-22): post by `page_id` (no "active page" problem),
> schedule by exact timestamp (no date-picker), fully reversible. Brand-agnostic — follow it for each new brand.
>
> **Why this exists / why NOT browser.** Driving Meta Business Suite with Playwright defeated us **three times** —
> page-switch (account-level, not scriptable), date-picker (silently reverts to today), and delete (hover-only,
> unlabelled control). See [ADR D-13](../02-decisions.md). Browser is now a **last resort** only where no API/token is possible.

---

## At a glance

| Step | What | Where |
|---|---|---|
| 0 | Owner is **ADMIN** of the page (hard prereq) | facebook.com → Page → Settings → Page access |
| 1 | **One** Meta app for the whole portfolio (Business type) | developers.facebook.com |
| 2 | Add `pages_manage_posts` to the app's use-case permissions | App → Use cases → Permissions |
| 3 | Generate a user token with the page selected + **"Manage posts" toggled ON** | Graph API Explorer |
| 4 | Get the **PAGE** token (NPE: by page id directly) | Graph API Explorer / a script |
| 5 | Make it **long-lived / non-expiring** | `fb_exchange_token` → derive page token |
| 6 | Store the page token in the vault → provision to project `.env` | `~/.claude/secrets/keys.env` |
| 7 | Schedule posts (`POST /{page_id}/photos`, `published=false`) | `scripts/<brand>/api-schedule.mjs` |
| 8 | **Verify** at the source of truth (the API, not "✅ committed") | `scripts/<brand>/fb-verify-scheduled.mjs` |

Reference implementation (Better Life): `scripts/better-life/` — `fb-api-test.mjs`, `fb-make-page-token.mjs`,
`fb-getpage.mjs`, `fb-diag.mjs`, `api-schedule.mjs`, `fb-verify-scheduled.mjs`. Copy + adapt per brand.

---

## Step 0 — Prerequisite: you must be ADMIN of the page 🔴

Graph API content-publishing needs **full admin** on the Page (Editor is **not** enough for `pages_manage_posts`).
Confirm it before anything else — this was the original blocker that pushed us to browser automation (ADR D-01).
For a **New Pages Experience (NPE)** page: Page → **Settings → Page access → People with Facebook access** → the owner must be **"Full control"**.

## Step 1 — One Meta app for the whole portfolio

Create **ONE** app at [developers.facebook.com](https://developers.facebook.com) → **Create app** → type **Business**.
- Use case: **"Manage everything on your Page."**
- This single app serves **every brand** in the portfolio. The **App ID + App Secret are SHARED** across all brands
  (vault slots `FB_APP_ID` / `FB_APP_SECRET`). What differs per brand is only the **page token + page id**.

## Step 2 — Add `pages_manage_posts` (GOTCHA) ⚠️

`pages_manage_posts` is **not granted by default.** In the app: **Use cases → "Manage everything on your Page" → Permissions**
→ find `pages_manage_posts` → **Add** (it gets **Standard Access**).
- **No App Review needed for your OWN page.** Standard Access lets the app act on pages the token-granting user **admins** —
  which is exactly our case. App Review is only for acting on *other people's* pages.
- Also ensure `pages_show_list` and `pages_read_engagement` are present (usually default-on).

## Step 3 — Generate the user token (GOTCHA: the #1 trap) ⚠️

Open the **Graph API Explorer** (developers.facebook.com → Tools → Graph API Explorer):
1. Select your app (top-right).
2. **Add permissions:** `pages_show_list` + `pages_manage_posts`.
3. Click **Generate Access Token** → a Facebook consent popup opens.
4. **🔴 THE #1 TRAP:** in the popup, the **"Manage posts" toggle DEFAULTS TO OFF.** **Turn it ON.**
   If you skip this, the token is generated *without* `pages_manage_posts` and every schedule call later fails — and it
   looks like a code bug when it's actually a missing scope. **Also select the target page** in the page-picker.
5. You now hold a **short-lived USER token** with the right scopes. (Verify with `fb-api-test.mjs` — checks valid + scopes + expiry, never prints the token.)

## Step 4 — Get the PAGE token (GOTCHA: New Pages Experience) ⚠️

A user token can't post as the page — you need the **PAGE access token**.

**Normal path:** `GET /me/accounts?fields=id,name,access_token` → find the brand's page → take its `access_token`.

**🔴 NPE GOTCHA — `/me/accounts` returns EMPTY for New Pages Experience pages.** (Better Life hit exactly this.)
When the list is empty, **query the page id directly**:
```
GET /{page_id}?fields=id,name,access_token
```
This returns the page token even though `/me/accounts` didn't list it. `scripts/better-life/fb-getpage.mjs` does this
(tries the id directly after the long-lived exchange).

**🔴 The API page id ≠ the URL id.** The number in the page's browser URL is **not** the id the Graph API wants.
Find the **API id in the consent popup's page-picker** (Step 3), or via `/me/accounts` when it works.
- **Better Life example:** URL id `61590421662655` · **API id `1077001125507000`.** `api-schedule.mjs` posts to the **API id**.
- If `GET /{page_id}` with the URL id errors, try the API id (and vice-versa) — `fb-getpage.mjs` loops both known ids and keeps whichever returns a token.

## Step 5 — Make the page token long-lived (non-expiring)

A page token derived from a **long-lived USER token inherits non-expiry** (`expires_at: 0` → "NEVER"). Two calls:
1. **Short user token → long-lived user token:**
   ```
   GET /oauth/access_token?grant_type=fb_exchange_token
       &client_id={APP_ID}&client_secret={APP_SECRET}&fb_exchange_token={SHORT_USER_TOKEN}
   ```
2. **Derive the page token** from that long-lived user token (Step 4) — it comes back non-expiring.

Verify with `debug_token` (`?input_token={page_token}&access_token={APP_ID}|{APP_SECRET}`): want
`type: PAGE`, `is_valid: true`, `expires_at: 0` (NEVER), and `pages_manage_posts` in `scopes`.
Reference: `fb-getpage.mjs` / `fb-make-page-token.mjs` do all of this and **save without printing the token**.

## Step 6 — Store the token (vault → project `.env`)

Per the vault protocol — **the token lives ONLY in the gitignored vault and the project `.env`, never committed.**
- Vault slot: `~/.claude/secrets/keys.env` → **`FB_PAGE_TOKEN_<BRAND>`** (e.g. `FB_PAGE_TOKEN_BETTERLIFE`).
- Provision into the project `.env`: `node ~/.claude/scripts/provision-keys.mjs <projectDir> FB_PAGE_TOKEN_<BRAND>`.
- **Shared (one app, all brands):** `FB_APP_ID`, `FB_APP_SECRET`.
- **Per brand:** `FB_PAGE_TOKEN_<BRAND>` + the page's **API id** (hard-coded as a constant in that brand's `api-schedule.mjs`).
- The helper scripts write the token back to vault + `.env` directly and **never echo the value** — keep that property in any new script.

## Step 7 — Schedule posts

`POST /{page_id}/photos` (multipart) with:

| Field | Value |
|---|---|
| `source` | the poster file (the image bytes; multipart `Blob`) |
| `message` | the caption |
| `published` | `false` (so it schedules instead of going live now) |
| `scheduled_publish_time` | **unix seconds** of the post date **@ 10:00 Asia/Hong_Kong** |
| `access_token` | `FB_PAGE_TOKEN_<BRAND>` |

- **HK 10:00 timestamp:** `Math.floor(Date.parse('${date}T10:00:00+08:00') / 1000)`.
- **⚠️ ~30-day window.** FB **rejects** `scheduled_publish_time` more than ~30 days out. Anything further schedules a few days
  later once it falls inside the window. (Better Life: 12/15 scheduled Jun 29–Jul 24; the 3 furthest, Jul 27–31, were pending the window.)
- **Idempotent:** store the returned `post_id` as `fbPostId` on the post; re-runs **skip** anything already carrying one. No double-posting.
- **Reversible:** `DELETE /{fbPostId}` (with the page token) removes a scheduled post — the clean delete the browser path could never do.
- Reference: `scripts/better-life/api-schedule.mjs` (gathers future, non-broken posts; `--dry` previews; `--limit=N` does the next N — always do `--limit=1` first to prove the path before a full batch).

## Step 8 — Verify against the source of truth ✅

**Never trust a "✅ scheduled" log line.** Read it back from the API:
```
GET /{page_id}/scheduled_posts?fields=id,scheduled_publish_time,message
```
Confirm each post is listed at the **correct HK datetime**. Reference: `scripts/better-life/fb-verify-scheduled.mjs`
(prints each scheduled post's real publish time in HK). This is the same "verify against the source of truth" lesson that
came out of the 2026-06-22 silent-failure incident.

---

## Per-brand onboarding checklist

| Brand | Admin? | Page API id | Token slot | Channels | FB status |
|---|---|---|---|---|---|
| Better Life | ✅ | `1077001125507000` | `FB_PAGE_TOKEN_BETTERLIFE` | FB **+ IG** `@betterlifedivorce` | ✅ **ON the API** (1/week Mondays; IG via publish-at-time) |
| TM Health (TML) | ✅ | **`664363790084028`** (脫敏德濕疹專家 — **not 中心**) | `FB_PAGE_TOKEN_TML` | FB **+ IG** `@info.allegies` (`17841476178089475`) | ✅ **ON the API** (hard-wired by id → no wrong-page; clean IG start) |
| Sunmood | ✅ | (derived) | `FB_PAGE_TOKEN_SUNMOOD` | **FB-only** | ✅ **ON the API** (caption-dedup; Jun-23 batch kept) |
| Bright Day | ✅ | `327675207098381` (晨曦) | `FB_PAGE_TOKEN_BRIGHTDAY` | **FB-only** | ✅ **ON the API** (re-activating a dormant page; poster direction WIP) |

> **All four active brands are migrated (2026-06-26).** One user-grant derived the Sunmood / TM Health / Bright Day page tokens in a single pass (`scripts/fb-derive-page-tokens.mjs`). Fill **API id** from the consent page-picker (it differs from the URL id — Step 4); flip **FB status** to ✅ once Step 8 verifies posts at the right dates.

---

## Instagram = phase 2 (note)

IG is **not** part of this runbook — it's a separate, heavier path:
- Needs the **IG Business account linked to the Page** + the **`instagram_content_publish`** permission (**usually requires App Review** — unlike posting to your own page).
- IG publishing takes **public image URLs** (container → publish), not a local file upload like FB `/photos`.
- **IG has no native scheduling** — you run a **publish-at-time job** that fires at the post time (a cron/Windows task that calls publish when the moment arrives).
- Until then, IG-enabled brands (TML, Better Life) keep cross-posting via the **Business Suite one-composer** browser flow (ADR D-12). Migrate FB to the API first; bring IG over in phase 2.
