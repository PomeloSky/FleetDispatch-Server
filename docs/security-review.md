# 安全檢查（1.2.0）

範圍：FleetDispatch Server 1.2.0 的三種實作（Cloudflare Workers＋D1、Docker／Node、PHP＋MySQL／SQLite）與網頁管理。
方式：逐項閱讀程式、在本機新建的主機上以相容性測試與瀏覽器實測驗證；**不是**第三方的滲透測試，也沒有對任何正式主機執行。
檢查日期：2026-11-06。

| 項目 | 結果 | 說明 |
| --- | --- | --- |
| 網頁管理的權杖長期保存在 localStorage | **已修正** | 改為 HttpOnly Cookie（§1） |
| 管理員工作階段的生命週期 | **已修正** | 網頁登入有閒置與登入期限（§1.4）；沒有可以使用的管理員時設定碼重新有效（§2） |
| 工作階段撤銷 | 已檢查 | 登出、管理員解除配對立即失效；Cookie 權杖不能放在 Authorization 使用（§1.5） |
| 敏感操作重新驗證 | 已評估，不實作 | 主機沒有密碼或帳號，無法重新驗證；以確認、原因與稽核降低風險（§1.7） |
| CSRF | **已修正** | 改用 Cookie 後新增：CSRF 權杖、Sec-Fetch-Site、JSON 本體、SameSite=Strict（§1.3） |
| 備份與還原 | 已檢查，文件補充 | 備份檔含配對碼雜湊與個資；還原會讓解除的配對回來（§3） |
| 資料庫 Migration | **已修正** | 資料表版本 3；PHP 手動匯入的資料表依實際欄位判斷版本（§1.6、[`migration.md`](migration.md)） |
| 版本回退 | 已檢查，文件補充 | 不支援降版；直接換回 1.1 的程式時網頁管理要重新登入（[`migration.md`](migration.md)「降版」） |
| XSS | 已檢查 | 沒有把資料當成 HTML 插入的地方；CSV 防公式注入（§4.1） |
| CSP 與安全標頭 | **已補強** | 程式只能來自同一個來源；新增 COOP、CORP、Permissions-Policy；`style-src 'unsafe-inline'` 評估後保留（§4.2） |
| API 權限、IDOR、權限提升 | 已檢查 | 每個請求依角色與資料範圍檢查，不依賴 ID 難以猜到（§4.3） |
| SQL Injection | 已檢查 | 全部參數化查詢（§4.4） |
| 配對碼猜測與限流 | **已修正** | IPv6 改以 /64 網段計算，IPv4 對應的 IPv6 視為 IPv4（§4.5） |
| 輸入驗證 | **已修正** | 範圍欄位最多 200 字；MySQL 修改欄位清單改 MEDIUMTEXT；稽核摘要的姓名最多 200 字（§4.6） |
| 大量 JSON 請求 | **已修正** | 請求本體最多 511 層、資料內容最多 64 層，三種實作一致；極深的內容不再造成 500（§4.7） |
| 稽核日誌個資 | 已檢查 | 稽核紀錄不含駕駛人個資；歷史預設遮蔽，查看個資會留下稽核（§4.8） |
| 秘密資訊與日誌 | 已檢查 | 不記錄權杖、配對碼、設定碼與請求標頭（§4.9） |
| Cloudflare D1／PHP／Docker 一致性 | **已修正** | 相容性測試三種實作都通過；本次發現並修正 3 個不一致（§4.10） |

## 1. 網頁管理的登入

### 1.1 原本的狀況（1.0–1.1）

網頁管理以 `POST /pair` 取得與 App 相同的權杖，存在瀏覽器：勾選「記住這個瀏覽器」時是 localStorage，否則是 sessionStorage。

- 網頁上任何程式都讀得到權杖：只要出現一個 XSS（網頁管理會顯示 App 寫入的資料），權杖就能被帶到別處長期使用。
- 權杖 90 天、使用時延長，沒有上限。
- 不記住時關閉分頁就失去權杖，但主機上的裝置仍是有效的管理員達 90 天：它佔住「最後一位管理員」，主機管理者也無法用設定碼恢復。

