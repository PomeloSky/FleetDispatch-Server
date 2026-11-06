# 報表（1.2.0）

FleetDispatch App 的報表（PDF、CSV）在 App 內計算。1.2.0 起主機也提供報表的**查詢、計算與 CSV 匯出**，讓管理員在網頁管理查看期間摘要、
駕駛人與車輛的統計並下載 CSV。主機沒有保存 App 產生的報表檔；這裡的數字由主機依下列規則即時計算，與 App 的報表規則相同。

## 1. 計算規則（與 App 相同）

| 項目 | 規則 |
| --- | --- |
| 車趟 | 只算**已回車**的車趟；**出車時間**落在期間內（含開始、不含結束） |
| 里程 | 結束里程 − 起始里程，小於 0 時算 0 |
| 車趟費用 | 油資＋過路費＋停車費 |
| 保養、工單、巡檢 | 依保養日期、開單時間、巡檢時間落在期間內；只依車牌篩選（駕駛人與成本中心不適用） |
| 工單金額 | 明細的「數量 × 單價」合計（沒有數量時算 1） |
| 費用合計 | 車趟費用＋保養費用＋工單金額 |
| 每公里成本 | 費用合計 ÷ 里程（里程是 0 時沒有） |
| 稼動率 | 期間內有出車的「車日」÷（天數 × 車輛數）× 100。車日：已回車、與期間重疊的車趟經過的每一天（跨夜算兩天，期間開始前出車、跨入期間的那幾天也算）；天數只算到今天；車輛是目前的車輛（依車牌篩選），駕駛人與成本中心不影響稼動率 |
| 駕駛人 | 車趟有駕駛人 UUID 且駕駛人存在時用駕駛人資料的姓名，否則用車趟上的姓名；依駕駛人篩選以這個姓名比對 |
| 日期 | 依呼叫端給的時區（IANA 名稱，例如 `Asia/Taipei`）計算；網頁管理送出瀏覽器的時區 |

數字以「乘以 100、加 0.5、取整數、再除以 100」四捨五入到小數 2 位（三種實作相同）。

## 2. API

### `GET /api/v1/admin/reports/summary`

只有管理員。參數：`from`、`to`（1970 起算的毫秒，必填，最多 400 天）、`tz`（預設 `UTC`）、`plate`、`driverId`（駕駛人 UUID，轉成姓名比對）或 `driver`（姓名）、
`costCenter`（有給就篩選，空字串是「未指定」）。

```json
{
  "period": { "from": 1767196800000, "to": 1767888000000, "tz": "Asia/Taipei", "firstDay": "2026-01-01", "lastDay": "2026-01-08", "days": 8 },
  "filter": { "plate": null, "driver": null, "costCenter": null },
  "totals": {
    "trips": 3, "distance": 170, "fuel": 30, "fuelCost": 900, "tollCost": 40, "parkingCost": 60, "tripCost": 1000,
    "maintenanceCost": 1500, "workOrderCost": 800, "totalCost": 3300, "costPerKm": 19.41, "utilization": 31.25,
    "maintenanceCount": 1, "workOrderCount": 2, "inspectionCount": 2, "inspectionDefects": 1
  },
  "vehicles": [ { "plate": "RPT-A", "vehicleId": "UUID", "trips": 2, "distance": 170, "fuel": 30, "fuelCost": 900, "tollCost": 40,
                  "parkingCost": 60, "tripCost": 1000, "maintenanceCost": 1500, "workOrderCost": 800, "utilization": 37.5 } ],
  "drivers": [ { "name": "張三", "driverId": "UUID 或 null", "trips": 2, "distance": 170, … } ],
  "costCenters": [ { "costCenter": "", "trips": 2, … } ],
  "daily": [ { "date": "2026-01-02", "trips": 1, "distance": 50, … } ]
}
```

- `lastDay` 是期間最後一天與今天中較早的一天；`days` 是 `firstDay` 到 `lastDay` 的天數（至少 1）。
- `vehicles`：目前的車輛（依車牌篩選）與期間內車趟出現的車牌，依車牌排序（碼位順序）；已刪除車輛的車牌 `vehicleId`、`utilization` 是 `null`。
- `drivers`、`costCenters`、`daily` 依名稱、成本中心、日期排序（碼位順序）。`inspectionDefects`：結果不合格或有缺陷明細的巡檢數。

### `GET /api/v1/admin/reports/export?kind=<trips|maintenance|workOrders|inspections>&…`

只有管理員；參數同上。回應 `text/csv; charset=utf-8`，`Content-Disposition: attachment`（檔名 `FleetDispatch_<kind>_<第一天>_<最後一天>[_<車牌>].csv`，
另有 RFC 5987 的 UTF-8 檔名）。格式與 App 報表的 CSV 相同：

- UTF-8＋BOM、CRLF、第一列是欄位名稱（繁體中文）、日期 `YYYY-MM-DD`、時間 `HH:mm`（24 小時制，依 `tz`）；
- 數字不加千分位，整數不帶小數，其他最多 2 位；沒有值的費用、里程留空；
- 防公式注入：以 `=`、`+`、`-`、`@`、Tab、CR 開頭且不是數字的內容前面加 `'`；含逗號、雙引號、換行的內容加雙引號。

| kind | 欄位 |
| --- | --- |
| `trips` | 車號、日期、出車時間、回程時間、起始碼錶、結束碼錶、里程、起點、到達地點、任務說明、駕駛人、油種、加油量(L)、加油金額、過路費、停車費、電池更換、成本中心（與 App「資料匯入 › 行車紀錄」相容） |
| `maintenance` | 日期、車牌、里程、費用、備註、保養間隔 |
| `workOrders` | 開立日、標題、車輛、狀態、完工日、里程、負責人、工項數、合計金額、備註 |
| `inspections` | 日期（含時間）、車輛、類型、點檢人、里程、結果、缺陷數、缺陷明細、備註 |

單趟車趟報表使用資料詳情（`GET /admin/records/trip/{id}`，[`protocol.md`](protocol.md) §7.4）。

## 3. 與 App 對齊的固定向量

`conformance/admin-suite.mjs` 的 `REPORT_VECTOR` 與報表測試建立一組刻意包含邊界情況的資料：跨夜的車趟、結束里程小於起始、期間開始前出車而跨入期間、
剛好在期間結束時出車（不算）、出車中（不算）、車趟上的駕駛姓名與駕駛人資料不同、工單明細沒有數量、巡檢有嚴重缺陷、公式與逗號。
三種主機實作必須算出相同的數字與逐位元組相同的 CSV；App 的報表測試以同一組資料（同樣的當地時間）走 App 實際的報表路徑，斷言相同的結果。
任一邊改了規則，兩邊的測試要一起改。

## 4. 資料量

報表在主機上讀取同一種類的所有有效資料後計算（車隊規模數千到數萬筆車趟沒有問題）。Cloudflare 免費方案的 CPU 時間很短，資料很多時建議付費方案或 Docker／PHP 版。
