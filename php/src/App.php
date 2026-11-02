<?php

declare(strict_types=1);

namespace FleetDispatch;

/** 一個請求的完整處理：錯誤處理、設定、資料庫、路由與輸出。 */
final class App
{
    private static int $bufferLevel = 0;
    private static bool $responded = false;

    public static function run(string $appDir): void
    {
        ini_set('display_errors', '0');        // 錯誤只寫進日誌，不出現在回應中
        ini_set('serialize_precision', '-1');  // 浮點數以可完整還原的最短表示法輸出（JSON 與資料庫參數）
        ini_set('precision', '-1');
        self::$bufferLevel = ob_get_level();
        ob_start();                            // 收掉意外的輸出（例如 config.php 前後的空白或 BOM）
        set_error_handler([self::class, 'onError']);
        register_shutdown_function([self::class, 'onShutdown']);

        self::respond(self::handle(Request::fromGlobals(), $appDir));
    }

    private static function handle(Request $request, string $appDir): Response
    {
        try {
            $config = null;
            $setupError = null;
            $configPath = self::configPath($appDir);
            try {
                $config = Config::load($configPath);
            } catch (SetupError $e) {
                $setupError = $e;
            }
            // 網頁（不需要資料庫）：管理頁只在設定的管理網址出現（設定檔有問題時仍以預設網址提供，頁面會顯示 /info 回報的設定錯誤）；
            // 首頁是 App 介紹，瀏覽器開啟找不到的網址也顯示首頁（404）。
            $adminPath = $config !== null ? $config->adminPath : Web::DEFAULT_ADMIN_PATH;
            $path = Api::apiPath($request->path);
            if ($request->method === 'GET' || $request->method === 'HEAD') {
                if ($adminPath !== null) {
                    $hit = Web::match($request->path, $adminPath);
                    if ($hit !== null) {
                        return Web::response($hit[0], $hit[1], $adminPath, $appDir);
                    }
                }
                if ($path === null && Web::isHome($request->path, $request->scriptDir())) {
                    return Web::home(200, $appDir);
                }
                if ($path === null && $request->acceptsHtml()) {
                    return Web::home(404, $appDir);
                }
            }
            if ($path === null) {
                throw new ApiError(404, 'not_found', '找不到這個端點');
            }
            if ($setupError !== null || $config === null) {
                // 還沒有 config.php：安裝精靈的端點（網頁管理的安裝畫面使用）。安裝完成後這些路徑照一般 API 回 404。
                if ($setupError instanceof MissingConfig && ($path === 'install' || $path === 'install/test')) {
                    return Installer::handle($request, $path, $appDir, $configPath);
                }
                throw $setupError ?? new SetupError('找不到設定檔');
            }
            $db = Db::connect($config);
            $db->ensureSchema($appDir . '/schema', $config->serverName);
            return (new Api($request, $config, $db))->route($path);
        } catch (ApiError $e) {
            return Response::error($e);
        } catch (SetupError $e) {
            error_log('[fleetdispatch-server] ' . $e->getMessage());
            return Response::error(new ApiError(500, 'server_error', '主機設定錯誤：' . $e->getMessage()));
        } catch (\Throwable $e) {
            // 不洩漏內部細節（堆疊、SQL、檔案路徑）；PHP 的錯誤日誌看得到。
            self::logThrowable($e);
            return Response::error(new ApiError(500, 'server_error', '主機內部錯誤'));
        }
    }

    private static function respond(Response $response): void
    {
        try {
            $body = $response->encodeBody();
        } catch (\Throwable $e) {
            self::logThrowable($e);
            $response = Response::error(new ApiError(500, 'server_error', '主機內部錯誤'));
            $body = $response->encodeBody();
        }
        $response->send($body, self::$bufferLevel);
        self::$responded = true;
    }

    /** 設定檔位置：環境變數 FD_PHP_CONFIG（測試或把設定放在別處時用），否則是程式資料夾裡的 config.php。 */
    private static function configPath(string $appDir): string
    {
        $candidates = [getenv('FD_PHP_CONFIG'), $_SERVER['FD_PHP_CONFIG'] ?? null, $_SERVER['REDIRECT_FD_PHP_CONFIG'] ?? null];
        foreach ($candidates as $v) {
            if (is_string($v) && $v !== '') {
                return $v;
            }
        }
        return $appDir . '/config.php';
    }

    /** 記錄例外：只記類別、訊息與位置，不記堆疊（堆疊的參數可能含權杖或密碼）。 */
    public static function logThrowable(\Throwable $e): void
    {
        error_log(sprintf('[fleetdispatch-server] %s: %s (%s:%d)', get_class($e), $e->getMessage(), basename($e->getFile()), $e->getLine()));
    }

    /** PHP 的警告與注意事項轉成例外（回 500，不會混進 JSON）；棄用通知交給 PHP 依主機設定處理。 */
    public static function onError(int $severity, string $message, string $file = '', int $line = 0): bool
    {
        if ((error_reporting() & $severity) === 0) {
            return false; // 以 @ 抑制的錯誤
        }
        if ($severity === E_DEPRECATED || $severity === E_USER_DEPRECATED) {
            return false;
        }
        throw new \ErrorException($message, 0, $severity, $file, $line);
    }

    /** 致命錯誤（記憶體不足、執行逾時…）時仍回 JSON 格式的 500。 */
    public static function onShutdown(): void
    {
        if (self::$responded) {
            return;
        }
        $e = error_get_last();
        if ($e === null || !in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR], true)) {
            return;
        }
        self::$responded = true;
        $response = Response::error(new ApiError(500, 'server_error', '主機內部錯誤'));
        $response->send($response->encodeBody(), self::$bufferLevel);
    }
}
