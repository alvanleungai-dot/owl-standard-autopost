# Hands-Free Weekly Facebook Posting Engine — Better Life

## 0. Mental model
Once a week a Windows Scheduled Task runs one Node script: it asks Claude Haiku for 5 brand-new HK-divorce topics NOT in a persistent ledger, writes a Better-Life-voice caption for each, derives a poster concept for each, generates 5 posters with gen-poster-v4 (medium, alternating Infographic↔Cartoon), and records the week as a batch file. Then Mon–Fri a second task runs the already-working publish-fb.mjs for that day's post. publish-fb is idempotent + self-verifying, so a missed/sleeping day heals itself next run. The owner does nothing EXCEPT the one unavoidable touch: when FB's login cookie expires (every few weeks), publish-fb throws "Not logged in"; an alert wrapper sends a Telegram message; the owner runs warm-chrome.mjs once (~30s); hands-free again. That re-login cannot be eliminated (no Graph API admin → browser-session posting → cookies live on this PC and expire).

## 1. Reuse vs new
Reused as-is: gen-poster-v4.mjs (poster renderer), warm-chrome.mjs (re-login), publish-fb.mjs (posting logic — extract its scan/post/verify into a shared lib/fb-post.mjs so the weekly publisher reuses it without rewriting).
New scripts: lib/fb-post.mjs (shared posting/scan/verify), lib/anthropic.mjs (Haiku helper), lib/ledger.mjs (dedup ledger), lib/notify.mjs (Telegram alert), gen-topics.mjs (propose fresh non-dup topics), write-caption.mjs (voice caption + 法律 ban + footer enforcement), derive-concept.mjs (topic→concept file), gen-week.mjs (orchestrator: topics→captions→concepts→posters→week batch), post-today.mjs (daily driver: post today's item via fb-post, update state, alert on failure), windows/register-tasks.ps1 + run-gen-week.cmd + run-post-today.cmd.
New data: companies/better-life/topics-ledger.json (dedup ledger), companies/better-life/weeks/<weekId>.json (per-week batch state).

## 2. Topic bank + dedup
topics-ledger.json append-only; SEED it once with the 25 launch topics (from gen-batch.mjs's POSTS array) so they never recur. gen-topics.mjs calls Haiku with company.md topic axes + voice.md + the full used-titles list, asks for 7 new topics (keep 5), then dedups two ways: (1) hard normalized-string filter vs ledger, (2) a cheap Haiku semantic "is this the same subject?" check. Accepted topics appended immediately. If <5 survive after 2 rounds → alert owner ("topic bank thin") and stop rather than post a near-duplicate.

## 3. Caption writer
write-caption.mjs: one Haiku call with voice.md verbatim + the topic. Then DETERMINISTIC enforcement: regenerate if 法律 appears (then fail+alert); assert footer (WhatsApp +852 9245 7743 + 【百達利離婚事務所】) and append canonical footer if missing; assert a 【…】 hook exists (publish-fb needs it for its dedup marker).

## 4. Poster generation
derive-concept.mjs: Haiku produces {headline, scene, cards[4], quote} (no-text image, 4 short labels, short red quote, no 法律), writes the concepts/NN.txt in gen-batch.mjs's exact format, then execFileSync gen-poster-v4.mjs <direction> <name> tl <conceptPath> with IMG_QUALITY=medium. Rotation alternates Infographic↔Cartoon. BUDGET: 5/week × ~4.33 ≈ 22 images/month × ~$0.05 ≈ ~$1/month, well under the $5/month cap.

## 5. Posting
post-today.mjs loads weeks/<thisWeek>.json, computes today's index (Mon=1..Fri=5 in Asia/Hong_Kong), and calls fb-post.ensureLive([indices up to today]) — scan live page, post only missing, re-scan, return true tally (self-heals skipped days, zero duplicates). Update per-post status to "posted" only after the re-scan confirms it live. On "Not logged in"/failure → notifyOwner.

## 6. Scheduling (LOCAL — by necessity)
Posting needs the local logged-in Chrome profile + residential IP (no Graph API admin), so a cloud cron CANNOT post — scheduling MUST be Windows Task Scheduler on this PC (state this plainly). Two tasks:
- BetterLife-GenWeek: weekly Sun 09:00 PC-local → gen-week.mjs (next week's batch). StartWhenAvailable.
- BetterLife-PostToday: daily Mon–Fri 10:00 PC-local → post-today.mjs (idempotent, posts gaps).
Pin content cadence to Asia/Hong_Kong in the scripts (compute week/weekday in HK time) regardless of the PC's wall-clock timezone; set trigger times so the daily run lands in the HK posting window. register-tasks.ps1 registers both with -StartWhenAvailable + -RunOnlyIfLoggedOn (interactive session needed for the Chrome profile); re-runnable.

## 7. State machine
companies/better-life/weeks/<weekId>.json (weekId = ISO week in HK time). Batch status planned→generated→posting→done; per-post status planned→generated→posted (posted set ONLY after live verification). The JSON is intended content; the live FB scan is truth — they reconcile every run, so missed days/sleeping PC/crashes self-heal with no duplicates. JSON over SQLite (only 5 rows/week; repo deps are just sharp+playwright).

## 8. Failure handling + alerting + the re-login touch
One channel: Telegram (lib/notify.mjs → sendMessage). GAP TO CLOSE FIRST: .env has TELEGRAM_BOT_TOKEN but NO TELEGRAM_CHAT_ID — owner must message the bot once, then read getUpdates to capture the chat id and add TELEGRAM_CHAT_ID to .env (a get-chat-id.mjs helper prints it). This is step 0 of go-live (alerts can't reach the owner without it).
Alerts fire on: FB session expired (the recurring one — "run warm-chrome to re-login, posting resumes automatically"), posting failed/item still missing after re-scan (+ the _err-*.png screenshot path), generation failed or topic bank thin, optional budget tripwire. Default to alert-on-failure-only (no daily heartbeat noise), matching "I don't want to have to ask."
HONESTY: Fully hands-free EXCEPT roughly every few weeks one Telegram tap to re-login when FB's cookie expires. Cannot be auto-done (FB needs the human + possibly 2FA). Everything else needs zero owner involvement.

## 9. Build order
1. Telegram chat id (get-chat-id.mjs; owner messages bot once; add TELEGRAM_CHAT_ID; lib/notify.mjs + test ping) — unblocks alerting.
2. Refactor lib/fb-post.mjs out of publish-fb.mjs (confirm launch path still works).
3. lib/anthropic.mjs + lib/ledger.mjs + seed-ledger.mjs (seed 25 launch topics).
4. gen-topics.mjs (verify 5 fresh non-dup topics).
5. write-caption.mjs (verify voice/footer/法律-ban).
6. derive-concept.mjs + gen-poster-v4 (one real poster end-to-end at medium; eyeball vs assets/ quality bar).
7. gen-week.mjs (full weeks/<id>.json + 5 posters in one run).
8. post-today.mjs (idempotency + self-heal + Not-logged-in alert path).
9. windows/ wrappers + register-tasks.ps1 (verify trigger times hit HK window; run each once manually).
10. One supervised live week, then leave it. Update docs/05-status + add an ADR mirroring facebook-group-automation ADR-0008 (local scheduling + re-login alert).

## Bottom line
Hands-free: topics (never repeating), captions (on-voice, 法律-safe), posters (on-budget), posting (Mon–Fri, self-healing) — all automatic. The ONE exception: an infrequent one-tap Telegram re-login when FB's cookie expires. Local-only: runs on this Windows PC, which must be on + logged in at trigger times. Budget ~$1/month of images vs $5 cap.
