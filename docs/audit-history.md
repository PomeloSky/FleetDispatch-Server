# 稽核紀錄與修改前後歷史

主機有兩種紀錄：

| | 稽核紀錄（`fd_audit`，1.0 起） | 修改前後歷史（`fd_record_history`，1.2.0 起） |
| --- | --- | --- |
| 內容 | 誰（裝置）在何時對哪筆資料做了什麼；內容摘要（前 2,000 字元；駕駛人只有 UUID 與姓名）。1.2.0 起也記錄管理操作（§3） | 修改前與修改後的完整內容、變更的欄位、來源、身分、原因、序號、版本、套用結果 |
| 用途 | 快速查看最近的操作 | 追查一筆資料的完整變化、還原時參考 |
| API | `GET /admin/audit` | `GET /admin/history?entity=&id=&outcome=&source=&pii=` |
| 誰能看 | 管理員 | 管理員 |

## 修改前後歷史的欄位

| 欄位 | 說明 |
| --- | --- |
| `at` | 主機時間（毫秒） |
| `entity`、`entity_id` | 資料的種類與 UUID |
| `event_id` | App 事件的 ID（連鎖刪除等沒有事件時為 null） |
| `operation` | `create`、`update`、`delete` |
| `source` | `app`（App 的事件）、`web`（網頁管理的修改、核准、退回、刪除）、`cascade`（刪除車輛的連鎖刪除）；`api` 保留 |
| `outcome` | `applied`（已寫入）；App 的事件沒有套用時：`rejected`（拒絕）、`conflict`（版本不同）、`ignored`（比主機上的版本舊而略過，或刪除已不存在的資料） |
| `actor_device`、`actor_identity`、`actor_name` | 寫入者的裝置 ID、這次配對的主機端身分、裝置名稱 |
| `before_json`、`after_json` | 修改前、修改後的內容（新增時沒有修改前，刪除時沒有修改後）。修改前的內容在寫入的同一個交易中讀取。沒有套用時是「主機上當時的內容」與「送來的內容」 |
| `changed_fields` | 變更的第一層欄位（不含 `lastModifiedAt`）；沒有套用時是送來的內容與主機上不同的欄位 |
| `reason` | 原因：網頁管理是管理員填的原因；連鎖刪除是 `vehicle-deleted`；沒有套用時是原因碼（`role`、`not-own-trip`、`revision-mismatch`、`stale`、`not-found`…） |
| `seq`、`revision` | 這次寫入取得的序號與資料的版本；沒有套用時是當時的序號與版本（沒有改變） |

規則：

- 與資料在同一個交易寫入：資料有改，歷史一定有（`outcome: applied`）。
- App 的事件沒有寫入（拒絕、衝突、最後寫入者勝略過）時留下一筆摘要（`outcome` 不是 `applied`），與冪等紀錄在同一個交易；
  格式錯誤、無法對應到資料的事件不留紀錄。
- 只新增、不修改：舊紀錄不會被覆寫。
- 重送同一個事件（冪等）不會產生第二筆。
- 版本比較：同一筆資料每一筆 `applied` 紀錄的修改後內容就是那個版本的完整內容，網頁管理以此比較任兩個版本。

## 個資

- 歷史保存完整的內容（還原、比較需要），駕駛人的證號、電話、備註也在其中，所以只給管理員查看；主機不把歷史送到 App。
- 查看時預設遮蔽駕駛人的電話、證號（只顯示最後 3 個字）與備註；`pii=1`（網頁的「顯示個資」）才顯示完整內容，並在稽核紀錄留下 `view-pii`。
- 稽核紀錄（一般的操作紀錄）不寫入駕駛人的個資：摘要只有 `{"entityUUID","name"}`。升級到 1.2.0（資料表版本 2）時，
  1.0–1.1 留下的駕駛人摘要會被清除（保留誰、何時、做了什麼）。

## 3. 管理操作的稽核（1.2.0）

除了資料的新增、修改、刪除與「查看個資」，稽核紀錄也記錄下列管理操作。`deviceId`、`deviceName` 是做這個操作的裝置
（配對、網頁登入、轉換、自行解除配對是那台裝置自己；其他是管理員）。摘要是 JSON，**不含權杖、配對碼本身與駕駛人的個資**。

| `entity` | `operation` | `entityId` | 摘要 |
| --- | --- | --- | --- |
| `device` | `pair` | 配對的裝置 | `role`、`platform`、`via`（`setup` 設定碼、`code` 配對碼）、`codeId`（用的是哪一組配對碼）、`driverBinding` |
| `device` | `web-login` | 網頁管理的裝置 | `via`、`codeId`、`remember`（記住這個瀏覽器） |
| `device` | `web-upgrade` | 網頁管理的裝置 | `remember`（1.1 存在瀏覽器的登入換成 Cookie） |
| `device` | `unpair` | 自己 | `role`、`web`（是不是網頁管理的登出） |
| `device` | `update` | 被修改的裝置 | `name`、`from`、`to`（各是 `role` 與 `driverBinding`；角色或綁定有變才記錄） |
| `device` | `revoke` | 被解除的裝置 | `name`、`role`、`platform` |
| `pairingCode` | `create` | 配對碼 ID | `role`、`driverBinding`、`label`、`expiresAt` |
| `pairingCode` | `delete` | 配對碼 ID | （空） |
| `server` | `rename` | 主機 ID | `from`、`to`（名稱有變才記錄） |

配對失敗不寫稽核紀錄（以嘗試次數限制處理，[`protocol.md`](protocol.md) §3.4）。網頁管理的「修改歷史與稽核 › 稽核紀錄」以中文顯示這些操作。
測試：`conformance/api.test.mjs`「1.2.0 管理操作的稽核」、`conformance/web-session-suite.mjs`（網頁登入、轉換、登出）。

## 4. 保留期限

預設不自動刪除修改前後歷史（車隊的資料量小，完整保存較安全）。依公司規定需要保留期限時（歷史含駕駛人的個資），設定保留天數：

| 實作 | 設定 |
| --- | --- |
| Docker | 環境變數 `FD_HISTORY_RETENTION_DAYS`（`compose.yaml`） |
| Cloudflare | `wrangler.toml` 的 `[vars]` › `FD_HISTORY_RETENTION_DAYS` |
| PHP | `config.php` 的 `history_retention_days` |

- 沒有設定、空字串或 `0`：不自動刪除。設定時至少 30 天（1–29 視為 30，避免誤設刪掉大量歷史）；不是整數時不刪除，並寫入日誌。
- 送出事件時檢查，最多每小時清一次（與已處理事件的清理一起）：刪除主機時間在保留天數之前的修改前後歷史。
- **稽核紀錄不刪除**（不含駕駛人的個資）；資料本身不受影響。`GET /admin/history` 回傳 `retentionDays`，網頁管理的修改歷史會顯示目前的設定。
- 刪除後無法復原；需要更久的紀錄時，刪除前先備份（[`migration.md`](migration.md)）。
- 測試：`conformance/history-retention-local.test.mjs`（Docker／Node、PHP＋SQLite；在暫存資料庫放入舊的歷史）。

也可以直接以 SQL 刪除較舊的紀錄，例如：

```sql
DELETE FROM fd_record_history WHERE at < <毫秒時間>;
```

已處理事件（`fd_processed_events`）自動保留 30 天。