### 1.2 修改：權杖只放在 HttpOnly Cookie

- `POST /web/login`（[`protocol.md`](protocol.md) §13.1）：以管理員的配對碼（或 §2 的設定碼）登入，回應**不含權杖**，權杖只在 `Set-Cookie`。
- Cookie：`HttpOnly`（程式讀不到）、`SameSite=Strict`（其他網站發出的請求不帶 Cookie）、`Path=<基底路徑>/api/v1`（頁面與其他路徑收不到）；
  HTTPS 時名稱是 `__Secure-fd_admin` 並加 `Secure`。HTTP 只在區域網路測試時使用（不加 Secure，才不會無法登入）。
- 不是管理員的配對碼不能登入網頁（`403 admin_only`），配對碼不會被用掉。
- App 不受影響：仍以 `Authorization: Bearer` 傳送權杖。請求同時有 Authorization 標頭時以標頭為準。

### 1.3 CSRF

改用 Cookie 後，瀏覽器會自動帶上 Cookie，所以以 Cookie 驗證的非 GET 請求都要通過：

1. `X-FleetDispatch-CSRF` 等於這次登入的 CSRF 權杖（由登入權杖以 SHA-256 推導，網頁以 `GET /session` 取得；推不回登入權杖）。
   自訂標頭讓其他網站的請求一定要先經過 CORS 預檢，而主機不回應 CORS，所以預檢失敗、請求不會送出。
2. `Sec-Fetch-Site` 有送時必須是 `same-origin`。
3. 有本體時 `Content-Type` 必須是 `application/json`（表單、純文字等「簡單請求」不能偽造 JSON）。

`POST /web/login`、`/web/upgrade` 還沒有 CSRF 權杖，只檢查 2、3 與標頭不是空的（防止別的網站讓瀏覽器登入攻擊者建立的工作階段）。
GET 不檢查：SameSite=Strict 讓跨站請求不帶 Cookie，回應也讀不到。不通過時 `403 csrf_failed`，不延長期限。

### 1.4 期限

| | 閒置 | 登入期限 | Cookie |
| --- | --- | --- | --- |
| 不記住這個瀏覽器 | 2 小時 | 12 小時 | 瀏覽器關閉時刪除 |
| 記住這個瀏覽器 | 30 天 | 90 天 | `Max-Age` 到登入期限 |

使用時延長閒置期限，最多每 5 分鐘寫入一次，不超過登入期限。App 的權杖維持 90 天、使用時延長（App 是個人裝置，期限太短會讓駕駛在路上被要求重新配對）。
登入期限快到時（3 天內），總覽會提醒先建立管理員配對碼或確認 App 也是管理員。

### 1.5 撤銷

- 登出（`POST /unpair`）解除這個瀏覽器的配對並刪除 Cookie；管理員在「裝置」解除配對後，那個瀏覽器的下一個請求就是 `401`。
- 角色改變立即生效（每個請求都重新讀取裝置）。
- 網頁的權杖放在 Authorization 標頭使用時回 `401`：期限與 CSRF 檢查只在 Cookie 的路徑，不能繞過。
- 1.1 的網頁權杖（`platform` 是 `web`、以 Authorization 傳送）不再延長，升級時最多再用 30 天（§1.6）。

### 1.6 舊登入的遷移

1. 1.2.0 的網頁管理開啟時，若瀏覽器還有 1.1 的權杖（localStorage 或 sessionStorage），以 `POST /web/upgrade` 換成 Cookie：
   同一台網頁裝置換新的權杖（裝置清單、建立資料的身分不變），舊權杖立即失效；「記住」與否沿用（localStorage 視為記住）。
2. 成功後刪除瀏覽器裡的權杖並提示「登入方式已更新」。
3. 舊權杖無效、過期或已轉換（`401`／`403`）時也刪除，並在登入頁說明要重新登入；網路錯誤時保留，下次再試。
4. 資料表升級到版本 3 時，1.1 的網頁權杖期限縮短為最多 30 天（不再延長），沒有再開啟網頁管理的瀏覽器裡的權杖會自然失效。

