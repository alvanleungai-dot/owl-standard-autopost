---
id: owl-standard
name: Owl Standard 簡樸房認證
status: pilot
mode: training                 # per-image approval until voice is proven
locale: zh-HK
timezone: Asia/Hong_Kong
channels:
  facebook:
    enabled: true
    page_id: ""                # GAP — need Owl Standard's FB Page ID
    publish_via: graph_api
  instagram:
    enabled: true
    ig_user_id: ""              # GAP — need IG Business account ID (must be linked to the FB Page)
cadence:                       # 4x/week feed + daily IG story, per 2026 HK B2B/professional-services benchmarks
  tue: tip                     # Tue/Wed 10:00-12:00 is the highest-engagement B2B window
  wed: case_study
  fri: image
  sun: story                   # IG Story only — low-effort, keeps daily presence between feed posts
post_window: "10:00-12:00"     # Tue/Wed data-backed; other days reuse this window for consistency
approver_telegram_id: 0        # GAP — need your Telegram numeric ID
budgets:
  image_usd_month: 30          # placeholder, matches template default
assets:
  logo: "companies/owl-standard/assets/logo.png"   # GAP — you pasted the logo as an image; need the actual PNG file
  brand_colors:
    - "#FDF8F0"   # primary — paper/off-white (matches official --os-paper #fbf8f2), light base for social posts
    - "#EA6321"   # accent — official site orange (--os-accent), use for CTA/highlight elements
    - "#F97F2D"   # accent (alt) — your quoted orange, close to official; either is acceptable, EA6321 preferred for site consistency
    - "#14201c"   # dark — official site ink (--os-ink), use for headline text / dark UI elements, NOT as page background
    - "#5B6864"   # muted — official site muted tone (--os-muted), use for secondary text
    - "#FFFFFF"   # white — pure white option per your note
---

# Owl Standard 簡樸房認證 — Brand Brief

**One-liner.** 為香港劏房（簡樸房）業主提供一站式「簡樸房」合規認證服務——由認證前評估、裝修統籌、政府申請，到認證後管理，全程代辦。

**Audience.** 任何持有物業、已經係或準備轉做「簡樸房」嘅業主——唔限定背景、年齡或投資／自住性質（老闆確認：唔窄化目標客群）。亦特別服務「跨境業主」（人唔喺香港、要遙距管理物業嘅業主）。

**Voice.** 專業、可靠、沉穩自信（老闆定調：主力目標係建立公司權威感，令業主信得過將認證工作交俾我哋）。母公司 Owl Square Group 有 8 年、500+ 分間單位、40+ 地點嘅實戰經驗，定位係「我們不是新進入者」——用實績講可信度，唔靠空泛口號。詳細規則見 `voice.md`。

**Topics (rotate).** 內容主題由 lens × persona × angle 三維度組合生成，見 `topics.md`（已用網站真實內容叢集重新整理，比早前推斷版準確）。

**CTA rule.** ~1 in 7 帖連結 WhatsApp 諮詢（跟網站主 CTA `https://wa.me/85251927907`），其餘做純知識/信任建立內容。

**Compliance red-lines.**（已用官方條例文件 + 網站現行規則核實，非我方推斷）
- 唔可以暗示保證認證結果／通過率——網站自己都寫明「認證前評估為前期風險判斷，不構成最終法定核證結果」，帖文語氣要跟。
- 唔可以以公司名義提供法律意見（Owl Standard 係顧問／工程統籌角色，唔係律師行）——涉及法律責任嘅字眼要轉做「建議你了解」「一般而言」呢類語氣。
- 唔可以暗示官方/政府背書——只可以講「協助業主完成政府要求嘅申請程序」。
- **必須用「房屋局」，唔可以用「屋宇署」指代 BHU 認證主管部門**（屋宇署只負責建築工程審批，非 BHU 認證）。⚠️ 但 `about.html` 原文都寫錯（第88行「符合屋宇署要求」實際應為房屋局），呢個係網站自己嘅殘留錯誤，帖文唔可以照抄。
- **認證有效期一律講「60個月」，唔可以講「5年」**——網站入面 `about.html`／`service.html`／`service-certification.html` 三頁都仲寫緊「5年」，屬已知未修正錯誤，帖文一定唔可以照抄。
- 費用唔可以簡化講「$3,000 flat fee」——按官方附表2係三級結構（情況a/b/c），詳見 `topics.md` 附錄。
- 罰則唔可以只講「$30萬罰款+3年監禁」，須補「每持續一日另罰 $20,000」（公訴程序）。
- 「劏房」同「簡樸房」唔可以當同義詞——「劏房」係坊間講法，「簡樸房」係取得認證後先可以叫嘅法定類別。
- 寬限期截止日（2027.2.28）呢類時限資訊必須同官方公佈一致，唔可以誇大緊迫感製造恐慌式營銷。
- 系統入面有一個 compliance gate（`scripts/lib/`度嘅 gatekeeper，風險字眼用 Sonnet 覆核），可以將以上規則寫成清單餵俾佢做第一層過濾；但最終帖文你會自己睇一次先發，呢個係最後把關。

**Posting cadence & timing.**（研究整理：2026 年 B2B／專業服務類 FB/IG benchmark，香港冇獨立公開數據，用返呢個更大嘅通用市場數據）
- 頻率：Facebook 3–5 帖/週，Instagram 4–7 帖/週 + 每日 Story 為佳；`company.md` 現配置 3 個 feed 帖 + 1 個 IG Story/週做保守起點，跑穩定後可以加密。
- 時段：B2B 內容喺星期二、三上午 10:00–12:00 互動率最高；已寫入 `post_window`。
- 呢個 cadence 屬於估計值，非香港本地實測數據，建議首月試跑後用 Meta Business Suite 嘅實際 insights 微調。

**Assets.** logo `companies/owl-standard/assets/logo.png`（你已經放咗檔案，一般版；`logo-owl.png` 係完整版，海報視覺較大空間時用）。brand colors：主色用淺色 `#FDF8F0`（米白，跟官方 `--os-paper`）做帖文底色，強調色用 `#EA6321`（官方 `--os-accent` 橙色，你講嘅 `#F97F2D` 亦可接受）做 CTA/重點元素，深色 `#14201c`（官方 `--os-ink`）只用喺標題文字或深色細節,唔做主背景,灰綠 `#5B6864` 做次要文字。

**Contact reference (from website, not for posts unless asked).** WhatsApp 諮詢 · 電話 (852) 5192 7907 · info@owl2coliving.com · 荔枝角青山道702-704號合興工業大廈5樓C室
