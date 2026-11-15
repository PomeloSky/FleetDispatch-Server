<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 網頁（對應 core/src/web.ts）：首頁是 FleetDispatch App 的介紹與下載連結；管理頁只在設定的管理網址出現。
 * 頁面本身沒有任何機密；管理頁的登入與所有操作都經過公開的 API v1。檔案在 web/（由 scripts/build-web.mjs 從專案根目錄的 web/ 複製）。
 */
final class Web
{
    public const DEFAULT_ADMIN_PATH = '/admin';

    public const HOME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    public const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
        . "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    /**
     * 解析 config.php 的 admin_path：沒有設定時用預設值；空字串、'off' 或 false 表示關閉。
     *
     * @return array{0: ?string, 1: ?string} [管理網址（null 為關閉）, 格式錯誤的訊息]
     */
    public static function parseAdminPath(mixed $raw): array
    {
        if ($raw === null) {
            return [self::DEFAULT_ADMIN_PATH, null];
        }
        if ($raw === false) {
            return [null, null];
        }
        if (!is_string($raw)) {
            return [null, "config.php 的 admin_path 必須是字串（例如 '/admin'），網頁管理已關閉"];
        }
        $v = trim($raw);
        if ($v === '' || strtolower($v) === 'off') {
            return [null, null];
        }
        $segments = array_values(array_filter(explode('/', $v), static fn (string $s): bool => $s !== ''));
        $ok = count($segments) > 0 && strlen($v) <= 100
            && strtolower($segments[0]) !== 'api' && strtolower($segments[0]) !== 'index.php';
        foreach ($segments as $s) {
            if (preg_match('/^[A-Za-z0-9._~-]+$/D', $s) !== 1 || $s === '.' || $s === '..') {
                $ok = false;
            }
        }
        if (!$ok) {
            return [null, "config.php 的 admin_path 格式不正確（例如 '/admin'；只能用英數字與 . _ ~ -，不能以 /api 開頭），網頁管理已關閉"];
        }
        return ['/' . implode('/', $segments), null];
    }

    /**
     * 這個路徑是不是管理頁（page）或它的程式（script）；基底路徑是管理網址前面的部分（子資料夾或 /index.php）。
     *
     * @return array{0: string, 1: string}|null [種類, 基底路徑]
     */
    public static function match(string $path, string $adminPath): ?array
    {
        $p = $path;
        while (strlen($p) > 1 && str_ends_with($p, '/')) {
            $p = substr($p, 0, -1);
        }
        if (str_ends_with($p, $adminPath . '/app.js')) {
            $kind = 'script';
            $base = substr($p, 0, strlen($p) - strlen($adminPath) - strlen('/app.js'));
        } elseif (str_ends_with($p, $adminPath)) {
            $kind = 'page';
            $base = substr($p, 0, strlen($p) - strlen($adminPath));
        } else {
            return null;
        }
        if (preg_match('#^(/[A-Za-z0-9._~-]+)*$#D', $base) !== 1 || str_contains($base, '/api/v1')) {
            return null;
        }
        foreach (explode('/', $base) as $s) {
            if ($s === '.' || $s === '..') {
                return null;
            }
        }
        return [$kind, $base];
    }

    /** 首頁：基底路徑本身（index.php 所在的資料夾），或 …/index.php、…/index.html。 */
    public static function isHome(string $path, string $scriptDir): bool
    {
        $p = rtrim($path, '/');
        if ($p === '' || $p === $scriptDir) {
            return true;
        }
        return preg_match('#^(/[A-Za-z0-9._~-]+)*/index\.(php|html)$#D', $p) === 1;
    }

    /** 首頁（App 介紹與下載連結）；找不到的網址以 404 狀態回應同樣的內容。 */
    public static function home(int $status, string $appDir): Response
    {
        $content = @file_get_contents($appDir . '/web/home.html');
        if (!is_string($content)) {
            throw new SetupError('找不到網頁的檔案 web/home.html（請上傳完整的 php 資料夾）');
        }
        return Response::raw($status, str_replace('{{VERSION}}', Version::SERVER_VERSION, $content), [
            'Content-Type' => 'text/html; charset=utf-8',
            'Cache-Control' => 'no-cache',
            'X-Content-Type-Options' => 'nosniff',
            'Referrer-Policy' => 'no-referrer',
            'Content-Security-Policy' => self::HOME_CSP,
            'X-Frame-Options' => 'DENY',
        ]);
    }

    public static function response(string $kind, string $base, string $adminPath, string $appDir): Response
    {
        $common = [
            'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
            'X-Robots-Tag' => 'noindex, nofollow',
            'Referrer-Policy' => 'no-referrer',
            // 1.2.0：其他網站不能載入管理頁的程式、不能取得管理頁視窗的參照
            'Cross-Origin-Resource-Policy' => 'same-origin',
        ];
        $name = $kind === 'script' ? 'admin.js' : 'admin.html';
        $content = @file_get_contents($appDir . '/web/' . $name);
        if (!is_string($content)) {
            throw new SetupError('找不到網頁管理的檔案 web/' . $name . '（請上傳完整的 php 資料夾）');
        }
        if ($kind === 'script') {
            return Response::raw(200, $content, $common + ['Content-Type' => 'text/javascript; charset=utf-8']);
        }
        $esc = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $html = str_replace(['{{BASE}}', '{{ADMIN}}'], [$esc($base), $esc($adminPath)], $content);
        return Response::raw(200, $html, $common + [
            'Content-Type' => 'text/html; charset=utf-8',
            'Content-Security-Policy' => self::CSP,
            'X-Frame-Options' => 'DENY',
            // 管理頁用不到相機、麥克風、定位等功能（與 core/src/web.ts 的 ADMIN_PAGE_HEADERS 相同）
            'Cross-Origin-Opener-Policy' => 'same-origin',
            'Permissions-Policy' => 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        ]);
    }
}
