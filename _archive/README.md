# _archive — 不再使用的檔案

這些檔案不屬於 Owl Standard 的發帖流程，系統不會執行，亦不在測試範圍內。
保留作參考；確定不需要時，可以整個資料夾刪除。

| 檔案 | 原本用途 | 封存原因 |
|---|---|---|
| `scripts/task-health.mjs`、`scripts/lib/task-health-core.mjs` | 讀取 Windows「工作排程器」的結果，自動重新登記失敗的工作 | 系統改在 Render 運行，沒有 Windows 工作排程器 |
| `scripts/gatekeeper.mjs`、`scripts/lib/gatekeeper-*.mjs` | 每日系統健康報告（「守門人」） | 依賴 Windows 工作排程器，並以「星期一」判斷排程；Owl Standard 在星期二、三、五發佈，只會產生假警報 |
| `scripts/find-keys.mjs` | 尋找金鑰寫在哪個 .env 檔 | 路徑寫死在另一部電腦；`scripts/check-keys.mjs` 已提供同樣功能 |
| `_ops-report.md`、`_ops-cloud-audit.md` | 上一個項目的檢查紀錄 | 與 Owl Standard 無關 |
| `docs/`（CodeFocus 相關） | 另一個客戶項目的設計及簡報 | 與 Owl Standard 無關 |

注意：檔案內的相對路徑 import 在搬移後已失效，不能直接執行。
所有檔案在 git 基線版本（`Baseline: snapshot before review fixes`）中亦有完整記錄。
