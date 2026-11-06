# 架設 FleetDispatch Server：Docker

適合 NAS（Synology、QNAP）、VPS、公司內部伺服器或 Raspberry Pi（arm64）。主機是一個 Node 24 容器，資料存在容器的資料卷中的 SQLite 檔；
執行時不需要安裝任何套件，也不需要另外的資料庫。

## 1. 需要的東西

- 已安裝 Docker 與 Docker Compose 的主機（Synology 的「Container Manager」、QNAP 的「Container Station」也可以）。
- 對外使用時：一個網域，以及 HTTPS（第 5 節）。App 只接受 HTTPS；只有區域網路內的位址（例如 `http://192.168.1.20:8080`）在使用者確認後可以用 http 測試。

## 2. 下載程式

```sh
git clone https://github.com/PomeloSky/FleetDispatch-Server.git
cd FleetDispatch-Server
```

沒有 Git 時，可以在 GitHub 頁面以 Code › Download ZIP 下載後解壓縮。

## 3. 設定

打開 `compose.yaml`：

| 環境變數 | 說明 |
| --- | --- |
| `FD_SETUP_TOKEN` | **設定碼**：第一次連線用，輸入它的裝置成為管理員。至少 16 個字元的隨機字串（產生方式見下方）。留空時主機會自動產生一組，存在資料卷的 `setup-token.txt` |
| `FD_SERVER_NAME` | 主機第一次啟動時的名稱（之後可以在 App 或網頁管理修改） |
| `FD_ADMIN_PATH` | 網頁管理的網址（第 11 節），預設 `/admin`；建議改成不容易猜到的路徑，例如 `/manage-7k2q9`；設為 `off` 關閉 |
| `FD_TRUST_PROXY` | 前面有幾層反向代理：直接對外時保持 `0`；放在一層反向代理（Caddy、nginx、Synology 反向代理、Cloudflare Tunnel）後面時設為 `1`。主機只採用信任的代理在 `X-Forwarded-For` 右邊附加的 IP（最左邊的值可以被偽造），配對嘗試次數限制才會用到真實 IP |
| `FD_PORT` | 容器內的連接埠，預設 8080 |

產生設定碼：

```sh
openssl rand -base64 24
```

請另外妥善保存設定碼（例如密碼管理器）；管理員裝置遺失時要用它恢復（第 8 節）。

## 4. 啟動

```sh
docker compose up -d --build
docker compose logs -f fleetdispatch
```

看到 `FleetDispatch Server 1.0.0（Docker）在 http://0.0.0.0:8080` 就表示啟動成功。確認：

```sh
curl http://localhost:8080/api/v1/info
```

應看到 `"product":"FleetDispatch Server"`、`"setupRequired":true`。

沒有設定 `FD_SETUP_TOKEN` 時，查看自動產生的設定碼：

```sh
docker compose exec fleetdispatch node docker/src/admin-tools.ts setup-token
```

## 5. HTTPS

App 要求 HTTPS（區域網路內的測試除外）。任選一種：

### A. Caddy（自動申請 Let's Encrypt 憑證）

1. 網域（例如 `fleet.example.com`）的 DNS 指向這台主機，防火牆與路由器開放 80、443 連接埠。
2. 修改 `docker/examples/Caddyfile` 的網域，以及 `docker/examples/compose.caddy.yaml` 的 `FD_SETUP_TOKEN`。
3. 改用這個 compose 檔啟動（先停止第 4 節啟動的容器）：

   ```sh
   docker compose down
   docker compose -f docker/examples/compose.caddy.yaml up -d --build
   ```

4. App 使用 `https://fleet.example.com`。

### B. 已經有的反向代理

把 `https://你的網域` 轉送到 `http://<這台主機>:8080`，並把 `FD_TRUST_PROXY` 設為 `1`。例如 nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name fleet.example.com;
    ssl_certificate     /etc/letsencrypt/live/fleet.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fleet.example.com/privkey.pem;
    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

