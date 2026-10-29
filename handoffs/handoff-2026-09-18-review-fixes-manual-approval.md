# Session Handoff — 2026-09-18

## 目標
填金鑰前審閱 Owl Standard 自動發帖系統並修正所有問題。用戶決定：人手批准、每月送審、只由用戶批准、盡量節省 API 成本。

## 已完成
- 審閱：Render 無法啟動、重做按鈕失敗、FB 失敗無警報、IG 單獨發佈、合規過濾不足、文案無事實依據、每日假警報
- git：`git init -b main`，基線 commit `554089b`（235 檔）；**之後全部修改未 commit**
- A 啟動及設定：`scripts/init-state-dir.mjs`（新品牌可啟動，自動建空白 ledger）；`scripts/preflight.mjs` 刪 Perplexity 探測、刪 `scripts/lib/perplexity.mjs`；`scripts/lib/scheduled-job-runtime.mjs`（exit 2 不重複警報）；`weekly-run.mjs` 時限 20 分鐘；`catchup.mjs`（預備 5 週、25 分鐘）；`package.json` engines node 24.x；`.env.example`、`render.yaml`（開關格式）；`doctor.mjs`（偵測填錯的開關）
- B 人手批准：`scripts/lib/review-core.mjs`、`review-weeks.mjs`（`REVIEW_AUTO_APPROVE_ENABLED` 預設關、發佈前 24 小時提醒、`isBulkApprovable`、`bookingReport`）；`monthly-review.mjs`、`deliver-monthly.mjs`（文字）；`scripts/tg-bridge.mjs`（按鈕只限 TG_CHAT、批准後即時執行 api-schedule 並回報、全部批准只限已送審）；`weekly-run.mjs`（每月模式通知）
- C 發佈正確性：`scripts/lib/publishable.mjs`（`lastBookableDate` 29 日、`instagramDue`）；`api-schedule.mjs`（香港日期、29 日窗口、失敗 exit 1）；`api-ig-daily.mjs`（須 FB 已預約、只發當日或前一日、輪詢 status_code）；新 `scripts/lib/fb-cancel.mjs`（❌／🔁 取消 FB 預約並釋放 ledger）；`tg-bridge.mjs` 重做改背景執行、加 `--force`、修正海報路徑
- D 內容及合規：新 `companies/owl-standard/facts.md`（已對照 `_owl_extract/.../content/ordinance-cap658.md`）；新 `scripts/lib/compliance.mjs`（7 條紅線，雙向測試）；`write-caption.mjs`、`derive-concept.mjs` 接入；`gen-week.mjs`、`content-repair.mjs` 傳入發佈日期
- E 清理：刪 golf（`scripts/golf|notion|copilot`、`glp-iso.mjs`、`scripts/fonts`、9 個 golf 測試、5 項 Golf 工作）及離婚品牌（`watchdog.mjs`、`lib/fb-post.mjs`、`lib/feed-scan.mjs`、`scripts/BOT-OPS.md`、`docs/portfolio.md`、4 份 superpowers 文件）；封存至 `_archive/`（task-health、gatekeeper、find-keys、`_ops-*.md`、CodeFocus 文件）；`npm uninstall playwright`；重寫 `README.md`
- memory：`owl-standard-project.md` 加入用戶決定；新增兩則（見下）

## 目前狀態
**正常：** 全套測試 406 項（405 通過、1 項按設計略過）；雲端匯入 8/8；模擬 Render 啟動成功；以假 Meta 回應模擬 FB 預約及 IG 發佈成功
**未完成／未驗證：** 金鑰未填；真實 Meta、IG、Higgsfield、Telegram 呼叫未測；FB 取消預約（DELETE）實際效果未測；Meta 開發模式下帖文是否公開未核實；Higgsfield GPT Image 路徑未知
**最後動作：** 交付最終報告、更新 memory，用戶要求建立本交接文件

## ⚠️ 錯誤與教訓
| 問題 | 缺少的資訊 | 如何解決 | 下次規則 |
|---|---|---|---|
| 舊 memory 寫「7 條紅線已寫入程式碼」 | 未逐條核對 `BANNED` | 實測只有 4 條且規則窄；重做 `compliance.mjs` | 引用 memory 前先實測 |
| 530 項測試全綠，Render 仍無法啟動 | 測試只測個別模組，沒測接縫（真實 `companies/` 加 init） | 以真實資料夾實跑 `init-state-dir.mjs` | 部署前實跑啟動指令 |
| 用戶選「先不要」 | 問是否清理前，未解釋那些檔案是甚麼 | 列表說明用途及影響後再問 | 讓用戶決定前先解釋項目 |
| `node --import` 失敗 | Git Bash 的 `/c/...` 不是有效 file URL | 用 `cygpath -m` 轉換 | 見 memory `windows-gitbash-quirks` |
| 移除 Golf 工作的腳本沒有效果 | 檔案是 CRLF 換行 | 比對前去掉 `\r` | 文字處理先查換行符 |
| 合規測試樣本失敗 | 「罰款 $300,000」會觸發每日罰款規則 | 修正樣本 | 雙向樣本要顧及所有規則 |
| 曾建議保留 `find-keys.mjs` | 未讀檔案內容 | 發現寫死他人電腦路徑，改為封存 | 建議保留前先讀內容 |

