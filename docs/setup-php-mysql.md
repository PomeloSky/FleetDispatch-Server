# 架設 FleetDispatch Server：PHP＋MySQL

適合一般的虛擬主機（cPanel、DirectAdmin、Plesk 等控制台）或自己的 VPS（Apache，或 nginx＋PHP-FPM）。
程式只用 PHP 內建的功能，不需要 Composer，也不需要在主機上安裝任何套件；資料存在 MySQL／MariaDB。
很小的主機或測試時也可以改用 SQLite（不需要 MySQL）。

API 規格見 [protocol.md](protocol.md)；三種主機（Cloudflare、Docker、PHP）的行為相同，App 都可以連線。

## 1. 需要的東西

- **PHP 8.1 以上**（8.2、8.3、8.4 都可以），並啟用 **PDO** 與 **pdo_mysql**（用 SQLite 時是 pdo_sqlite）。建議也啟用 mbstring。
- **MySQL 8.0 以上或 MariaDB 10.6 以上**（InnoDB）。
- **網址改寫**：Apache 的 mod_rewrite（多數虛擬主機都有；LiteSpeed 也支援 `.htaccess`），或 nginx。
  沒有網址改寫也能使用，只是網址要多一段 `/index.php`（第 13 節）。
- **HTTPS**（第 6 節）。App 只接受 HTTPS；只有區域網路內的位址在使用者確認後可以用 http 測試。
- 一個網域或子網域，例如 `fleet.example.com`（也可以放在現有網站的子資料夾，例如 `https://example.com/fleet`）。

確認 PHP 版本與擴充功能（有 SSH 時）：

```sh
php -v
php -m | grep -i -E 'pdo|mbstring'
```

虛擬主機的網頁伺服器有時和 SSH 的 `php` 版本不同；以控制台的設定為準
（cPanel：**Select PHP Version** 或 **MultiPHP Manager**；DirectAdmin：**PHP Version Selector**；Plesk：網域的 **PHP Settings**）。

## 2. 下載程式

```sh
git clone https://github.com/PomeloSky/FleetDispatch-Server.git
```

沒有 Git 時，在 GitHub 頁面以 **Code › Download ZIP** 下載後解壓縮。PHP 版只需要裡面的 `php` 資料夾：

```text
php/
├── public/            ← 網站根目錄：只有 index.php 與 .htaccess
├── src/               ← 程式（不能被網站直接存取）
├── schema/            ← 資料庫結構（mysql.sql、sqlite.sql）
└── config.sample.php  ← 設定檔範例（複製成 config.php）
```

## 3. 放置檔案

原則：**網站根目錄（document root）只放 `public/` 的內容**；`src/`、`schema/`、`config.php`（以及 SQLite 資料庫）放在網站根目錄以外，
網站訪客無法直接下載。

### A. 可以設定網站根目錄（建議；VPS、多數控制台的子網域）

1. 把整個 `php` 資料夾上傳到家目錄，改名為 `fleetdispatch`，例如 `/home/帳號/fleetdispatch/`（**不要**放在 `public_html` 裡）。
2. 把網域或子網域的網站根目錄設為 `/home/帳號/fleetdispatch/public`：
   - cPanel：**Domains**（或 **Subdomains**）› 建立或管理網域 › **Document Root** 填 `fleetdispatch/public`。
   - Plesk：網域的 **Hosting Settings › Document root** 填 `fleetdispatch/public`。
   - DirectAdmin：通常不能自訂網站根目錄，請用方法 B。

### B. 不能改網站根目錄（只能用 `public_html`）

1. 同上，把整個 `php` 資料夾上傳到 `/home/帳號/fleetdispatch/`（和 `public_html` 同一層，**不要**放在 `public_html` 裡）。
2. 把 `fleetdispatch/public/` 裡的 **`index.php` 與 `.htaccess`** 複製到網站的位置：
   - 整個網域給 FleetDispatch 使用：複製到 `public_html/`，基底網址是 `https://example.com`。
   - 網站已經有其他內容：建立子資料夾，例如 `public_html/fleet/`，基底網址是 `https://example.com/fleet`。
     （這個 `.htaccess` 會把所在資料夾的**所有**請求交給 FleetDispatch，所以不要放在現有網站的根目錄。）