### 1.7 敏感操作重新驗證（評估）

主機沒有使用者帳號與密碼：管理員的身分就是一台配對的裝置，登入只用一次性的配對碼。要求「再輸入一次密碼」需要先引入新的長期憑證，
會改變產品的設計（App 與自架主機都沒有帳號），也會產生密碼遺失與重設的新問題。所以 1.2.0 **不實作**重新驗證，改以下列方式降低風險：

- 網頁登入的期限縮短（§1.4），公用電腦不記住時關閉瀏覽器即失效。
- 高風險操作要在畫面上明確確認：把裝置改為管理員、建立管理員配對碼、刪除資料（影響預覽並輸入車牌或名稱）、解除配對；修改資料要預覽差異並填原因。
- 修改與刪除都有修改前後歷史；配對、網頁登入、角色與綁定、解除配對、配對碼、主機名稱等管理操作都有稽核紀錄（[`audit-history.md`](audit-history.md) §3）。

日後若加入管理員帳號，應同時加入敏感操作的重新驗證（例如 15 分鐘內輸入過密碼）。

### 1.8 測試

- `conformance/web-session-suite.mjs`（三種實作）：CSRF 標頭、跨站、非 JSON、`admin_only` 且不用掉配對碼、Cookie 屬性、回應不含權杖、
  Cookie 驗證與 CSRF 權杖、Cookie 權杖不能放在 Authorization、Authorization 優先、裝置清單的 `webSession`、記住的 `Max-Age`、登出刪除 Cookie、
  1.1 權杖的轉換（同一台裝置、舊權杖失效、只能轉一次、App 的權杖不能轉）、解除配對後立即失效。
- `conformance/web-session-local.test.mjs`（Docker／Node、PHP＋SQLite；改暫存資料庫的時間）：延長不超過登入期限、5 分鐘內不重複寫入、過期 `401`、
  閒置 2 小時、1.1 網頁權杖不延長、App 權杖延長 90 天、§2 的恢復。
- `conformance/migration-*.test.mjs`：版本 1 → 3，1.1 網頁權杖的期限縮短為 30 天、App 的不變。
- `scripts/check-admin-ui.mjs`（瀏覽器）：Cookie 是 HttpOnly、SameSite=Strict、只送到 API；瀏覽器沒有保存權杖、`document.cookie` 讀不到；
  1.1 的登入自動轉換、無效的舊權杖被刪除、登出後沒有 Cookie。

## 2. 管理員的恢復與設定碼

「可以使用的管理員」是角色為管理員、沒有解除配對、權杖還沒過期的裝置。1.2.0 起：

- 沒有可以使用的管理員時設定碼有效（`info.setupRequired`）：第一次設定，或所有管理員的登入都已失效（例如只用網頁管理、超過期限沒有使用）。
  1.1 以「沒有解除配對」判斷，權杖過期的管理員仍佔住名額，只能由主機管理者以資料庫指令撤銷。網頁登入改成較短的期限後，
  若不調整就會讓只用網頁管理的主機在到期後無法再管理。
- 以設定碼配對的檢查與寫入是同一個不可分割的操作：同時送出的兩個設定碼請求只有一個成功（PHP 原本就在交易中，1.2.0 的 TypeScript 版改為條件式寫入）。
- 降級、解除配對時「其他管理員」也只算可以使用的管理員，避免把最後一位能用的管理員解除。
- 設定碼是主機的恢復憑證：至少 16 個字元、與配對碼共用嘗試次數限制、以常數時間比對、不寫入日誌。請放在密碼管理器；
  懷疑外洩時更換（Docker：`FD_SETUP_TOKEN`；Cloudflare：`wrangler secret put FD_SETUP_TOKEN`；PHP：`config.php` 的 `setup_token`）。

## 3. 備份與還原

