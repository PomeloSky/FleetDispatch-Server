# 架設 FleetDispatch Server：Cloudflare Workers＋D1

不需要自己的伺服器：主機程式在 Cloudflare 的 Workers 上執行，資料存在 Cloudflare D1（SQLite）。網址一開始就是 HTTPS。

## 1. 需要的東西

- Cloudflare 帳號（免費即可）。
- 一台電腦，安裝 [Node.js 24](https://nodejs.org/) 以上與 Git。
- （選用）自己的網域，已加入 Cloudflare。

> **費用**：Workers 與 D1 都有免費方案，每天的請求數與資料讀寫量有上限，實際數字請以 Cloudflare 官方的定價頁為準。
> App 在前景時每台裝置大約每 15 秒同步一次（每小時約 240 個請求，背景時暫停）；車隊較大、裝置長時間開著時，可改用 Workers 付費方案。

## 2. 下載程式

```sh
git clone https://github.com/PomeloSky/FleetDispatch-Server.git
cd FleetDispatch-Server
npm install
```

## 3. 登入 Cloudflare 並建立資料庫

```sh
npx wrangler login
npx wrangler d1 create fleetdispatch
```

最後一個指令會輸出類似：

```
[[d1_databases]]
binding = "DB"
database_name = "fleetdispatch"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

打開 `cloudflare/wrangler.toml`，把 `database_id` 換成上面輸出的值。資料表不用手動建立，主機第一次收到請求時會自動建立。

（選用）同一個檔案中的 `FD_SERVER_NAME` 是主機第一次啟動時的名稱，之後可以在 App 的「管理主機」修改。

## 4. 設定「設定碼」

設定碼只用在第一次連線：輸入設定碼的裝置會成為管理員。請產生一組至少 16 個字元的隨機字串，例如：

```sh
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

把它存成 Worker 的機密設定（不會出現在程式碼或設定檔中）：

```sh
npx wrangler secret put FD_SETUP_TOKEN --config cloudflare/wrangler.toml
```

依提示貼上設定碼。請另外妥善保存這組設定碼（例如密碼管理器）：管理員裝置遺失時要用它恢復（見第 9 節）。

## 5. 部署

部署前可以先在 `cloudflare/wrangler.toml` 的 `[vars]` 把網頁管理的網址 `FD_ADMIN_PATH` 改成不容易猜到的路徑（例如 `"/manage-7k2q9"`；
預設 `/admin`，設為 `"off"` 關閉；見第 13 節）。

```sh
npm run cf:deploy
```

完成後會顯示主機網址，例如 `https://fleetdispatch-server.<你的子網域>.workers.dev`。

## 6. 確認主機正常

```sh
curl https://fleetdispatch-server.<你的子網域>.workers.dev/api/v1/info
```

看到 `"product":"FleetDispatch Server"`、`"setupRequired":true`、`"setupConfigured":true` 就表示可以連線了。
`setupConfigured` 是 `false` 時，代表第 4 步的設定碼沒有設定成功（或少於 16 個字元）。

## 7. （選用）使用自己的網域

Cloudflare 儀表板 › Workers & Pages › `fleetdispatch-server` › Settings › Domains & Routes › Add › Custom domain，輸入例如 `fleet.example.com`。
Cloudflare 會自動設定 DNS 與 HTTPS 憑證。之後 App 使用 `https://fleet.example.com`。

## 8. 在 App 連線

1. 管理員的裝置：FleetDispatch › 設定 › 使用模式 › **連線到自訂主機**。
2. 輸入主機網址 → **驗證主機** → 輸入設定碼 → **連線**。這台裝置成為管理員，開始同步。
3. 原本在這台裝置上的資料：配對主機頁 › **上傳本機資料到主機**（以修改時間較新的為準）。
4. 其他裝置：管理員在 **管理主機 › 建立配對碼**，選擇角色（駕駛可以綁定駕駛人）與期限；把主機網址與配對碼交給對方，對方在自己的 App 以同樣步驟輸入配對碼。
5. 改用自訂主機後，可以在 **雲端備份與同步** 關閉 iCloud 同步與雲端自動備份，並刪除已經備份的檔案。

也可以先用瀏覽器打開網頁管理（第 13 節），以設定碼建立第一位管理員，再在網頁建立配對碼給每一台 App。

## 9. 管理員裝置遺失：恢復第一次設定

撤銷所有管理員裝置後，設定碼會重新生效（資料不受影響）：

```sh
npx wrangler d1 execute fleetdispatch --remote --config cloudflare/wrangler.toml \
  --command "UPDATE fd_devices SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000, token_hash = NULL WHERE role = 'admin' AND revoked_at IS NULL"
```

再用新的裝置以設定碼連線即可。忘記設定碼時，以第 4 步重新設定一組。

## 10. 備份與還原

- 匯出整個資料庫：

  ```sh
  npx wrangler d1 export fleetdispatch --remote --config cloudflare/wrangler.toml --output fleetdispatch-backup.sql
  ```

- D1 也提供 Time Travel（還原到過去某個時間點），可保留的天數依方案而定：

  ```sh
  npx wrangler d1 time-travel info fleetdispatch --config cloudflare/wrangler.toml
  ```

- 從匯出檔還原到一個新的資料庫：`npx wrangler d1 create fleetdispatch-restore`，再 `npx wrangler d1 execute fleetdispatch-restore --remote --file fleetdispatch-backup.sql`，然後把 `wrangler.toml` 的 `database_id` 換成新的資料庫並重新部署。

## 11. 更新主機程式

```sh
git pull
npm install
npm run cf:deploy
```

更新前建議先做一次第 10 節的匯出。

## 12. 疑難排解

| 現象 | 原因與處理 |
| --- | --- |
| App 顯示「這個網址不是 FleetDispatch 主機」 | 網址打錯，或網址指向別的服務。用第 6 步的 `curl` 確認 |
| App 顯示「主機尚未設定設定碼」 | 第 4 步沒有完成；重新執行 `wrangler secret put` 後再部署 |
| 輸入設定碼後顯示錯誤 | 設定碼打錯；或主機已經有管理員（設定碼只在沒有管理員時有效，其他裝置請用配對碼） |
| 「嘗試太多次，請稍後再試」 | 同一個 IP 在 15 分鐘內配對失敗 10 次，等 15 分鐘 |
| 「此裝置已被解除配對」 | 管理員解除了這台裝置，或權杖 90 天未使用而過期；請管理員建立新的配對碼重新連線 |
| 部署時出現 `database_id` 相關錯誤 | `cloudflare/wrangler.toml` 的 `database_id` 還是範例值 |
| 想看主機的錯誤紀錄 | Cloudflare 儀表板 › Workers & Pages › `fleetdispatch-server` › Logs，或執行 `npx wrangler tail --config cloudflare/wrangler.toml` |
| 打開網頁管理的網址卻看到 App 介紹（首頁） | 網址與 `FD_ADMIN_PATH` 不同（大小寫也要相同），或設成了 `off`；改了 `wrangler.toml` 之後要重新部署 |

## 13. 網頁管理（瀏覽器）

這台主機也可以用瀏覽器管理：打開 `<主機網址><管理網址>`（預設 `/admin`）。**首頁顯示 FleetDispatch App 的介紹與下載連結**（任何人都看得到），管理頁只在管理網址出現，只有知道管理網址的人看得到登入頁；
登入仍然需要設定碼或管理員的配對碼，管理網址本身不是密碼。

- **登入**：主機還沒有管理員時，輸入設定碼，這個瀏覽器就成為第一位管理員（之後再建立配對碼給 App）；
  已經有管理員時，請管理員在 App 的「管理主機」或網頁的「配對碼」建立**角色為管理員**的配對碼，用它登入。
  瀏覽器會像 App 一樣出現在裝置清單（平台是「網頁」）；登出會解除這個瀏覽器的配對。
- **功能**：概況、裝置（改角色、綁定駕駛人、解除配對）、配對碼（建立與撤銷）、即時位置、稽核紀錄、資料（車趟、車輛、駕駛人、用車申請，唯讀）、主機名稱。
- **安全**：建議把管理網址改成不容易猜到的路徑（只能用英數字與 `. _ ~ -`，不能以 `/api` 開頭），不要公開分享；
  勾選「記住這個瀏覽器」只用在自己的電腦。只有一個管理員時，網頁會提醒你再建立一位管理員，避免瀏覽器資料被清除後失去管理權限。

- **管理網址**：`cloudflare/wrangler.toml` 的 `[vars]` › `FD_ADMIN_PATH`，改完重新部署（`npm run cf:deploy`）。也可以在 Cloudflare 儀表板 ›
  Workers & Pages › `fleetdispatch-server` › Settings › Variables and Secrets 修改（下次以 wrangler 部署時會被 `wrangler.toml` 的值覆蓋）。

