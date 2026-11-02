# FleetDispatch Server API v1

FleetDispatch App（8.0 起）可以改連使用者自行架設的主機。這份文件是三種主機實作（Cloudflare Worker＋D1、PHP＋MySQL、Docker）與 App 之間的共同規格；實作之間的行為必須一致，`conformance/` 的測試會逐項檢查。

- 傳輸：HTTPS，JSON（UTF-8）。所有端點在 `<基底網址>/api/v1/` 之下；基底網址可以含路徑（例如 `https://example.com/fleet`）。
  PHP 主機無法設定網址改寫時，也接受 `<基底網址>/index.php/api/v1/…`。
- 版本：`/api/v1` 與 `GET /info` 的 `apiVersion: 1`。不相容的變更才會出 v2；新增欄位一律選填，用戶端必須忽略不認得的欄位。
- 時間：API 外層的時間（`time`、`expiresAt`…）是 **1970 起算的毫秒整數**。資料內容（車趟、車輛…）沿用 App 的資料格式：
  **2001-01-01 UTC 起算的秒數（浮點數）**，下文稱「Apple 秒」。
- UUID：8-4-4-4-12 的十六進位，主機一律轉成大寫儲存與比對。

## 1. 資料模型

主機保存 10 種資料，每一筆以「種類＋UUID」識別：

| 種類（`entity`） | 內容 | 主機需要讀的欄位 |
| --- | --- | --- |
| `vehicle` | 車輛 | `entityUUID`、`plateNumber`、`lastModifiedAt` |
| `driver` | 駕駛人 | `entityUUID`、`name`、`licenseNumber`、`phoneNumber`、`notes`、`licenseExpiryDate`、`lastModifiedAt` |
| `trip` | 車趟 | `entityUUID`、`driverEntityUUID`、`driver`、`vehiclePlateNumber`、`isCompleted`、`lastModifiedAt` |
| `tripRequest` | 用車申請 | `entityUUID`、`requestedByDeviceID`、`status`、`approvedAt`、`approvedBy`、`rejectionReason`、`resultingTripUUID`、`lastModifiedAt` |
| `maintenance` | 保養紀錄 | `entityUUID`、`vehiclePlateNumber`、`lastModifiedAt` |
| `maintenanceItem` | 保養項目 | `entityUUID`、`vehiclePlateNumber`、`lastModifiedAt` |
| `preset` | 派車預設值 | `entityUUID`、`lastModifiedAt` |
| `part` | 零件 | `entityUUID`、`lastModifiedAt` |
| `workOrder` | 工單 | `entityUUID`、`vehiclePlateNumber`、`lastModifiedAt` |
| `inspection` | 巡檢 | `entityUUID`、`driverName`、`vehiclePlateNumber`、`lastModifiedAt` |

- 資料內容（payload）是 App 送來的 JSON 物件，主機**原樣保存**，只讀上表的欄位，不得增刪其他欄位（遮蔽與時間校正除外，見 §4、§5）。
  主機不需要知道其他欄位的意義。
- 每筆資料有一個**變更序號** `seq`：全主機單調遞增的整數，資料每次被寫入或刪除就取得新的序號。用戶端以序號作為增量同步的游標。
- 刪除保留為**墓碑**（`deleted = true`、沒有內容），讓離線的用戶端也收得到刪除。墓碑保留查詢範圍用的欄位（駕駛人、申請裝置、車牌）。
- 主機另存：裝置（§3）、配對碼（§3）、稽核紀錄（§7）、即時位置（§8）、伺服器資訊（ID、名稱）。

## 2. 角色與權限

| 角色 | 說明 |
| --- | --- |
| `admin` 管理員 | 全部資料可讀寫；管理裝置與配對碼；核准用車申請 |
| `driver` 駕駛 | 建立車趟、修改自己的車趟、送出巡檢與用車申請；只收到自己的資料（§5） |
| `viewer` 檢視者 | 唯讀；收到全部車趟，但駕駛人個資被遮蔽 |

