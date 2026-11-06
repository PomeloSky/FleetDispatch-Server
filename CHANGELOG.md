# 更新紀錄

## 1.2.0（尚未發布）

需要 FleetDispatch App 8.0（build 19）以上。App 8.0 照舊運作（不使用 1.2.0 的新能力）；與 App 的相容性見 [`docs/protocol.md`](docs/protocol.md) §14。

### 網頁管理

- 13 個管理區塊：總覽、使用者與駕駛、裝置、車輛、車趟、用車申請、巡檢與工單、保養與零件、即時位置、報表、修改歷史與稽核、配對碼、主機設定。
- 資料清單的搜尋、篩選、排序、分頁；詳情與關聯資料；受控修改（欄位檢查、差異預覽、原因、版本衝突提示）；刪除的影響預覽與確認；
  用車申請的核准與退回；報表（期間摘要、依車輛／駕駛人／成本中心／日期、CSV）；修改前後歷史與版本比較。說明：[`docs/admin-management.md`](docs/admin-management.md)。
- 登入改由主機以 HttpOnly Cookie 保存（網頁的程式讀不到權杖），有 CSRF 防護與閒置、登入期限；1.1 存在瀏覽器的登入在第一次開啟時自動轉換。

### 同步與資料

- 事件冪等：同一台裝置重送同一個事件只套用一次（回應遺失後重送是安全的）。
- 每筆資料的版本（`revision`）、選填的 `expectedRevision` 與 `conflict`；授權與寫入看到同一個版本。
- 修改前後歷史：App、網頁管理與連鎖刪除的每一次寫入，沒有套用的事件也留下摘要；駕駛人的個資預設遮蔽。
- 刪除車輛：還有進行中的車趟時拒絕；連鎖刪除不可分割。
- 報表的查詢與 CSV 匯出，計算規則與 App 相同（[`docs/reports.md`](docs/reports.md)）。
- 稽核紀錄也記錄配對、網頁登入、角色與綁定、解除配對、配對碼、主機名稱；修改前後歷史可設定保留天數（預設不刪除）。

### 安全

逐項檢查與修正的結果：[`docs/security-review.md`](docs/security-review.md)。重點：網頁登入改用 HttpOnly Cookie；所有管理員的登入都失效時設定碼重新有效；
IPv6 的配對嘗試次數以 /64 網段計算；三種實作一致的 JSON 層數與欄位長度限制；MySQL 欄位長度修正；管理頁的安全標頭。

### 資料表

資料表版本 1 → 3，第一次請求時自動遷移（Docker 與 PHP＋SQLite 會先自動備份；MySQL 與 Cloudflare D1 請先自行備份）。
不支援降版，細節見 [`docs/migration.md`](docs/migration.md)。

### 升級前

1. 備份資料庫（各部署方式的說明都有備份方法）。
2. 更新程式後打開一次 `GET /api/v1/info`，確認 `serverVersion` 是 `1.2.0`、`schemaVersion` 是 `3`。
3. 網頁管理：1.1 記住登入的瀏覽器會自動轉換；轉換失敗或沒有記住登入時，請用管理員的配對碼重新登入。

## 1.1.0

- 首頁改為 FleetDispatch App 的介紹與下載連結；新增網頁管理（預設網址 `/admin`，可以改成其他路徑或關閉）。
- PHP 版的安裝精靈：沒有 `config.php` 時在網頁完成安裝（需要安裝金鑰）。

## 1.0.0

- FleetDispatch Server API v1：協定規格、TypeScript 核心，Cloudflare Workers＋D1、Docker／Node、PHP＋MySQL（也可用 SQLite）三種實作。
