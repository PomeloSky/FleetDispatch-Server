# FleetDispatch Server

可以自行架設的 FleetDispatch 主機。FleetDispatch App（8.0 起）除了在同一個區域網路內以 iPad 或 Mac 當主機，也可以改連你自己架設的主機：
不在同一個 Wi-Fi 也能同步，資料保存在你掌控的地方。

- 三種部署方式，功能完全相同，選一種即可：

| 部署方式 | 適合 | 費用 | 難度 | 架設說明 |
| --- | --- | --- | --- | --- |
| **Cloudflare Workers＋D1** | 不想管伺服器、車隊規模中小 | 免費方案通常就夠用 | ★☆☆ | [docs/setup-cloudflare.md](docs/setup-cloudflare.md) |
| **PHP＋MySQL** | 已經有虛擬主機（cPanel、DirectAdmin、Plesk）或 LAMP 主機；有網頁安裝精靈，不需要 SSH | 現有主機即可 | ★★☆ | [docs/setup-php-mysql.md](docs/setup-php-mysql.md) |
| **Docker** | NAS（Synology、QNAP）、VPS、公司內部伺服器、Raspberry Pi | 自有設備 | ★★☆ | [docs/setup-docker.md](docs/setup-docker.md) |

- App 端的操作：**設定 › 使用模式 › 連線到自訂主機** → 輸入主機網址 → 驗證 → 第一次輸入部署時設定的**設定碼**（這台裝置成為管理員）。
  其他裝置由管理員在 App 的「管理主機」建立**配對碼**後連線；角色（管理員、駕駛、檢視者）與綁定的駕駛人由配對碼決定。
- 也可以用瀏覽器管理：打開**網頁管理**的網址（預設 `<主機網址>/admin`，可以改成不容易猜到的路徑）。
  主機網址的首頁顯示 FleetDispatch App 的介紹與下載連結，讓看到網址的人也能認識這個 App；管理頁不會出現在首頁。
  第一位管理員也可以直接在網頁用設定碼建立。
- 改用自訂主機後，可以在 App 的「雲端備份與同步」關閉 iCloud 同步與雲端自動備份，並刪除已經備份到雲端的檔案。

## 功能

- 與 App 的區網主機相同的同步規則：最後寫入者勝、主機校正用戶端偏快的時間、刪除車輛時一併刪除它的車趟與保養紀錄。
- 1.2.0：事件冪等（回應遺失後重送不會重複套用）、每筆資料的版本（`expectedRevision` 與衝突）、修改前後歷史（管理員查詢）、
  授權與寫入看到同一個版本、有進行中車趟的車輛不能刪除、資料表版本與自動遷移（升級前自動備份 SQLite）。
- 1.2.0 管理員的資料 API：資料清單（搜尋、篩選、排序、分頁）、詳情與關聯、受控修改（差異預覽、原因、版本檢查）、刪除的影響預覽與不可分割的連鎖刪除、
  用車申請的核准與退回；沒有套用的事件也留下摘要；歷史中的駕駛人個資預設遮蔽（[docs/admin-management.md](docs/admin-management.md)）。
- 角色與資料範圍：管理員可讀寫全部；駕駛只收到自己的車趟、巡檢與用車申請，其他駕駛人的個資被遮蔽；檢視者唯讀、個資被遮蔽。
  駕駛不能核准自己的申請、不能修改或改派別人的車趟。
- 用車申請與核准、巡檢、工單、零件、保養等 10 種資料；即時位置（出車中的車輛位置）；稽核紀錄（誰在什麼時候改了什麼）。
- 裝置管理：配對碼（單次有效、可設定期限）、改角色、綁定駕駛人、解除配對。
- 網頁（1.1.0 起）：首頁是 App 的介紹與 App Store 下載連結（Android 版測試中，Google Play 公開上架後才放下載連結）；網頁管理在設定的管理網址，用瀏覽器做上面的管理工作，並查看即時位置、稽核紀錄與資料（唯讀）。登入方式與 App 相同（設定碼或配對碼）。
- 安全：只在 HTTPS 上使用；權杖與配對碼只存雜湊；配對失敗太多次會暫時鎖定；所有 SQL 參數化。