駕駛裝置可以由管理員**綁定駕駛人**（`driverBinding: {driverUuid, driverName}`，`driverName` 不能是空字串）。綁定後，主機以它判斷「自己的」車趟與巡檢；
尚未綁定的駕駛裝置收不到任何車趟（預設拒絕），但仍可建立車趟。

### 2.1 寫入授權（每一筆事件）

以「主機上現存的版本」與「送出者的裝置」為準：

| 種類 | 建立 `create` | 修改 `update` | 刪除 `delete` |
| --- | --- | --- | --- |
| `trip` | admin；driver（已綁定時只能建立自己的車趟，`not-own-trip`） | admin：任何車趟。driver 已綁定：修改前（主機現存版本）與修改後都必須是自己的車趟；未綁定：只能修改這台裝置建立的車趟（`not-own-trip`） | admin |
| `vehicle`、`driver`、`maintenance`、`maintenanceItem`、`preset`、`part`、`workOrder` | admin | admin | admin |
| `inspection` | admin；driver（已綁定時 `driverName` 必須是綁定的駕駛人，`not-own-inspection`） | admin。driver 已綁定：修改前與修改後的 `driverName` 都必須是綁定的駕駛人；未綁定：只能修改這台裝置建立的巡檢（`not-own-inspection`） | admin |
| `tripRequest` | 見下 | 見下 | admin |

「自己的車趟」：payload 有 `driverEntityUUID` 時比對綁定的 `driverUuid`（不分大小寫）；沒有時比對 `driver` 與綁定的 `driverName`（完全相同、且名稱不是空字串）。

主機的寫入是「有就更新、沒有就建立」：**主機上已有這筆（包含墓碑）時，不論事件標示 `create` 或 `update`，一律依「修改」的規則檢查**，
不能用 `create` 覆寫或復活別人的資料（墓碑保留查詢欄位與建立者）。每筆資料記錄建立它的**配對身分**（`created_by`，見 §3.5；墓碑被重新建立時改為新的建立者）。
駕駛的用車申請：主機上已有這筆（包含墓碑）時不能再建立（`request-already-exists`）。

用車申請（`tripRequest`）：
- admin：建立、修改（核准、退回）、刪除都允許。
- driver 建立：主機上不能已有同一筆（`request-already-exists`）；`status` 必須是 `pending`（`create-must-be-pending`）；
  `approvedAt` 必須沒有、`approvedBy`／`rejectionReason`／`resultingTripUUID` 必須沒有或是空字串（`approval-fields-not-allowed`）；
  `requestedByDeviceID` 必須是送出者自己的裝置 ID（`requester-mismatch`，不分大小寫）。
- driver 修改：主機上必須已有（`request-not-found`）；這筆申請必須是送出者這次配對建立的（`created_by` 等於送出者的配對身分），且新的 `requestedByDeviceID` 不能改變（`not-own-request`）；
  現存狀態必須是 `pending`（`request-not-pending`）；新狀態只能是 `pending` 或 `cancelled`（`status-transition-not-allowed`）；不得帶核准欄位（同上）。
- viewer：一律拒絕（`role`）。

不允許時事件被拒絕（§4 的 `rejected`），原因碼如上，其餘情況用 `role`。

## 3. 裝置、配對與權杖

### 3.1 第一次設定（第一位管理員）

部署時必須設定**設定碼**（setup token，至少 16 個字元；各實作的設定方式見部署文件）。主機上沒有任何有效的管理員裝置時，
`POST /pair` 接受設定碼，配對的裝置成為管理員。之後設定碼不再有效；要恢復（例如管理員裝置遺失），由主機管理者依部署文件撤銷所有管理員後，設定碼重新生效。
第一位管理員也可以是網頁管理的瀏覽器（§13）。

### 3.2 配對碼

