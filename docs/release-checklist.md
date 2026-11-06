# 發布檢查清單與提交身分

## 1. 提交與發布的身分（必須遵守）

- **正式發布只能由擁有者的 GitHub／部署帳號進行**：建立 GitHub Release、建立發行 Tag、部署（Cloudflare、Docker 映像檔）、在正式主機執行資料表遷移、變更正式服務，都必須由擁有者本人執行，或取得擁有者對該次操作的明確授權。不得使用 Claude、Anthropic、其他 AI 或機器人帳號冒充擁有者。
- **提交的作者與提交者必須是擁有者已授權的 Git 身分**（本 repo 的設定：`PomeloSky <13956433+PomeloSky@users.noreply.github.com>`）。不得自行捏造作者、修改全域 Git 設定或冒用擁有者的 Email。
- **不加入 `Co-Authored-By: Claude`**（或任何 AI 的共同作者署名）。
- 能讀取到既有的權杖（GitHub、Cloudflare、Docker Hub…）不代表可以發布；不得取得、輸出或記錄擁有者的密碼與權杖。
- 本 repo 是公開的：不得放入 FleetDispatch App 的原始碼、內部文件、金鑰或上架資料。推送前確認 `git remote -v` 與暫存的內容。

## 2. 發布前

- [ ] `npm ci`（Node 24）、`npm run typecheck`、`npm run check:web` 通過。
- [ ] 相容性測試在三種實作都通過（對**本機新建、空的**主機執行；不對正式主機執行會重設資料、建立管理員或大量寫入的測試）：
  - Docker／Node：`FD_DATA_DIR=<暫存資料夾> FD_HOST=127.0.0.1 FD_PORT=18080 FD_SETUP_TOKEN=<16 字元以上> node docker/src/server.ts`，再 `FD_BASE=http://127.0.0.1:18080 FD_SETUP_TOKEN=… node --test conformance/api.test.mjs conformance/web.test.mjs`
  - PHP＋SQLite：`FD_PHP_CONFIG=<設定檔> php -S 127.0.0.1:18081 php/public/index.php`，同上
  - Cloudflare：`npx wrangler dev --config cloudflare/wrangler.toml --local --persist-to <暫存資料夾> --var FD_SETUP_TOKEN:…`，同上
  - PHP＋MySQL：在有 MySQL 的環境（CI）執行
- [ ] 遷移與網頁登入期限的測試：`node --test conformance/migration-node.test.mjs conformance/migration-php.test.mjs conformance/web-session-local.test.mjs`（本機暫存資料夾）。
- [ ] 網頁管理的瀏覽器實測（選用，網頁有修改時）：`scripts/check-admin-ui.mjs` 對本機新建、空的主機執行（見檔案開頭的說明）。
- [ ] `core/src/version.ts`、`php/src/Version.php`、`package.json` 的版本一致。
- [ ] `docs/protocol.md` 的版本與相容性表、`docs/migration.md`、`docs/security-review.md` 已更新。

## 3. 發布（擁有者執行或明確授權後）

- [ ] 合併到 `main`。
- [ ] 提醒使用者升級前備份（`docs/migration.md`）。
- [ ] 建立 Tag 與 GitHub Release（擁有者）。
- [ ] Docker 映像檔（若有發布）、Cloudflare 部署範例（擁有者）。

## 4. 發布後

- [ ] 以 App 連線一台測試用的主機：配對、全量同步、送出事件、增量。
- [ ] 確認 `GET /api/v1/info` 的 `serverVersion`、`schemaVersion`。