這時建議把 `compose.yaml` 的 `ports` 改成 `"127.0.0.1:8080:8080"`，主機只接受本機的反向代理連線。

- **Synology**：控制台 › 登入入口 › 進階 › 反向代理伺服器，來源 `HTTPS` ＋你的網域、目的地 `HTTP localhost:8080`；憑證在 控制台 › 安全性 › 憑證 申請 Let's Encrypt。
- **Cloudflare Tunnel**：不需要開放連接埠；在 Cloudflare Zero Trust 建立 Tunnel，Public Hostname 指向 `http://localhost:8080`。

### C. 只在區域網路內使用

直接使用 `http://<這台主機的區域網路 IP>:8080`。App 會提醒連線未加密，確認後可以使用；資料與權杖不加密，只建議用在測試或可信任的內部網路。

## 6. 在 App 連線

1. 管理員的裝置：FleetDispatch › 設定 › 使用模式 › **連線到自訂主機**。
2. 輸入主機網址 → **驗證主機** → 輸入設定碼 → **連線**。這台裝置成為管理員，開始同步。
3. 原本在這台裝置上的資料：配對主機頁 › **上傳本機資料到主機**。
4. 其他裝置：管理員在 **管理主機 › 建立配對碼**，選擇角色（駕駛可以綁定駕駛人）與期限；把主機網址與配對碼交給對方，對方以同樣步驟輸入配對碼。
5. 改用自訂主機後，可以在 **雲端備份與同步** 關閉 iCloud 同步與雲端自動備份，並刪除已經備份的檔案。

也可以先用瀏覽器打開網頁管理（第 11 節），以設定碼建立第一位管理員，再在網頁建立配對碼給每一台 App。

## 7. 備份與還原

資料都在資料卷中的 `fleetdispatch.sqlite`。

- 備份（主機執行中也可以）：

  ```sh
  docker compose exec fleetdispatch node docker/src/admin-tools.ts backup
  ```

  會在資料卷的 `backups/` 產生 `fleetdispatch-<日期時間>.sqlite`。複製到別處保存：

  ```sh
  docker compose cp fleetdispatch:/data/backups ./fleetdispatch-backups
  ```

  可以用排程（cron、Synology 的「任務排程表」）每天執行。

- 還原（主機必須先停止；原本的資料庫會另存為 `fleetdispatch.before-restore-*.sqlite`）：

  ```sh
  docker compose stop fleetdispatch
  docker compose run --rm fleetdispatch node docker/src/admin-tools.ts restore backups/fleetdispatch-<日期時間>.sqlite
  docker compose start fleetdispatch
  ```

  備份檔在別處時，先以 `docker compose cp <檔案> fleetdispatch:/data/backups/` 放回資料卷。
  還原後，各裝置會在下一次同步時以主機的資料為準。

## 8. 管理員裝置遺失：恢復第一次設定

1.2.0 起，所有管理員的登入都已失效時（例如只用網頁管理、超過期限沒有使用），設定碼會自動重新生效，可以直接在網頁管理以設定碼登入；
管理員的裝置遺失、但登入還沒失效時，用下面的方式撤銷。

撤銷所有管理員裝置後，設定碼會重新生效（資料不受影響）：

```sh
docker compose exec fleetdispatch node docker/src/admin-tools.ts reset-admins
```

再用新的裝置以設定碼連線即可。忘記設定碼時，修改 `compose.yaml` 的 `FD_SETUP_TOKEN` 後執行 `docker compose up -d`。

## 9. 更新主機程式

```sh
docker compose exec fleetdispatch node docker/src/admin-tools.ts backup
git pull
docker compose up -d --build
```

## 10. 疑難排解

