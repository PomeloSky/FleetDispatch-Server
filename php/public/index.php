<?php
// FleetDispatch Server（PHP 版）的進入點。網站根目錄（document root）指向這個資料夾（php/public）。
// 也可以直接當成 PHP 內建伺服器的 router（只用於測試）：php -S 127.0.0.1:8080 php/public/index.php
//
// 這個檔案刻意只用舊版 PHP 也看得懂的語法，PHP 版本太舊時才能回覆清楚的錯誤訊息。

ini_set('display_errors', '0');

// 程式資料夾（裡面有 src/、schema/、config.php）。留空時自動尋找：
//   1. 環境變數 FD_APP_DIR
//   2. 這個檔案的上一層（標準配置：php/public/index.php → php/）
//   3. 往上各層資料夾裡名為 fleetdispatch 的資料夾（例如 ~/public_html/index.php → ~/fleetdispatch/）
// 找不到時，請直接在這裡填入完整路徑，例如 '/home/帳號/fleetdispatch'。
$fdAppDir = '';

if (!function_exists('fd_boot_fail')) {
    function fd_boot_fail($message)
    {
        while (ob_get_level() > 0 && @ob_end_clean()) {
        }
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
        }
        echo json_encode(array('error' => array('code' => 'server_error', 'message' => $message)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}

if (PHP_VERSION_ID < 80100) {
    fd_boot_fail('FleetDispatch Server 需要 PHP 8.1 以上（目前是 ' . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION . '）');
    return;
}
if (!extension_loaded('pdo') || !extension_loaded('json')) {
    fd_boot_fail('PHP 沒有啟用 PDO 或 JSON 擴充功能');
    return;
}

if ($fdAppDir === '') {
    $fdEnv = getenv('FD_APP_DIR');
    if (is_string($fdEnv) && $fdEnv !== '' && @is_file($fdEnv . '/src/fleetdispatch.php')) {
        $fdAppDir = $fdEnv;
    } else {
        $fdDir = __DIR__;
        for ($fdI = 0; $fdI < 6 && $fdAppDir === ''; $fdI++) {
            $fdParent = dirname($fdDir);
            foreach (array($fdParent, $fdParent . '/fleetdispatch') as $fdCandidate) {
                if (@is_file($fdCandidate . '/src/fleetdispatch.php')) {
                    $fdAppDir = $fdCandidate;
                    break;
                }
            }
            if ($fdParent === $fdDir) {
                break;
            }
            $fdDir = $fdParent;
        }
    }
}
if ($fdAppDir === '' || !@is_file($fdAppDir . '/src/fleetdispatch.php')) {
    fd_boot_fail('找不到 FleetDispatch Server 的程式資料夾（src/）；請依部署文件設定 index.php 開頭的 $fdAppDir');
    return;
}

// 載入程式之前的致命錯誤（例如檔案不完整）也回 JSON；載入之後由 App 自己處理。
register_shutdown_function(static function () {
    if (class_exists('FleetDispatch\App', false)) {
        return;
    }
    $e = error_get_last();
    if ($e !== null && in_array($e['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        fd_boot_fail('主機內部錯誤');
    }
});

require $fdAppDir . '/src/fleetdispatch.php';
\FleetDispatch\App::run($fdAppDir);