管理員建立配對碼（`POST /admin/pairing-codes`），指定角色與（駕駛）綁定的駕駛人。配對碼：
- 8 個字元，字母表 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（排除易混淆的 0、1、I、L、O），顯示為 `XXXX-XXXX`；比對時忽略大小寫、空白與連字號。
- 只存 SHA-256；**單次有效**；有效期限預設 24 小時（`ttlMinutes` 5–10080）。
- 用掉或過期後不能再用；管理員可以提前刪除。

### 3.3 權杖

- 配對成功時發給 32 位元組的隨機權杖（base64url，無 padding），主機只存 SHA-256（十六進位小寫），以常數時間比對。
- 有效期限 90 天，**使用時自動延長**（為了減少寫入，同一台裝置最多每小時更新一次 `lastSeenAt` 與期限）。
- 權杖失效（過期、裝置被解除配對、未知）→ `401 unauthorized`，用戶端必須重新配對。
- 同一個 `deviceId` 仍有有效權杖時，新的配對被拒絕（`409 device_conflict`）；要由管理員先解除配對，或由該裝置自己 `POST /unpair`。

### 3.4 嘗試次數限制

同一個來源 IP 在 15 分鐘內配對失敗 10 次後，該 IP 的 `POST /pair` 回 `429 rate_limited`（`Retry-After` 秒數），直到最早一次失敗滿 15 分鐘。
成功的配對不計入。

來源 IP：Cloudflare 版用 `CF-Connecting-IP`；Docker 與 PHP 版預設用連線的位址，設定了信任的反向代理層數 N（≥ 1）時，
取 `X-Forwarded-For` 從右邊數來第 N 個值（最左邊的值由用戶端自己填，可以偽造，不得使用）。

### 3.5 配對身分

`deviceId` 由用戶端自己提供。主機在**每次配對**（包括同一個 `deviceId` 在權杖失效或解除配對後重新配對）都產生新的內部身分，
建立資料的擁有權（`created_by`：未綁定駕駛人的駕駛能修改的車趟與巡檢、駕駛看得到與能修改的用車申請）以這個身分為準。
所以重新配對的裝置**不會繼承**之前配對時建立的資料的擁有權；這些資料仍由管理員處理。

## 4. 寫入：事件

`POST /api/v1/events`（需要權杖）

```json
{ "events": [ SyncEvent, … ] }
```

`SyncEvent` 與 App 區網同步的事件相同：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `id` | 字串 | 事件 UUID（只用於回應中對應結果） |
| `timestamp` | 數字 | 事件時間（Apple 秒）；最後寫入者勝的比較依據 |
| `actor` | 字串 | 送出者名稱（顯示用，主機不採信，以權杖的裝置為準） |
| `entity` | 字串 | §1 的種類 |
| `operation` | 字串 | `create`、`update`、`delete` |
| `entityID` | 字串 | 資料的 UUID |
| `payloadJSON` | 字串 | 資料內容的 **JSON 字串**；刪除時可以是空字串 |

限制：每次最多 500 筆、請求本體最多 5 MB、單筆內容最多 1 MB；超過回 `413 payload_too_large` 或 `400 invalid_request`。

處理順序（逐筆、依陣列順序，每一筆自成一個交易）：

1. **格式**：種類、操作、UUID 不合法，或建立／修改的內容不是 JSON 物件、`entityUUID` 與 `entityID` 不同（不分大小寫）、`lastModifiedAt` 不是數字 →
   `rejected`（`invalid-payload`）。
2. **授權**：§2.1。不允許 → `rejected`（原因碼）。
3. **時間校正**：建立／修改時，`timestamp` 或內容的 `lastModifiedAt` 晚於主機現在時間，兩者都改成主機現在時間（Apple 秒），
   並在結果附上校正後的事件（`event`），送出者必須套用它。