3. `index.php` 會自動往上層尋找名為 `fleetdispatch` 的資料夾。資料夾名稱或位置不同時，打開 `index.php`，把開頭的
   `$fdAppDir = '';` 改成完整路徑，例如 `$fdAppDir = '/home/帳號/fleetdispatch';`。

> `.htaccess` 是隱藏檔：用控制台的檔案管理員時，請先在設定中開啟「顯示隱藏檔案」，確認它有上傳。

萬一只能把所有檔案放在 `public_html` 裡：`src/`、`schema/` 內附的 `.htaccess` 會禁止 Apache 直接存取，`config.php`
被直接開啟時也不會輸出任何內容；但這不如方法 A、B 安全，而且 **SQLite 資料庫絕對不能放在網站可以存取的資料夾**。

## 4. 建立資料庫

建立一個空的資料庫，以及只能存取它的使用者（給予這個資料庫的全部權限）。名稱與密碼請記下來，第 5 節會用到。

- **cPanel**：**MySQL® Database Wizard**：建立資料庫 → 建立使用者（用產生器產生強密碼）→ 勾選 **ALL PRIVILEGES**。
  cPanel 會在名稱前面加上帳號，例如資料庫 `帳號_fleet`、使用者 `帳號_fleet`。
- **DirectAdmin**：**MySQL Management › Create new Database**（會同時建立使用者）。
- **Plesk**：**Databases › Add Database**（類型選 MySQL 或 MariaDB，同時建立使用者）。
- **VPS**（以管理員身分執行 `sudo mysql`）：

  ```sql
  CREATE DATABASE fleetdispatch CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'fleetdispatch'@'localhost' IDENTIFIED BY '換成一組強密碼';
  GRANT ALL PRIVILEGES ON fleetdispatch.* TO 'fleetdispatch'@'localhost';
  FLUSH PRIVILEGES;
  ```

**資料表不需要手動建立**：主機第一次收到 API 請求時會自動建立（UTF-8〔utf8mb4〕、InnoDB）。
只有資料庫使用者沒有建立資料表的權限時，才需要先匯入 `schema/mysql.sql`：phpMyAdmin 選擇資料庫 › **匯入**（Import）上傳這個檔案，或：

```sh
mysql -u fleetdispatch -p fleetdispatch < /home/帳號/fleetdispatch/schema/mysql.sql
```

## 5. 設定 config.php

把 `config.sample.php` 複製成同一個資料夾裡的 `config.php`，再修改：

```sh
cd /home/帳號/fleetdispatch
cp config.sample.php config.php
chmod 600 config.php
```

| 欄位 | 說明 |
| --- | --- |
| `setup_token` | **設定碼**：App 第一次連線時輸入，那台裝置成為管理員。至少 16 個字元的隨機字串，產生方式見下方 |
| `db.dsn` | 資料庫位置，例如 `mysql:host=localhost;dbname=帳號_fleet;charset=utf8mb4`。資料庫在其他主機或連接埠時寫 `host=127.0.0.1;port=3306` |
| `db.user`、`db.password` | 第 4 節建立的使用者與密碼 |
| `server_name` | 第一次初始化時的主機名稱（之後管理員可以在 App 修改） |
| `trust_proxy` | 前面有幾層**你自己控制的**反向代理：PHP 直接面對網際網路時（一般虛擬主機、Apache 或 nginx 直接執行 PHP）保持 `0`；前面剛好有一層反向代理（例如開啟代理的 Cloudflare、另一台 nginx）時設為 `1`。設為 N 時，主機取 `X-Forwarded-For` 從右邊數來第 N 個位址作為來源 IP（最左邊的值可以被用戶端偽造，不會採用）；配對嘗試次數限制會用到真實的 IP。不確定時保持 `0` |

產生設定碼（有 SSH 時）：

```sh
php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
```

沒有 SSH 時，用密碼管理器產生一組 32 個字元以上的隨機密碼即可。請另外妥善保存設定碼（例如密碼管理器）；
管理員裝置遺失時要用它恢復（第 10 節）。