- 備份檔（SQLite 檔、`mysqldump`、`wrangler d1 export`）含全部資料：駕駛人個資、車趟位置、修改前後歷史。請當成機密保存，不要放在網站可以下載的位置
  （Docker 的備份在資料卷內；PHP＋SQLite 的資料夾有禁止存取的設定）。
- 權杖只存 SHA-256：32 位元組的隨機權杖無法從雜湊還原。配對碼只有 8 個字元（約 40 位元），雜湊**可以被離線暴力破解**；
  所以配對碼有效期短（預設 24 小時、最多 7 天）、只能用一次。備份檔外流時，刪除所有還沒使用的配對碼。
- 還原會讓資料回到備份當時：備份之後解除配對的裝置、用掉的配對碼都會恢復。還原後請在「裝置」解除不該存在的配對、刪除還沒使用的配對碼；
  若管理員裝置也回到過去的狀態，可以照部署文件撤銷所有管理員後以設定碼恢復。
- 資料表遷移前的自動備份與各實作的備份方式見 [`migration.md`](migration.md)。

## 4. 其他檢查項目

### 4.1 XSS

- 網頁管理只用 `createElement`、`textContent`、`setAttribute` 建立畫面；沒有 `innerHTML`、`insertAdjacentHTML`、`document.write`、`eval`、`new Function`。
- 由資料產生的連結：資料詳情的網址以 `encodeURIComponent` 組成；地圖連結是固定的 `https://www.openstreetmap.org/` 加數字座標；簽名圖片固定以
  `data:image/png;base64,` 開頭（不會變成 `javascript:`）。
- 主機產生的 HTML 只填入基底路徑與管理網址（只允許英數字與 `. _ ~ -`，並做 HTML 跳脫）；首頁沒有程式、不含請求的內容。
- API 回應是 `application/json` 加 `X-Content-Type-Options: nosniff`，瀏覽器不會當成 HTML。
- CSV 匯出：以 `=`、`+`、`-`、`@`、Tab、CR 開頭且不是數字的內容前面加 `'`（[`reports.md`](reports.md)）。

### 4.2 CSP 與安全標頭

- 管理頁：`default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`，
  加上 `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`、`Cache-Control: no-store`。
  程式只能是同一個來源的 `app.js`，沒有內嵌程式、不能 `eval`；資料只送回同一個主機。
- 1.2.0 新增：`Cross-Origin-Opener-Policy: same-origin`（其他網站開啟的視窗拿不到管理頁的參照）、`Cross-Origin-Resource-Policy: same-origin`
  （其他網站不能載入管理頁與程式）、`Permissions-Policy`（關閉相機、麥克風、定位、付款、USB）。
- `style-src 'unsafe-inline'`：網頁管理是單一 HTML 檔，樣式寫在頁面裡，少數元素以 style 屬性設定寬度。CSS 注入需要先能插入標記，
  而畫面上沒有插入標記的地方（§4.1），所以保留；日後拆出樣式檔時改為 `style-src 'self'`。
- HSTS：主機本身不送（Docker 版在區域網路測試時是 HTTP）。對外使用時請在 TLS 終點（反向代理、Cloudflare）設定 HSTS；`*.workers.dev` 屬於 HSTS 預載的 `.dev` 網域，瀏覽器一律使用 HTTPS。

### 4.3 API 權限、IDOR、權限提升

- `admin/*` 在進入各端點之前統一檢查角色是管理員；駕駛與檢視者呼叫時 `403 forbidden`（相容性測試）。
- 駕駛讀取的資料依綁定的駕駛人或建立的身分過濾（自己的車趟、申請、巡檢）；寫入逐筆授權：只能改自己的車趟、不能改派、不能刪除、
  用車申請只能送出與取消；檢視者只能讀；即時位置：駕駛只看得到自己範圍內的車趟，只能回報自己進行中的車趟。
- 授權依每筆資料的擁有者與角色判斷，不依賴 UUID 難以猜到；網頁管理的資料 API 只有管理員能用。
- 角色只能由管理員建立的配對碼或管理員修改；事件不能改裝置與角色；同一個裝置 ID 重新配對會產生新的身分，不繼承之前資料的擁有權；
  設定碼只在沒有可以使用的管理員時有效（§2）；網頁登入只接受管理員的配對碼。