4. **最後寫入者勝**：
   - 建立／修改：主機上沒有這筆、或 `timestamp` **嚴格大於**現存的 `lastModifiedAt`（墓碑是刪除的時間）才寫入；否則 `ignored`。
     比刪除更舊的修改不會讓資料復活。
     寫入時保存內容、`lastModifiedAt`（取自內容）、查詢欄位，取得新的序號。
   - 刪除：主機上有這筆（不是墓碑）就改為墓碑並取得新的序號；沒有就 `ignored`。
5. **連鎖刪除**：刪除車輛時，車牌（`vehiclePlateNumber`）等於該車輛 `plateNumber` 的 `trip`、`maintenance`、`maintenanceItem`、`workOrder`、`inspection`
   一併改為墓碑（各自取得新的序號）。刪除車趟或車趟改為已完成（`isCompleted: true`）時，移除它的即時位置。
6. **稽核紀錄**：寫入或刪除成功時記一筆（§7）。

回應 `200`：

```json
{
  "results": [
    { "id": "事件 UUID", "status": "applied" },
    { "id": "…", "status": "applied", "event": { 校正後的 SyncEvent } },
    { "id": "…", "status": "ignored" },
    { "id": "…", "status": "rejected", "reason": "not-own-trip" }
  ],
  "cursor": 1234
}
```

- `cursor` 是處理完後主機目前的最大序號。
- 用戶端收到 `rejected` 時，應提示使用者並以全量同步（§6）回復成主機的狀態。

## 5. 讀取範圍與遮蔽

全量同步與增量同步都依送出者的角色過濾（墓碑依它保留的查詢欄位過濾）：

- **admin**：全部。
- **viewer**：全部；`driver` 遮蔽個資。
- **driver**：
  - `trip`：只有自己的車趟（§2.1 的定義；未綁定時沒有）。
  - `tripRequest`：只有這次配對建立的（`created_by` 等於配對身分，見 §3.5）。
  - `inspection`：只有 `driverName` 等於綁定駕駛人名稱的（未綁定或名稱是空字串時沒有）。
  - `driver`：綁定的那一位完整，其他人遮蔽。
  - 其他種類：全部。

**遮蔽**駕駛人：`licenseNumber`、`phoneNumber`、`notes` 改為空字串，移除 `licenseExpiryDate`，其他欄位不變。

## 6. 讀取：全量與增量

### 6.1 全量 `GET /api/v1/snapshot`

```json
{
  "cursor": 1234,
  "snapshot": {
    "trips": [ … ], "vehicles": [ … ], "drivers": [ … ], "tripRequests": [ … ],
    "maintenanceRecords": [ … ], "maintenanceItems": [ … ], "presets": [ … ],
    "parts": [ … ], "workOrders": [ … ], "inspections": [ … ],
    "authoritative": true
  },
  "session": { Session }
}
```

- 十個陣列一定都要有（可以是空陣列），內容是資料物件（不是字串），不含墓碑。
- `cursor` 必須在讀取資料**之前**取得：快照之後的變更一定會出現在 `GET /changes?since=cursor`（可能重複，用戶端以最後寫入者勝處理）。
- `authoritative: true`：用戶端依自己的規則移除主機沒有的資料（App 已有的規則：待送的、剛送出的、5 分鐘內修改的不移除；異常的大量移除不執行）。

### 6.2 增量 `GET /api/v1/changes?since=<序號>&limit=<筆數>`

- `since` 預設 0；`limit` 預設 500、最多 1000。依序號遞增回傳序號大於 `since` 的資料（同一筆資料只會出現最新的狀態）。

```json
{
  "changes": [
    { "seq": 1235, "entity": "trip", "id": "UUID", "deleted": false, "modifiedAt": 815000000.5, "payload": { … } },
    { "seq": 1236, "entity": "part", "id": "UUID", "deleted": true, "modifiedAt": 815000100.0, "payload": null }
  ],
  "cursor": 1236,
  "hasMore": false,
  "session": { Session }
}
```

