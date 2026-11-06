<?php
// FleetDispatch Server（PHP 版）設定檔範例。
//
// 使用方式：複製這個檔案成 config.php（放在同一個資料夾），再填入下面的設定。
// config.php 含資料庫密碼與設定碼：不要放在網站可以直接下載的位置，也不要提交到版本控制（.gitignore 已排除）。
// 詳細說明見 docs/setup-php-mysql.md。

return [
    // 第一次設定用的「設定碼」（至少 16 個字元）。App 第一次連線時把它當成配對碼輸入，那台裝置就成為管理員；
    // 之後設定碼不再有效。可以用這個指令產生一組：
    //   php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
    'setup_token' => '',

    // 資料庫（建議 MySQL 8.0 以上或 MariaDB 10.6 以上）。
    // host 通常是 localhost；dbname、user、password 換成主機控制台建立的資料庫名稱、使用者與密碼。
    'db' => [
        'dsn' => 'mysql:host=localhost;dbname=fleetdispatch;charset=utf8mb4',
        'user' => 'fleetdispatch',
        'password' => '',
    ],

    // 測試或很小的主機也可以改用 SQLite（不需要 MySQL）。資料夾必須可寫入，而且不能被網站直接下載。
    // 使用時把上面的 'db' 整段換成：
    // 'db' => [
    //     'dsn' => 'sqlite:' . __DIR__ . '/data/fleetdispatch.sqlite',
    // ],

    // 第一次初始化時的主機名稱（之後由管理員在 App 或網頁管理修改）。
    'server_name' => 'FleetDispatch Server',

    // 網頁管理的網址（https://<主機>/admin）。對外服務時建議改成不容易猜到的路徑，例如 '/manage-7k2q9'；
    // 設為 'off' 關閉網頁管理。首頁顯示 FleetDispatch App 的介紹與下載連結。
    'admin_path' => '/admin',

    // 修改前後歷史保留的天數（選填）：0 或不寫＝不自動刪除；設定時至少 30 天，較舊的歷史自動刪除
    // （歷史含駕駛人的個資；稽核紀錄不刪除）。見 docs/audit-history.md §4。
    // 'history_retention_days' => 730,

    // 前面有幾層「你自己控制的」反向代理（用來取得真實的來源 IP，配對嘗試次數限制會用到）：
    //   0 = PHP 直接面對網際網路（一般虛擬主機、Apache／nginx 直接跑 PHP）：不採信 X-Forwarded-For。
    //   1 = 前面剛好有一層反向代理（例如 Cloudflare 代理、另一台 nginx、主機商的 nginx 前端）。
    // 設為 N 時，取 X-Forwarded-For 從右邊數來第 N 個位址（最左邊的值可以被用戶端偽造，不會採用）。
    // 不確定時保持 0；設得比實際層數多，用戶端就能假造來源 IP。
    'trust_proxy' => 0,
];