- 裝置只能解除自己的配對（`POST /unpair`），解除其他裝置要管理員；最後一位可以使用的管理員受保護（不可分割的條件式寫入）。

### 4.4 SQL Injection

三種實作的 SQL 全部使用參數（D1／node:sqlite 的 `?`、PDO 的預備敘述）。動態組成的部分只有程式裡的常數（欄位清單、`?` 的個數、固定的條件），
沒有把請求的內容組進 SQL。PHP 的 MySQL 連線使用嚴格模式（`STRICT_TRANS_TABLES`），超過欄位長度時是錯誤而不是被截斷。

### 4.5 配對碼猜測與限流

- 配對碼：8 個字元、31 個字母（約 40 位元），只能用一次，預設 24 小時、最多 7 天，只存 SHA-256；設定碼以常數時間比對。
- 嘗試次數：同一個來源 15 分鐘內失敗 10 次後 `429`，`POST /pair` 與 `POST /web/login` 共用；失敗紀錄 24 小時後刪除。
  `X-Forwarded-For` 只採用設定為信任的反向代理附加的值；Cloudflare 用 `CF-Connecting-IP`。
- **1.2.0 修正**：IPv6 原本以完整位址計算，一般使用者有整個 /64 網段（2⁶⁴ 個位址）可以輪流使用，限制形同虛設。改為以 /64 網段計算；
  IPv4 對應的 IPv6（`::ffff:a.b.c.d`）視為 IPv4（`core/src/util.ts`、`php/src/Util.php` 的 `rateLimitKey`，兩者以相同的測試值比對）。
  測試：`conformance/rate-limit-local.test.mjs`（Docker／Node、PHP；以信任的反向代理模擬不同來源）。
- 估計：單一來源一天最多約 960 次嘗試；同時有 10 組有效的配對碼時，一天猜中的機率約 10⁻⁸。不另外加全主機的總次數限制，
  因為攻擊者可以用它讓所有正常的配對都被擋住。建議配對碼的期限設短、不用的配對碼刪除。
- 次數的檢查與記錄不是同一個交易：同時送出的請求可能比 10 次多幾次，影響可以忽略。

### 4.6 輸入驗證

- 請求：本體最多 5 MB、每次最多 500 筆事件、每筆內容最多 1 MB；裝置與主機名稱 1–100 字、綁定的駕駛姓名最多 200 字、配對碼標籤最多 100 字、
  修改原因最多 500 字、事件 ID 最多 100 字（冪等）；查詢的 `limit` 都有上限；報表期間最多 400 天。網頁管理的修改依資料規格逐欄檢查型別與範圍。
- **1.2.0 修正**：
  - 範圍欄位（車牌、駕駛姓名、駕駛人 UUID、申請的裝置）另外存在資料表的欄位。原本沒有長度限制：超過 64 KB 時 MySQL（TEXT）寫入失敗回 `500`，
    SQLite 卻照常保存。改為最多 200 字，超過時事件以 `invalid-payload` 拒絕（三種實作相同）。
  - MySQL 的 `fd_record_history.changed_fields` 是 TEXT：欄位很多的內容（例如 8,000 個欄位）在 MySQL 寫入失敗。改為 MEDIUMTEXT（資料表版本 3）。
  - 稽核紀錄的駕駛人摘要只留姓名：姓名很長時超過 TEXT，改為最多 200 字。
- 其他欄位與資料庫的長度相符（MySQL `VARCHAR` 以字元計）：名稱 255、平台 64、配對碼標籤 255、原因 500、事件 ID 100、UUID 36；
  內容與修改前後的完整資料是 LONGTEXT。測試：`conformance/api.test.mjs`「1.2.0 輸入限制」（MySQL 由 CI 執行）。

### 4.7 大量與很深的 JSON