- `cursor`：這一頁最後一筆的序號；沒有資料時等於 `since`（若 `since` 大於主機的最大序號，回主機的最大序號）。
- `hasMore: true` 時用戶端應立即以新的游標再取一次。
- 範圍外的資料不回傳，但游標照常前進。
- `modifiedAt`：資料內容的 `lastModifiedAt`；墓碑是刪除事件的時間（Apple 秒，經時間校正）。
- 用戶端套用：資料以最後寫入者勝（`modifiedAt` 嚴格大於本機才覆寫）；墓碑刪除本機資料（含 App 的連鎖刪除）。

### 6.3 Session

`GET /api/v1/session` 以及快照、增量回應中的 `session`：

```json
{
  "deviceId": "UUID", "deviceName": "王小明的 iPhone", "role": "driver",
  "driverBinding": { "driverUuid": "UUID", "driverName": "王小明" },
  "server": { "id": "UUID", "name": "優良運輸", "time": 1793616000000 },
  "tokenExpiresAt": 1801392000000
}
```

`driverBinding` 沒有時是 `null`。角色或綁定被管理員改變時，用戶端在下一次回應就會看到；角色改變後應做一次全量同步（資料範圍不同）。

## 7. 管理（admin）

| 端點 | 說明 |
| --- | --- |
| `GET /admin/devices` | `{ "devices": [ Device ] }`，含已解除配對的（`revokedAt` 不是 null） |
| `PATCH /admin/devices/{deviceId}` | `{ "role"?, "driverBinding"? }`（`driverBinding: null` 清除；只有駕駛能綁定；`driverName` 不能是空字串）→ `Device` |
| `DELETE /admin/devices/{deviceId}` | 解除配對（權杖立即失效）→ `204` |
| `POST /admin/pairing-codes` | `{ "role", "driverBinding"?, "ttlMinutes"?, "label"? }` → `{ "id", "code": "ABCD-EFGH", "role", "driverBinding", "label", "expiresAt" }`（`code` 只在這次回應出現） |
| `GET /admin/pairing-codes` | 尚未使用、未過期的配對碼 `{ "codes": [ { "id", "label", "role", "driverBinding", "createdAt", "expiresAt" } ] }` |
| `DELETE /admin/pairing-codes/{id}` | 刪除 → `204` |
| `PATCH /admin/server` | `{ "name" }`（1–100 字元）→ `Info`（§9） |
| `GET /admin/audit?before=<id>&limit=<筆數>` | 稽核紀錄，新的在前：`{ "entries": [ { "id", "at", "deviceId", "deviceName", "entity", "entityId", "operation", "summary" } ], "next": <id 或 null> }`；`limit` 預設 100、最多 500 |

`Device`：`{ "deviceId", "name", "platform", "role", "driverBinding", "pairedAt", "lastSeenAt", "tokenExpiresAt", "revokedAt" }`（時間為毫秒，沒有時 `null`）。

限制：最後一位有效的管理員不能被降級或解除配對（`409 last_admin`）。

稽核紀錄的 `summary`：資料內容 JSON 的前 2,000 個字元（刪除時是空字串）；`operation` 是 `create`、`update`、`delete`；連鎖刪除也各記一筆。

## 8. 即時位置

- `POST /api/v1/locations`（admin、driver）：`{ "tripUUID", "latitude", "longitude", "timestamp"（Apple 秒）, "speed"?, "course"? }` → `204`。
  車趟必須存在、未完成，且在送出者的讀取範圍內（駕駛只能回報自己的車趟），否則 `403 forbidden`。速度、方向為負數時視為沒有。
- `GET /api/v1/locations`：`{ "locations": [ { "tripUUID", "deviceId", "deviceName", "plateNumber", "latitude", "longitude", "speed", "course", "timestamp", "stale" } ] }`，
  依讀取範圍過濾；`stale`：超過 300 秒沒有更新。
- 主機只保留每趟最新的一筆；30 分鐘沒有更新、車趟完成或刪除時移除。

## 9. 其他端點

### `GET /api/v1/info`（不需權杖）