## 架構

```
core/          TypeScript 核心（Cloudflare 與 Docker 共用；只用 Web 標準 API，沒有框架相依）
cloudflare/    Cloudflare Workers＋D1 的進入點與 wrangler 設定
docker/        Node 24（內建 node:sqlite）的進入點與維護工具
php/           PHP 8.1 以上＋MySQL 8.0／MariaDB 10.6 以上（或 SQLite）實作
web/           網頁：首頁 home.html、網頁管理 admin.html／admin.js（npm run build:web 產生 core/src/web-assets.ts 與 php/web/）
spec/          網頁管理的資料規格 admin-entities.json（npm run build:web 產生 core/src/admin-spec.ts 與 php/src/AdminSpec.php）
scripts/       開發工具（build-web.mjs）
conformance/   相容性測試：對任何一台主機執行，三種實作都必須通過
docs/          協定規格與各部署方式的架設說明
```

- 協定規格：[docs/protocol.md](docs/protocol.md)（HTTP JSON API v1）；同步一致性 [docs/sync-consistency.md](docs/sync-consistency.md)、
  稽核與修改歷史 [docs/audit-history.md](docs/audit-history.md)、網頁管理的資料 [docs/admin-management.md](docs/admin-management.md)、
  資料表升級 [docs/migration.md](docs/migration.md)、
  發布檢查與提交身分 [docs/release-checklist.md](docs/release-checklist.md)。
- 相容性測試：**只對本機新建、空的主機執行**（測試會建立管理員並寫入資料；不要對正式主機執行）：

  ```sh
  FD_BASE=http://127.0.0.1:8080 FD_SETUP_TOKEN=你的設定碼 FD_ADMIN_PATH=/admin node --test conformance/api.test.mjs conformance/web.test.mjs
  node --test conformance/migration-node.test.mjs conformance/migration-php.test.mjs   # 1.1 → 1.2 遷移（本機暫存資料夾）
  ```

  PHP 版的安裝精靈另有 `conformance/php-install.test.mjs`（對還沒有 `config.php` 的主機執行，見檔案開頭的說明）。

  測試會建立管理員與測試資料，並讓執行的 IP 在 15 分鐘內無法配對；**不要對正式使用中的主機執行**。

## 開發

需要 Node 24 以上。

```sh
npm install
npm run typecheck            # TypeScript 型別檢查
npm run build:web            # 修改 web/ 之後：產生 core/src/web-assets.ts 與 php/web/（要一起提交）
npm run check:web            # 檢查產生的檔案與 web/ 一致（CI 也會檢查）
npm run docker:dev           # 本機以 Node 執行（資料在 ./data）
npm run cf:dev               # 本機以 wrangler 執行 Worker（本機 D1）
FD_PHP_CONFIG=/path/to/config.php php -S 127.0.0.1:8080 php/public/index.php   # PHP 版（見 docs/setup-php-mysql.md）
```

## 更新

- 三種實作的資料表會在啟動或第一次請求時自動建立；之後的版本若需要調整資料表，會在更新說明中寫明步驟。
- 更新前請先備份（各部署方式的說明都有備份方法）。
- 1.1.0 起提供網頁管理，預設網址是 `/admin`；不需要時設為 `off` 關閉（Cloudflare 與 Docker 的 `FD_ADMIN_PATH`、PHP 的 `admin_path`）。
- PHP 版還沒有 `config.php` 時，網頁管理會顯示安裝精靈（檢查環境、測試資料庫、產生設定檔）；已經安裝過的主機不受影響。

## 授權

Copyright (C) 2026 PomeloSky

本專案以 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）授權。

- 照原樣架設自己使用、或在公司內部使用，不需要額外做任何事。
- 修改了程式並提供給其他人透過網路連線使用（例如架成服務給別的公司用）時，必須讓這些使用者能取得修改後的完整原始碼，並同樣以 AGPL-3.0 授權。
- 詳細條款以 [LICENSE](LICENSE) 的英文原文為準。
