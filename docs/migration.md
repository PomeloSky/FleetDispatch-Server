# 資料表版本與升級

主機的資料表有版本（`fd_meta` 的 `schema`，`GET /api/v1/info` 的 `schemaVersion`）。新版本的主機在**第一次收到請求時**自動把資料表升級到目前版本；每一步都可以重複執行（中途失敗後重新啟動會再試），完成後才更新版本。新安裝直接建立最新的資料表。

| 版本 | 主機 | 內容 |
| --- | --- | --- |
| 1 | 1.0.0–1.1.x | 初版 |
| 2 | 1.2.0 | `fd_records.revision`（每筆資料的版本；既有資料從 1 開始）、`fd_record_history`（修改前後歷史，含 `outcome` 套用結果）、`fd_processed_events`（已處理事件，冪等）；清除 1.0–1.1 稽核紀錄中駕駛人的摘要（個資）；`fd_meta` 的 `guard`（多筆不可分割寫入用） |

## 升級前備份

| 實作 | 自動備份 | 建議 |
| --- | --- | --- |
| Docker／Node | 有：資料庫是舊版本時，啟動時先以 `VACUUM INTO` 複製一份 `fleetdispatch.sqlite.before-v2-<時間>.bak`（同一個資料夾） | 另外保留 volume 的快照 |
| PHP＋SQLite | 有：遷移前以 `VACUUM INTO` 複製 `<資料庫檔>.before-v2-<時間>.bak`（同一個資料夾，已禁止從網站存取） | — |
| PHP＋MySQL | 沒有（無法從 PHP 安全地備份整個資料庫） | **升級前**以 `mysqldump --single-transaction <資料庫> > backup.sql` 或主機商的備份功能備份 |
| Cloudflare D1 | 沒有 | 部署前 `wrangler d1 export fleetdispatch --remote --output backup.sql`；D1 也有 Time Travel 可回到過去的時間點 |

## 遷移的細節

- **Docker／Node、Cloudflare D1**（`core/src/db.ts` 的 `Repo.migrate`）：版本 1 → 2 的敘述（補 `revision` 欄位、建立新資料表、既有資料的版本設為 1、清除駕駛人的稽核摘要、更新版本）在同一個 batch（交易）中執行；欄位已存在時略過。
- **PHP＋SQLite**（`php/src/Db.php`）：同上，整步在 `BEGIN IMMEDIATE` 的交易中。
- **PHP＋MySQL**：MySQL 的 DDL 會自動提交，所以以 `GET_LOCK('fleetdispatch_migrate')` 避免兩個請求同時遷移，並逐項檢查（欄位是否已存在、`CREATE TABLE IF NOT EXISTS`），最後才更新版本；中途失敗時下一個請求會從未完成的項目繼續。
- 資料表已經手動匯入（帳號沒有建表權限）：請先匯入新版的 `php/schema/mysql.sql` 中 1.2.0 的兩個資料表，並以 `ALTER TABLE fd_records ADD COLUMN revision BIGINT NOT NULL DEFAULT 0` 補欄位，主機會把版本更新為 2。

## 降版

不支援。升級到 1.2.0 後若要回到 1.1.x，請還原升級前的備份（1.1.x 讀得到 1.2.0 的資料表，但不會更新 `revision`、不寫歷史；之後再升級時版本不會再遷移，`revision` 會與實際的修改次數不符）。

## 測試

- `conformance/migration-node.test.mjs`：以 1.1.0 的資料表建立 Docker／Node 版的資料庫，啟動目前版本：自動備份、資料不變、既有資料的版本是 1、駕駛人的稽核摘要被清除（其他摘要不變）、新的寫入留下歷史；再次啟動不重複遷移與備份。
- `conformance/migration-php.test.mjs`：PHP＋SQLite 版的相同測試（需要 `php` 與 `pdo_sqlite`）。
- Cloudflare D1：以 `wrangler d1 execute --local` 建立 1.1.0 的資料表與資料，再以 `wrangler dev --local` 啟動確認（2026-11-06 手動驗證：版本 1 → 2、既有資料 `revision = 1`、歷史資料表已建立）。
- MySQL：需要有 MySQL 的環境（CI）執行 `conformance/` 的測試。