```json
{
  "product": "FleetDispatch Server", "apiVersion": 1, "serverVersion": "1.0.0", "variant": "docker",
  "serverId": "UUID", "name": "優良運輸", "time": 1793616000000,
  "setupRequired": false, "setupConfigured": true,
  "features": ["liveLocations", "audit"],
  "limits": { "maxEventsPerRequest": 500, "maxBodyBytes": 5242880 }
}
```

- `variant`：`cloudflare`、`php`、`docker`。
- `setupRequired`：沒有任何有效的管理員（下一次配對要用設定碼）。`setupConfigured`：部署時有設定設定碼。
- App 驗證主機時先呼叫這個端點：`product` 必須是 `FleetDispatch Server`、`apiVersion` 必須是 1。

### `POST /api/v1/pair`（不需權杖）

```json
{ "code": "ABCD-EFGH 或設定碼", "deviceId": "UUID", "deviceName": "王小明的 iPhone", "platform": "ios" }
```

→ `200`：

```json
{ "token": "…", "deviceId": "UUID", "role": "driver", "driverBinding": null,
  "server": { "id": "UUID", "name": "優良運輸", "time": 1793616000000 }, "tokenExpiresAt": 1801392000000 }
```

錯誤：`401 invalid_code`（配對碼錯誤、用過或過期；設定碼錯誤）、`409 device_conflict`、`409 setup_not_configured`（沒有管理員也沒有設定碼）、`429 rate_limited`。
`deviceName` 1–100 字元，`platform` 是 `ios`、`ipados`、`macos`、`android` 或其他 20 字元以內的字串。

### `POST /api/v1/unpair`（需要權杖）

裝置自行解除配對（例如使用者改回單人或區網模式）→ `204`。最後一位管理員不能自行解除（`409 last_admin`）。

## 10. 錯誤

非 2xx 的回應一律是：

```json
{ "error": { "code": "invalid_request", "message": "說明文字" } }
```

| HTTP | `code` | 時機 |
| --- | --- | --- |
| 400 | `invalid_request` | 參數或 JSON 格式錯誤 |
| 401 | `unauthorized` | 沒有權杖、權杖無效或過期、裝置已解除配對 |
| 401 | `invalid_code` | 配對碼或設定碼錯誤、用過、過期 |
| 403 | `forbidden` | 角色不允許這個端點或操作 |
| 404 | `not_found` | 端點或資源不存在 |
| 405 | `method_not_allowed` | 方法不支援 |
| 409 | `device_conflict`、`last_admin`、`setup_not_configured` | 見上 |
| 413 | `payload_too_large` | 請求本體超過限制 |
| 429 | `rate_limited` | 配對嘗試太多次（附 `Retry-After`） |
| 500 | `server_error` | 主機內部錯誤（不得洩漏堆疊或 SQL） |

## 11. 安全要求（三種實作都必須遵守）

- 只在 HTTPS 上提供服務（Docker 版本身是 HTTP，必須放在反向代理後面；只在區域網路測試時例外）。App 拒絕 `http://`，私有網段（10/8、172.16/12、192.168/16、127/8、`.local`）在使用者確認後例外。
- 權杖、配對碼、設定碼只存雜湊或只放在部署的機密設定；不得寫入日誌。
- 所有 SQL 一律使用參數化查詢。
- 不回傳 `Access-Control-Allow-Origin`（App 是原生程式，不需要跨來源存取；避免網頁冒用）。
- 回應加上 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。
- 主機錯誤不得洩漏內部細節（堆疊、SQL、檔案路徑）。
- 網頁（§13）：管理頁只在設定的管理網址回應，首頁與管理頁都不把請求內容（基底路徑除外）填進頁面，並加上 §13 的安全標頭；`GET /info` 與首頁都不透露管理網址。

## 12. 用戶端行為（App）