`config.php` 含資料庫密碼與設定碼，權限設為 `600`（只有自己的帳號能讀）。虛擬主機的 PHP 通常以你的帳號執行，`600` 就可以；
自己的 VPS 若 PHP 以 `www-data` 等其他使用者執行，改用 `chown 你的帳號:www-data config.php` 與 `chmod 640 config.php`。

**改用 SQLite**（測試或很小的主機）：把 `db` 整段換成

```php
'db' => [
    'dsn' => 'sqlite:' . __DIR__ . '/data/fleetdispatch.sqlite',
],
```

`data/` 資料夾會自動建立；它所在的資料夾必須讓 PHP 可以寫入，而且不能被網站直接存取（方法 A、B 都符合）。
SQLite 檔案必須放在本機磁碟（不要放在網路磁碟）；正式使用、多台裝置同時同步時建議用 MySQL。

> 進階：設定檔也可以放在別處，以環境變數 `FD_PHP_CONFIG` 指定完整路徑。

## 6. HTTPS

App 要求 HTTPS（只有區域網路內的位址，例如 `http://192.168.1.20`，在使用者確認後可以用 http）。

- **cPanel**：**SSL/TLS Status** › 勾選網域 › **Run AutoSSL**。
- **DirectAdmin**：**SSL Certificates** › **Free & automatic certificate from Let's Encrypt**。
- **Plesk**：網域的 **SSL/TLS Certificates** › **Let's Encrypt**。
- **VPS**：用 certbot 申請 Let's Encrypt 憑證（會自動續約）：

  ```sh
  sudo certbot --apache -d fleet.example.com    # Apache
  sudo certbot --nginx  -d fleet.example.com    # nginx
  ```

在 App 輸入網址時一律以 `https://` 開頭。

## 7. VPS 的網頁伺服器設定

虛擬主機不需要這一節（`.htaccess` 已經處理好）。

### Apache

```sh
sudo a2enmod rewrite
```

```apache
<VirtualHost *:80>
    ServerName fleet.example.com
    DocumentRoot /var/www/fleetdispatch/public
    <Directory /var/www/fleetdispatch/public>
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
```

存成 `/etc/apache2/sites-available/fleetdispatch.conf` 後執行 `sudo a2ensite fleetdispatch && sudo systemctl reload apache2`，
再用第 6 節的 `certbot --apache` 加上 HTTPS。

### nginx＋PHP-FPM

所有請求都交給 `index.php`（只有這個檔案會被執行）：

```nginx
server {
    listen 443 ssl http2;
    server_name fleet.example.com;
    ssl_certificate     /etc/letsencrypt/live/fleet.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fleet.example.com/privkey.pem;

    root /var/www/fleetdispatch/public;
    client_max_body_size 6m;          # nginx 預設只有 1 MB；同步的請求最多 5 MB

    location / {
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root/index.php;
        fastcgi_param SCRIPT_NAME /index.php;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;   # 依實際的 PHP 版本修改：ls /run/php/
    }
}

server {
    listen 80;
    server_name fleet.example.com;
    return 301 https://$host$request_uri;
}
```

放在子路徑（基底網址 `https://example.com/fleet`）時，在原本網站的 `server` 中加上：

```nginx
location /fleet/ {
    client_max_body_size 6m;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /var/www/fleetdispatch/public/index.php;
    fastcgi_param SCRIPT_NAME /fleet/index.php;
    fastcgi_pass unix:/run/php/php8.3-fpm.sock;
}
```

修改後執行 `sudo nginx -t && sudo systemctl reload nginx`。PHP 的 `post_max_size` 預設 8 MB，不需要調整（至少要 6 MB）。

## 8. 確認主機正常

```sh
curl https://fleet.example.com/api/v1/info
```

（沒有 curl 時，用瀏覽器打開這個網址也可以。）應看到類似：

```json
{"product":"FleetDispatch Server","apiVersion":1,"serverVersion":"1.0.0","variant":"php", … ,"setupRequired":true,"setupConfigured":true, … }
```

- `setupConfigured` 是 `false`：`config.php` 沒有設定 `setup_token`，或少於 16 個字元。
- 看到 `{"error":{"code":"server_error","message":"主機設定錯誤：…"}}`：依訊息處理（第 13 節）。