| 現象 | 原因與處理 |
| --- | --- |
| App 顯示「請使用 HTTPS」 | 對外網址必須是 HTTPS（第 5 節）；只有區域網路位址可以用 http |
| App 顯示「主機的 HTTPS 憑證無效」 | 憑證過期、網域不符或使用自簽憑證；請使用 Let's Encrypt 等公開憑證 |
| App 顯示「無法連線到主機」 | 防火牆或路由器沒有開放連接埠、反向代理設定錯誤；先在主機上 `curl http://localhost:8080/api/v1/info` 確認容器正常 |
| 輸入設定碼後顯示錯誤 | 設定碼打錯；或主機已經有管理員（設定碼只在沒有管理員時有效，其他裝置請用配對碼） |
| 「嘗試太多次，請稍後再試」 | 同一個 IP 在 15 分鐘內配對失敗 10 次，等 15 分鐘。放在反向代理後面卻沒有設 `FD_TRUST_PROXY=1` 時，所有裝置會被當成同一個 IP |
| 「此裝置已被解除配對」 | 管理員解除了這台裝置，或權杖 90 天未使用而過期；請管理員建立新的配對碼重新連線 |
| 容器一直重啟 | `docker compose logs fleetdispatch` 查看；`FD_SETUP_TOKEN` 少於 16 個字元時主機不會啟動 |
| 打開網頁管理的網址卻看到 App 介紹（首頁） | 網址與 `FD_ADMIN_PATH` 不同（大小寫也要相同），或設成了 `off`；改了 `compose.yaml` 之後要 `docker compose up -d` 重新建立容器。啟動紀錄（`docker compose logs fleetdispatch`）會顯示目前的管理網址 |

## 11. 網頁管理（瀏覽器）

這台主機也可以用瀏覽器管理：打開 `<主機網址><管理網址>`（預設 `/admin`）。**首頁顯示 FleetDispatch App 的介紹與下載連結**（任何人都看得到），管理頁只在管理網址出現，只有知道管理網址的人看得到登入頁；
登入仍然需要設定碼或管理員的配對碼，管理網址本身不是密碼。

- **登入**：主機目前沒有可以使用的管理員時（第一次設定，或所有管理員的登入都已失效），輸入設定碼，這個瀏覽器就成為管理員（之後再建立配對碼給 App）；
  已經有管理員時，請管理員在 App 的「管理主機」或網頁的「配對碼」建立**角色為管理員**的配對碼，用它登入（不是管理員的配對碼不能登入網頁，也不會被用掉）。
  瀏覽器會出現在裝置清單（平台是「網頁」）；登入資料由主機以 HttpOnly Cookie 保存，網頁的程式讀不到。登出會解除這個瀏覽器的配對。
  1.1 版存在瀏覽器裡的登入，升級後第一次開啟網頁管理時會自動換成 Cookie。
- **功能**：13 個管理區塊（總覽、使用者與駕駛、裝置、車輛、車趟、用車申請、巡檢與工單、保養與零件、即時位置、報表、修改歷史與稽核、配對碼、主機設定），
  可以查詢、受控修改、簽核用車申請與下載報表，說明見 [admin-management.md](admin-management.md)。
- **安全**：建議把管理網址改成不容易猜到的路徑（只能用英數字與 `. _ ~ -`，不能以 `/api` 開頭），不要公開分享；對外使用一定要經過 HTTPS（登入 Cookie 會加上 Secure）。
  勾選「記住這個瀏覽器」只用在自己的電腦（90 天內有效，30 天沒有使用要重新登入）；不勾選時，關閉瀏覽器、閒置 2 小時或登入 12 小時後要重新登入。
  只有一個管理員時，網頁會提醒你再建立一位管理員，避免登入到期後失去管理權限。

- **管理網址**：`compose.yaml` 的 `FD_ADMIN_PATH`，改完執行 `docker compose up -d`。
- 只在區域網路用 `http://` 開啟時，瀏覽器不允許自動複製，配對碼請手動複製；對外使用請照第 5 節放在 HTTPS 後面。