- 連線：使用者輸入基底網址 → `GET /info` 驗證 → 輸入配對碼（第一次是設定碼）→ `POST /pair` → 保存權杖 → `GET /snapshot` 全量同步。
- 之後：本機寫入以事件送出（離線時放進離線佇列，連線後依序送出）；前景時每 15 秒、回到前景時、送出事件後以 `GET /changes` 取得增量；
  每 6 小時或角色改變時重做全量同步。
- 時鐘：以 `server.time` 換算偏移（超過 ±1 天不採用），用於事件時間。
- `401 unauthorized`：停止同步、提示重新配對；`429`：依 `Retry-After` 延後。

## 13. 網頁（1.1.0 起）：首頁與網頁管理

主機的網址也提供兩種網頁：**首頁**是 FleetDispatch App 的介紹與下載連結（任何人都看得到）；**網頁管理**只在一個設定的網址出現，
讓管理員用瀏覽器管理。網頁管理只使用本文件的 API，不需要額外的端點。

- **首頁**（只有 `GET`、`HEAD`）：基底路徑本身（`/`；PHP 是 `index.php` 所在的資料夾），以及 `…/index.php`、`…/index.html` 回 `200` 的 HTML。
  其他找不到的非 API 網址：`Accept` 有 `text/html`（瀏覽器）時回 `404` 狀態與同樣的首頁內容，否則照 API 的規則回 `404 not_found`（JSON）。
  首頁沒有程式、不含任何由請求產生的內容，也不透露管理網址；標頭：`Content-Type: text/html; charset=utf-8`、`Cache-Control: no-cache`、
  `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。
- **管理網址**：Cloudflare Workers 與 Docker 用環境變數 `FD_ADMIN_PATH`，PHP 用 `config.php` 的 `admin_path`；沒有設定時是 `/admin`，
  空字串或 `off` 關閉。格式：一或多段，每段只能有 `A–Z a–z 0–9 . _ ~ -`，不能是 `.`、`..`，第一段不能是 `api` 或 `index.php`，全長 100 字元以內；
  格式不正確時關閉網頁管理並寫入日誌（API 照常運作）。
- **路由**（只有 `GET`、`HEAD`）：
  - `<基底路徑><管理網址>`（可以有結尾的 `/`）：管理頁（HTML）。
  - `<基底路徑><管理網址>/app.js`：管理頁的程式。
  - 基底路徑是管理網址前面的部分（部署在子資料夾，或 PHP 沒有網址改寫時的 `/index.php`），只能由上面的路徑段組成，且不能含 `/api/v1`；
    不符合時視同其他路徑。
  - 管理網址的其他方法：照 API 的規則回 `404 not_found`（JSON）。
- **頁面內容**：HTML 的 `data-base`、`data-admin` 填入基底路徑與管理網址（HTML 跳脫），`<script src>` 指向 `<基底路徑><管理網址>/app.js`；
  沒有其他由請求產生的內容。首頁、管理頁與程式的原始檔在 `web/`，`scripts/build-web.mjs` 產生 `core/src/web-assets.ts`（TypeScript 實作）與 `php/web/`（PHP 實作）。
- **標頭**：管理頁 `Content-Type: text/html; charset=utf-8`，程式 `text/javascript; charset=utf-8`；兩者都有 `Cache-Control: no-store`、
  `X-Content-Type-Options: nosniff`、`X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`。管理頁另外有
  `X-Frame-Options: DENY` 與 `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。
- **登入**：瀏覽器以 `POST /pair` 配對（`platform: "web"`，每次登入產生新的 `deviceId`）：沒有管理員時用設定碼成為管理員，否則用管理員建立的配對碼；
  角色不是管理員時只能登出。權杖存在瀏覽器（勾選「記住這個瀏覽器」時是 localStorage，否則是 sessionStorage）；登出是 `POST /unpair`；
  `401` 時清除權杖並回到登入頁。最後一位管理員不能登出（`409 last_admin`），頁面會提示先建立另一位管理員。
- **相容性測試**：`conformance/web.test.mjs`（`FD_ADMIN_PATH` 與主機的設定相同）。