再確認權杖（`Authorization` 標頭）能傳到 PHP：

```sh
curl https://fleet.example.com/api/v1/session -H "Authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

應回覆 `權杖無效或已過期，請重新配對`（表示標頭有傳到，只是這個權杖是假的）。如果回覆 `需要權杖`，代表網頁伺服器沒有把標頭交給 PHP，
請見第 13 節「一直回 401」。

## 9. 在 App 連線

1. 在管理員的裝置上，FleetDispatch App（8.0 以上）改連**自訂主機**，輸入基底網址
   （例如 `https://fleet.example.com`、`https://example.com/fleet`；沒有網址改寫時是 `https://example.com/fleet/index.php`）並驗證主機。
2. 輸入**設定碼**當作第一個配對碼 → 這台裝置成為管理員，開始同步。之後設定碼就不再有效。
3. 其他裝置：管理員在 App 中**建立配對碼**，選擇角色（管理員、駕駛〔可以綁定駕駛人〕、檢視者）與有效期限，
   把基底網址與配對碼（`XXXX-XXXX`，只能用一次，預設 24 小時內有效）交給對方，對方以同樣的步驟輸入配對碼。

App 的操作畫面與其他主機相同，詳細步驟也可以參考 [setup-docker.md](setup-docker.md) 第 6 節。

## 10. 管理員裝置遺失：恢復第一次設定

撤銷所有管理員裝置後，設定碼會重新生效（資料不受影響）。在 phpMyAdmin 選擇資料庫 › **SQL**，或用 `mysql` 指令執行：

```sql
UPDATE fd_devices SET revoked_at = UNIX_TIMESTAMP() * 1000, token_hash = NULL
WHERE role = 'admin' AND revoked_at IS NULL;
```

再用新的裝置以設定碼連線即可（舊的管理員裝置要重新配對）。忘記設定碼時，修改 `config.php` 的 `setup_token`（立即生效）。

使用 SQLite 時：

```sh
sqlite3 /home/帳號/fleetdispatch/data/fleetdispatch.sqlite \
  "UPDATE fd_devices SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000, token_hash = NULL WHERE role = 'admin' AND revoked_at IS NULL;"
```

## 11. 備份與還原

所有資料都在資料庫中；另外請保存 `config.php`（含設定碼與資料庫密碼）。

- **cPanel**：**Backup › Download a MySQL Database Backup**，或 phpMyAdmin 的 **匯出**（Export）。
- **指令**：

  ```sh
  mysqldump --single-transaction --no-tablespaces --default-character-set=utf8mb4 \
    -u fleetdispatch -p fleetdispatch > fleetdispatch-$(date +%F).sql
  ```

- **每天自動備份**（cron）：先把帳號密碼存在 `~/.my.cnf`（權限 `600`），就不必寫在指令裡：

  ```ini
  [mysqldump]
  user=fleetdispatch
  password=資料庫密碼
  ```

  ```cron
  0 3 * * * mkdir -p $HOME/backups && mysqldump --single-transaction --no-tablespaces fleetdispatch | gzip > $HOME/backups/fleetdispatch-$(date +\%F).sql.gz
  ```

- **還原**（會覆蓋資料庫中的資料表）：

  ```sh
  mysql -u fleetdispatch -p fleetdispatch < fleetdispatch-2026-11-02.sql
  ```

  還原後，各裝置會在下一次同步時以主機的資料為準。

- **SQLite**：主機執行中也可以安全備份：

  ```sh
  sqlite3 /home/帳號/fleetdispatch/data/fleetdispatch.sqlite ".backup '/home/帳號/backups/fleetdispatch-$(date +%F).sqlite'"
  ```

## 12. 更新主機程式

1. 先備份（第 11 節）。
2. 下載新版本，覆蓋 `src/`、`schema/`，以及網站根目錄的 `index.php`、`.htaccess`（方法 B 是你複製到 `public_html` 的那兩個檔案）。
   **保留** `config.php` 與 `data/`（SQLite）。如果改過 `index.php` 開頭的 `$fdAppDir`，更新後要再改一次。