**什麼做法有效（保留）：**
- 以假 fetch（`node --import` 預載）加暫存 STATE_DIR，無需金鑰即可端到端模擬發佈流程
- 雲端模式（`CLOUD=1`）測試的 STATE_DIR 須在系統暫存資料夾以外（如 Downloads），用後刪除
- 修改前先建立 git 基線，改錯可以還原
- 合規規則雙向測試：必須攔截、必須放行

## 下一步
1. 問用戶：是否在新分支 commit 本次修改（目前全部未 commit，基線 `554089b`）
2. 問用戶：可否更新 `companies/owl-standard/company.md` 第 58 行（仍描述已不存在的 Sonnet 覆核）及專案 `CLAUDE.md`（合規描述過時）——按全域規則須先確認
3. 用戶或老闆核對 `companies/owl-standard/facts.md`
4. 填 Anthropic 及 Higgsfield 金鑰 → `doctor.mjs` → `verify-higgsfield.mjs`（API 目錄未見 GPT Image；候選 `alibaba/qwen-image-3/text-to-image`、`ideogram/v4.0`）→ `gen-week.mjs` 生成第一週並人手檢查
5. 兩個 Telegram bot（先按 START）→ `get-chat-id.mjs`
6. Meta 系統使用者權杖；首次發佈後以未登入瀏覽器確認公開
7. Cloudinary → Render（私人 GitHub 儲存庫；`PUBLISHING_ENABLED=1`、各 `JOB_*=true`）
8. 2027-01-21 前更新 Graph API v21.0（見於 api-schedule、api-ig-daily、meta-dedup、fb-token-probe、fb-cancel）

**阻礙：** 金鑰未填；Higgsfield 生圖路徑未知；Render 需要 git 遠端儲存庫

## 重要背景
- 用戶決定：不設自動批准（開關預設關，不要重開）；每月 1 日送審；只由用戶批准；盡量節省 API 成本
- 預備 5 週而非 2 週：每月送審要求 1 日前已有下月內容
- 批准後即時預約 FB；SCE-FB-Topup 每日補做；超過 29 日的帖文稍後自動預約
- `PUBLISHING_ENABLED` 必須是 `1`；`JOB_*` 必須是 `true`；本機執行不受 `PUBLISHING_ENABLED` 限制，測試時加 `--dry`
- 海報自動檢查（SCE-PosterQA）建議保持關閉：節省成本，且已有人手批准
- 修改過的 Telegram 訊息用書面語，其餘仍是廣東話
- 網站本身有「5年」「屋宇署」錯誤，不可照抄；事實以 `facts.md` 為準
- 測試指令：`node --test scripts/**/*.test.mjs scripts/*.test.mjs`；不要直接執行 `node --test`（會跑到 `_archive/` 內已失效的測試）
- 修改 CLAUDE.md、設定檔或刪除內容前，須先向用戶確認

## 主要檔案
| 檔案 | 用途 |
|---|---|
| `companies/owl-standard/facts.md` | 帖文唯一事實來源 |
| `scripts/lib/compliance.mjs` | 7 條合規紅線 |
| `scripts/lib/review-core.mjs`、`review-weeks.mjs` | 人手批准、提醒、全部批准範圍 |
| `scripts/tg-bridge.mjs` | Telegram 審批、即時預約、取消、重做 |
| `scripts/owl-standard/api-schedule.mjs` | Facebook 預約 |
| `scripts/owl-standard/api-ig-daily.mjs` | Instagram 發佈 |
| `scripts/lib/fb-cancel.mjs` | 取消 Facebook 預約 |
| `scripts/lib/publishable.mjs` | 發佈規則（29 日窗口、IG 條件） |
| `scripts/init-state-dir.mjs` | Render 磁碟初始化 |
| `.env.example`、`render.yaml` | 環境變數及正確格式 |
| `_archive/README.md` | 封存內容說明 |
| `handoffs/handoff-2026-08-31-owl-standard-conversion.md` | 上一份交接 |

**環境：** Node v24.15.0；唯一依賴 sharp；金鑰放 `secrets/owl-standard/.env`（gitignored）；git 只有本機，沒有遠端
