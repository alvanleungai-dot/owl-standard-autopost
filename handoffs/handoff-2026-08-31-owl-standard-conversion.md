# Session Handoff — 2026-08-31

## Goal
將一個服務四個香港離婚品牌嘅 multi-tenant 自動出帖引擎，改造成 **Owl Standard 簡樸房（BHU）認證** 單租戶專用，並且部署到 Render。

## 起點
用戶由 GitHub 下載 `social-content-engine-main.zip` 解壓到 `C:\Users\alvan\Desktop\Automation post\`。
**唔係 git repo，冇 remote，冇 commit 過。**上游 repo 唔會受影響，可以放心改。

---

## What Was Done

### 刪走（離婚品牌）
- `companies/{better-life,bright-day,sunmood,tml}/` — 全部租戶資料
- `scripts/{better-life,bright-day,sunmood,tml}/` — 全部租戶腳本
- `scripts/lib/topic-engine.mjs` — LENSES 全部係離婚廣東話字串
- `scripts/lib/ledger.mjs` — 硬綁 `companies/better-life`
- `scripts/lib/brand-family.mjs` — 三姊妹品牌互斥邏輯，單租戶下無意義
- `scripts/gen-topics.mjs`、`gen-week.mjs`、`verify-family-dedup.mjs`
- ~25 個離婚專用 dev/probe 工具
- `src/`（CLAUDE.md 自己講明係 unused placeholder，冇任何 import）
- `windows/`（Task Scheduler，被 Render 取代，且多個 .cmd 指住已刪腳本）

### 新增（Owl Standard）
| 檔案 | 用途 |
|---|---|
| `companies/owl-standard/company.md` | 租戶設定 + 品牌 brief + 合規紅線 |
| `companies/owl-standard/voice.md` | 聲線契約（gold-standard 用 about.html 原文） |
| `companies/owl-standard/topics.md` | 28 lens × 12 persona × 10 angle = 3,360 格 |
| `companies/owl-standard/seeds.md` | 27 條真實 FAQ + 帖題種子 |
| `companies/owl-standard/fact-check.md` | 官方來源白名單 + 定期覆核項目 |
| `scripts/owl-standard/topic-engine.mjs` | 揀題（least-used cell 優先，唔 call Perplexity） |
| `scripts/owl-standard/gen-week.mjs` | 題目→文案→概念→海報→weeks JSON，3帖/週（二三五） |
| `scripts/owl-standard/weekly-run.mjs` | 週度自動跑 + Telegram 審批推送 |
| `scripts/owl-standard/api-schedule.mjs` | FB Graph API 排程（只出 approved） |
| `scripts/owl-standard/api-ig-daily.mjs` | IG 當日發佈 |
| `scripts/owl-standard/verify-higgsfield.mjs` | **探測 GPT Image endpoint（唔使 credit）** |
| `scripts/owl-standard/doctor.mjs` | **開跑前檢查（唔使 credit）——第一件要跑嘅嘢** |
| `scripts/lib/image-backend.mjs` | **可切換生圖後端 higgsfield/openai** |
| `scripts/lib/caption-marker.mjs` | hookLine + markerFor 單一定義（見下面 bug） |
| `.env.example` | 全部環境變數 + 邊度攞 |
| `docs/05-status/2026-W35-owl-standard-conversion.md` | 完整轉換紀錄 |

### 改造（共用 code 全部指返 owl-standard）
`tg-bridge.mjs` · `write-caption.mjs`（重寫，加合規閘）· `derive-concept.mjs` ·
`gen-poster-v4.mjs`（配色換 Owl Standard）· `lib/fb-post.mjs` · `lib/poster-regen.mjs` ·
`lib/content-repair.mjs` · `lib/worker-jobs.mjs` · `repair.mjs` · `catchup.mjs` ·
`gatekeeper.mjs` · `contact-sheet.mjs` · `poster-qa-sweep.mjs` · `fb-topup.mjs` ·
`migrate-state.mjs` · `lib/notify.mjs` · `check-keys.mjs` · `render.yaml`

---

## Current State

**Working:**
- `node --test scripts/**/*.test.mjs scripts/*.test.mjs` → **530 tests, 529 pass, 0 fail, 1 skipped**
- `node scripts/selftest-cloud-import.mjs` → **checked=14 failed=0**（全部排程任務喺模擬雲端載入成功）
- 兩個 publisher 冇密鑰時 **fail closed**，訊息講明缺咩

**1 個 skip 唔係 bug：** `fonts.test.mjs` 嘅「sharp 畫中文」測試喺 `win32` 跳過。
Windows DirectWrite 對兩個字型名都替換成同一個系統中文字型，令個負面判斷失效。
喺 Render 個 Linux container 照跑。

**Broken/Incomplete:**
- 冇 API key，**未做過一次真 API call**。全部驗證係測試同模擬。
- `HIGGSFIELD_ENDPOINT` 未設定 → 現時 fallback 去 Flux Pro，**唔係想要嘅 GPT Image 2**
- 未 `git init`，Render 部署需要 git repo

**Last action:** 修好 env 讀取 bug（見下）、加 `doctor.mjs`、用假 key 真跑過 gen-week 驗證失敗路徑乾淨。
測試 **530 tests / 529 pass / 0 fail / 1 skipped**。

**已驗證過嘅嘢（唔係淨係靠測試）：**
- 用假 key 真跑 `gen-week.mjs` → API call 之前全部通（參數、週次選擇、覆寫檢查、ledger、topic-engine 接線）
- 失敗喺**預留題目之前**，冇寫低任何檔案，冇污染 ledger → 修好個 key 直接再跑就得
- 401 而家有可讀訊息，唔係 raw stack trace
- `doctor.mjs` 冇密鑰時 exit 1，有密鑰時 exit 0

---

## ⚠️ Mistakes & Lessons Learned

| 問題 | 缺少嘅資訊 | 點樣解決 | 下次規則 |
|---|---|---|---|
| 一開始講「GPT Image 2 喺 Higgsfield API 冇得用」 | 只 WebFetch 咗 openapi.json 一部分就落結論 | 用戶 push back，再搜先確認有 | **文件 fetch 唔完整就唔好落否定結論**，講「查唔到」而唔係「冇」 |
| 叫用戶唔使買 Perplexity，跟住又反口話要買 | 冇分清「系統跑唔跑得郁」同「內容會唔會過時」 | 最終定案：唔使買，靠 fact-check.md 人手覆核 | 俾建議前先分清係 **blocker** 定係 **long-term risk** |
| `markerFor` 修咗一半 | 唔知道 `lib/fb-post.mjs` 有第二個副本 | 收埋做 `lib/caption-marker.mjs` 單一定義 | **修 bug 前先 grep 全 repo 搵同類邏輯有幾多份** |
| 刪咗 `write-caption.mjs` / `derive-concept.mjs`，tg-bridge 炸咗 | cloud-import selftest 睇唔到**函數體內嘅 dynamic import** | 由 zip 還原並改造 | 刪檔案前 grep **靜態 + 動態** import 兩種 |
| 帖 03 費用階梯漏咗情況(a) | 冇逐項對返附表2，憑印象寫 | 補返，並喺文件寫低 | **數字類內容一定要逐項對一手來源** |
| Python heredoc 多次搞爛 `\r?\n` | Bash heredoc + Python 字串轉義層疊 | 改用 Write tool 或 `chr(92)` 明確建構 | 內容有 regex／反斜線時**唔好用 heredoc**，用 Write |

**什麼做法有效（保留）：**
- **可切換後端而唔係死換**（`IMAGE_BACKEND`）— 未驗證嘅新 provider 一定要留返舊路
- **反空轉測試**（anti-vacuity guard）— 清單變空時測試會靜靜雞全綠，加一個 assert 對住 SCHEDULED_JOBS 就唔會
- **合規規則寫入 code 唔止寫入文件** — `write-caption.mjs` / `derive-concept.mjs` 會 throw
- **重試時明確講違反咗邊條規則** — 單純叫模型「再試」會犯返同一個錯
- 用真 code path 生 prompt（讀 source 嘅 BRAND 常數），保證手動測試同自動運行一致

---

## Next Steps

0. **`node scripts/owl-standard/doctor.mjs`** ← 每次唔知邊度出事就跑呢個，免費
1. **攞 Higgsfield API 憑證** → `secrets/owl-standard/.env` 填 `HIGGSFIELD_API_KEY_ID` / `_SECRET`
2. **跑 `node scripts/owl-standard/verify-higgsfield.mjs`** → 探測 GPT Image endpoint（唔使 credit）
   - 搵到 → 填 `HIGGSFIELD_ENDPOINT`
   - 搵唔到 → email support@higgsfield.ai 問路徑
3. **跑 `--generate`** → 生一張真圖，**淨係睇繁體中文有冇缺筆／變形**
   - OK → 繼續 · 唔OK → `IMAGE_BACKEND=openai` 切返後備
4. 填 `ANTHROPIC_API_KEY` → 跑 `node scripts/owl-standard/gen-week.mjs` 生第一批（約 US$0.2）
5. 用戶同老闆睇聲線 → 認可嘅樣本寫入 `voice.md` gold-standard examples
6. Telegram 兩個 bot → FB/IG 權限 → Cloudinary → `git init` → Render

**Blockers:**
- `HIGGSFIELD_ENDPOINT` 未知 = 生圖會行錯模型
- FB Page Editor 權限 + IG `instagram_content_publish` App Review = 最慢，建議並行申請

---

## 分工：AI 做得到咩、用戶要自己做咩

用戶 2026-08-31 問「我俾晒資料你，你係咪跑得起成個系統？」——答案分兩半，
下一個 session 直接沿用呢個分工，唔使重新討論。

### AI 可以直接跑
| 指令 | 成本 | 備註 |
|---|---|---|
| `node scripts/owl-standard/doctor.mjs` | 免費 | 開跑前檢查 |
| `node scripts/owl-standard/verify-higgsfield.mjs` | 免費 | 探測 endpoint（空 body → 404 vs 422） |
| `... verify-higgsfield.mjs --generate` | 少量 credit | 生一張測試圖 |
| `node scripts/owl-standard/gen-week.mjs` | ~US$0.2 | 3 文案 + 3 海報 |
| `node --test scripts/**/*.test.mjs scripts/*.test.mjs` | 免費 | |

**AI 讀得到生成嘅 PNG**，所以可以自己檢查中文字有冇缺筆／變形、左上角留位、
橙色比例——唔使用戶形容。生完直接報結果。

### 必須用戶自己做
- **買 API key**（要佢張卡）
- **開兩個 Telegram bot**（要喺佢部機同 @BotFather 對話）
- **開 Render 戶口 + 喺網頁後台填環境變數**（`git init`/commit AI 做得到，但要用戶批准）
- **攞 FB Page Editor 權限 + IG App Review**（公司內部 + Meta 審批）
- **入 cloud.higgsfield.ai 攞 GPT Image endpoint 路徑**（公開文件冇，要 dashboard 或 support）

### AI 唔會自己做（就算有 token）
- **發布去 FB／IG** —— 對外、不可逆。一定要用戶逐次明確批准先發。
- **長期跑 `tg-bridge.mjs`** —— 佢係長期輪詢 process，應該喺 Render 跑，唔係喺 chat session。

### ⚠️ 密鑰處理規矩
**唔好叫用戶將 API key 貼入對話** —— 對話紀錄會保存。
正確做法：用戶自己寫入 `secrets/owl-standard/.env`，然後講「填好喇」。
`getEnv()` 自己會讀，AI 由頭到尾唔需要見到 key 嘅值。
`check-keys.mjs` 同 `doctor.mjs` 都只報「有/冇」，唔會印出內容。

### 建議執行次序（用戶只需要做第 1 步同最後審批）
1. 用戶填 `.env`（`ANTHROPIC_API_KEY` + 兩條 Higgsfield）
2. AI 跑 `doctor.mjs` 確認讀到
3. AI 跑 `verify-higgsfield.mjs` 探測 endpoint
4. 探到 → 填 `HIGGSFIELD_ENDPOINT` → AI 跑 `--generate` → **AI 親自睇中文**
5. 中文 OK → AI 跑 `gen-week.mjs` → AI 睇完先交俾用戶同老闆審

第 2–5 步用戶只需要等。

---

## Important Context（唔睇 code 睇唔出）

- **Higgsfield 係定案，OpenAI 只做後備。**用戶老闆有 Higgsfield 戶口。唔好改 default。
- **Perplexity 唔買。**系統從來唔 call 佢。時效性靠 `fact-check.md` 人手覆核。
- **海報版面沿用離婚品牌，只換配色 + logo。**用戶明確指示。
  配色：底 `#FDF8F0` · 強調 `#EA6321` · 墨 `#14201c` · 次要 `#5B6864`
- **需要兩個 Telegram bot。**審批 bot + ops 警報 bot，code 唔准共用，worker 冇 ops bot 拒絕開機。
- **Cloudinary 只有出 IG 先需要**（Meta IG API 收公開 URL，唔收上傳）。
- **`design.md` 唔需要。**純文件，唔影響運作。之前誤導咗用戶以為係缺口。
- **今日 2026-08-31 = 認證費情況(a) 首6個月登記嘅最後一日。**
  聽日起登記嘅業主落入情況(b)。費用類帖文出街前要再確認日期。
- 用戶偏好：**唔好留無用檔案喺 project**。樣本/測試 txt 全部放咗
  `C:\Users\alvan\Downloads\owl-standard-docs\`
- 根目錄仲有 `_ops-report.md` / `_ops-cloud-audit.md`（前 session 稽核紀錄），用戶未決定刪唔刪

---

## Key Files

| File | Purpose |
|---|---|
| `docs/05-status/2026-W35-owl-standard-conversion.md` | **先讀呢個**，完整轉換紀錄 |
| `companies/owl-standard/company.md` | 租戶設定，仍有 GAP：page_id / ig_user_id / telegram id |
| `companies/owl-standard/topics.md` | lens/persona/angle 資料源 |
| `companies/owl-standard/fact-check.md` | 官方來源白名單，法規事實只信呢五個來源 |
| `scripts/lib/image-backend.mjs` | 生圖後端切換，**endpoint 註釋要睇** |
| `scripts/lib/caption-marker.mjs` | hookLine/markerFor 單一定義，唔好再開副本 |
| `scripts/write-caption.mjs` | 合規閘（BANNED 規則）+ 9 個測試 |
| `scripts/owl-standard/gen-week.mjs` | 主 pipeline |
| `.env.example` | 全部環境變數 + 邊度攞 + 邊條可留空 |
| `C:\Users\alvan\Downloads\owl-standard-docs\` | SETUP-CHECKLIST · POSTER-PROMPTS · SAMPLE-POST-01/02/03 |

**Environment:**
- Node v24.15.0，`npm install` 已跑（sharp + playwright）
- 密鑰放 `secrets/owl-standard/.env`（gitignored），格式見 `.env.example`
- `IMAGE_BACKEND` 預設 `higgsfield`
- **密鑰讀取次序：`process.env` → `secrets/owl-standard/.env` → `.env`**（2026-08-31 修好，之前只讀 root）
- 驗證指令：`node scripts/owl-standard/doctor.mjs`（免費全面檢查）
  · `node scripts/check-keys.mjs`（真連線測試，唔會印出 key）

---

## 合規紅線（帖文絕對唔可以違反，已寫入 code）
1. 唔可以保證認證結果（包過／一定成功／保證通過）
2. 認證有效期寫 **「60個月」**，唔可以寫「5年」
3. 認證主管部門係 **「房屋局」**，唔係「屋宇署」
4. 唔可以暗示政府背書（政府認可／官方認可）
5. 「劏房」≠「簡樸房」，唔可以當同義詞
6. 認證費係三級階梯，唔可以寫「劃一 $3,000」
7. 罰則要補「每持續一日另罰 $20,000」

⚠️ 網站本身喺 `about.html` / `service.html` / `service-certification.html` / `service-management.html`
至少四頁寫緊「5年」，喺 `about.html` 用錯「屋宇署」。**唔可以照抄網站。**