- 大小：Docker 版邊讀邊計算，超過 5 MB 立即 `413`；PHP 最多讀上限加 1 個位元組；Workers 先檢查 `Content-Length` 再檢查實際大小。
- **1.2.0 修正**：PHP 的 `json_decode` 最多 512 層，TypeScript 的 `JSON.parse` 沒有限制，同一份內容在兩邊的結果不同；
  而且 TypeScript 版收到 10 萬層的內容時之後的處理耗盡堆疊，回 `500`。改為：
  - 請求本體最多 511 層陣列或物件（與 PHP 相同），超過時 `400 invalid_request`；
  - App 送來的資料內容最多 64 層（App 的資料只有 3–4 層），超過時 `invalid-payload`。回應會把內容放進幾層外框再編碼，
    這個上限讓 PHP 的 `json_encode`（512 層）也能完整回傳快照、清單與修改前後歷史。
  - TypeScript 以逐字掃描計算層數（不遞迴）；已經保存的舊資料照常讀取。
- 測試：`conformance/api.test.mjs`「1.2.0 輸入限制」：本體 600 層 `400`；內容 64 層保存並能從管理詳情與歷史完整讀回、65 層與 10 萬層拒絕。

### 4.8 稽核日誌與個資

- 稽核紀錄的駕駛人摘要只有 UUID 與姓名（1.0–1.1 的舊摘要在升級時清除）；修改前後歷史保存完整內容（追查修改需要），
  API 預設遮蔽駕駛人的證號、電話、備註，`pii=1` 才顯示，並在稽核紀錄留下「檢視個資」（[`audit-history.md`](audit-history.md)）。
- 裝置名稱由使用者輸入（可能含人名），只有管理員看得到。來源 IP 只存在配對失敗的紀錄（24 小時後刪除）；即時位置在回車或 30 分鐘沒有回報後移除。
- 修改前後歷史預設不自動刪除；可以設定保留天數（至少 30 天），較舊的歷史自動刪除（[`audit-history.md`](audit-history.md) §4）。
- 管理操作（配對、網頁登入、角色、配對碼、主機名稱）的稽核摘要不含權杖、配對碼本身與駕駛人的個資（[`audit-history.md`](audit-history.md) §3）。

### 4.9 秘密資訊與日誌

- Docker 版的請求日誌只記時間、方法、路徑（不含查詢字串）、狀態與耗時，不記任何標頭（`Authorization`、`Cookie`）。
- 未預期的錯誤：Docker／Workers 記錄例外（D1 與 SQLite 的錯誤訊息不含參數的值）；PHP 只記類別、訊息、檔名與行號，不記堆疊（參數可能含權杖或密碼），
  資料庫連線失敗的細節只寫日誌，不回給用戶端。
- 權杖與配對碼只存 SHA-256；網頁登入的回應不含權杖。設定碼：Docker 自動產生時存在資料夾的 `setup-token.txt`（日誌只寫路徑）、
  Cloudflare 是 Worker 的機密、PHP 是 `config.php`（權限 0600；`src/`、`web/`、`schema/` 有禁止存取的設定；安裝金鑰檔在安裝完成後刪除）。
- 瀏覽器實測的輸出不印出 Cookie 的值；相容性測試只對本機新建的主機執行，失敗訊息裡的權杖是測試主機的。

### 4.10 Cloudflare D1／PHP／Docker 一致性

- 同一份協定與同一套相容性測試（`conformance/`）：Docker／Node、PHP＋SQLite、Workers（wrangler 本機 D1）在本機各 57 項通過、1 項依設計略過；
  PHP＋MySQL 由 CI 執行。
- 本次發現並修正的不一致：JSON 層數（§4.7）、超長範圍欄位與欄位很多的內容在 MySQL 失敗（§4.6）、以設定碼配對的並行檢查（TypeScript 版不是同一個操作，§2）。
- 依部署環境而不同、已在文件說明的部分：來源 IP（`CF-Connecting-IP`／信任的 `X-Forwarded-For`）、是否為 HTTPS（網址或 `X-Forwarded-Proto`）、
  升級前的自動備份（Docker 與 PHP＋SQLite 有；MySQL 與 D1 由管理者備份）。