3. 打開 `https://fleet.example.com/api/v1/info`，確認 `serverVersion` 是新的版本。

新版本若需要變更資料庫，版本說明會另外註明。

## 13. 疑難排解

| 現象 | 原因與處理 |
| --- | --- |
| 網頁伺服器的 404 頁面（不是 JSON） | 網址改寫沒有作用：`.htaccess` 沒有上傳（隱藏檔）、Apache 沒有啟用 mod_rewrite，或不允許 `.htaccess`（VPS：`AllowOverride All`）。暫時可以改用 `https://<主機>/<路徑>/index.php` 當基底網址（API 變成 `…/index.php/api/v1/…`） |
| `{"error":{"code":"not_found",…}}` | 程式正常；只有 `…/api/v1/…` 底下的網址有內容，請確認 App 輸入的是基底網址 |
| 500，訊息「主機設定錯誤：找不到設定檔 config.php」 | 還沒建立 `config.php`，或它不在程式資料夾（`src/` 的上一層） |
| 500，訊息「主機設定錯誤：設定檔 config.php 有語法錯誤」 | 編輯時少了引號、逗號或括號；行號寫在 PHP 的錯誤日誌 |
| 500，訊息「主機設定錯誤：無法連線到資料庫」 | `db.dsn`、帳號或密碼錯誤，使用者沒有這個資料庫的權限，或資料庫沒有執行。詳細原因寫在 PHP 的錯誤日誌 |
| 500，訊息「主機設定錯誤：PHP 沒有啟用 pdo_mysql 擴充功能」 | 在控制台的 PHP 設定中啟用 `pdo_mysql`（SQLite 是 `pdo_sqlite`） |
| 500，訊息「FleetDispatch Server 需要 PHP 8.1 以上」 | 在控制台把這個網域的 PHP 版本改成 8.1 以上 |
| 500，訊息「找不到 FleetDispatch Server 的程式資料夾」 | 方法 B 的資料夾名稱或位置不同：設定 `index.php` 開頭的 `$fdAppDir` |
| 500，訊息「主機內部錯誤」，或空白／HTML 的錯誤頁 | 查看 PHP 的錯誤日誌（cPanel：**Errors** 或網站資料夾中的 `error_log`；VPS：網頁伺服器與 PHP-FPM 的 log）。紀錄以 `[fleetdispatch-server]` 開頭 |
| 配對成功後一直回 `401 unauthorized` | 先用第 8 節的 curl 測試：回覆「需要權杖」表示 `Authorization` 標頭沒有傳到 PHP，請確認 `.htaccess` 已上傳；仍然不行時，把 `.htaccess` 最後一行 `# CGIPassAuth On` 前面的 `#` 拿掉（主機不允許時網站會變成 500，請再加回去）。nginx 請確認有 `include fastcgi_params;`。其他情況是裝置被管理員解除配對，或權杖 90 天沒有使用而過期，請重新配對 |
| `401 invalid_code` | 配對碼打錯、已經用過或過期；設定碼只在主機沒有管理員時有效，其他裝置請用配對碼 |
| `409 setup_not_configured` | `config.php` 沒有設定 `setup_token`，或少於 16 個字元 |
| `409 device_conflict` | 這台裝置仍在配對中：請管理員先在 App 解除配對這台裝置 |
| `429 rate_limited`（嘗試太多次） | 同一個 IP 在 15 分鐘內配對失敗 10 次，等 15 分鐘。放在反向代理後面卻沒有設定 `trust_proxy` 時，所有裝置會被當成同一個 IP |
| `413`（或 nginx 的 413 錯誤頁） | 一次送出的資料超過 5 MB；nginx 請設定 `client_max_body_size 6m;`，PHP 的 `post_max_size` 至少 6 MB |
| 管理功能（改角色、解除配對、刪除配對碼）回主機商的 403 錯誤頁 | 主機的 ModSecurity／防火牆擋住了 `PATCH`、`DELETE` 方法；在 cPanel 的 **ModSecurity** 對這個網域停用，或請主機商放行 |
| App 顯示「請使用 HTTPS」或憑證錯誤 | 對外網址必須是 HTTPS，且憑證有效、網域相符（第 6 節） |
