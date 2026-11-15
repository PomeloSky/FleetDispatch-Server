<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 網頁管理的登入（1.2.0；對應 core/src/web-session.ts，docs/security-review.md §1）：權杖由主機以 HttpOnly Cookie 保存，
 * 網頁的程式讀不到。App 照舊以 Authorization: Bearer 傳送權杖。
 */
final class WebSession
{
    /** 不記住這個瀏覽器：閒置 2 小時或登入 12 小時後失效；記住：閒置 30 天或登入 90 天後失效。 */
    public const LIFETIME = [
        'session' => ['idleMs' => 2 * 3600 * 1000, 'maxMs' => 12 * 3600 * 1000],
        'remember' => ['idleMs' => 30 * 24 * 3600 * 1000, 'maxMs' => 90 * 24 * 3600 * 1000],
    ];

    /** 網頁登入的最後使用時間與閒置期限最多每 5 分鐘更新一次。 */
    public const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

    /** 1.0–1.1 的網頁權杖（存在瀏覽器）升級後不再延長、最多再用 30 天。 */
    public const LEGACY_WEB_TTL_MS = 30 * 24 * 3600 * 1000;

    public const CSRF_HEADER = 'X-FleetDispatch-CSRF';
    private const COOKIE = 'fd_admin';
    private const SECURE_COOKIE = '__Secure-fd_admin';
    private const TOKEN = '/^[A-Za-z0-9_-]{20,200}\z/';
    private const BASE = '#^(/[A-Za-z0-9._~-]+)*\z#';

    /** 資料庫的 web_session 欄位：session、remember；其他值（App 與 1.1 的網頁權杖是 NULL）回傳 null。 */
    public static function kind(mixed $v): ?string
    {
        return $v === 'session' || $v === 'remember' ? $v : null;
    }

    /** 這次登入現在的有效期限：閒置期限與登入期限中較早的。 */
    public static function expiry(string $kind, int $now, int $until): int
    {
        return min($now + self::LIFETIME[$kind]['idleMs'], $until);
    }

    /** Cookie 的路徑：`<基底路徑>/api/v1`。基底路徑有其他字元時只用 `/api/v1`。 */
    public static function cookiePath(string $path): string
    {
        $i = strpos($path, '/api/v1');
        $base = $i === false ? '' : substr($path, 0, $i);
        return (preg_match(self::BASE, $base) === 1 ? $base : '') . '/api/v1';
    }

    /** 請求帶的登入 Cookie（`__Secure-` 優先）；沒有或格式不對時回傳 null。 */
    public static function readCookie(Request $req): ?string
    {
        $header = $req->header('Cookie');
        if ($header === null || $header === '') {
            return null;
        }
        $plain = null;
        foreach (explode(';', $header) as $part) {
            $eq = strpos($part, '=');
            if ($eq === false) {
                continue;
            }
            $name = Util::jsTrim(substr($part, 0, $eq));
            $value = Util::jsTrim(substr($part, $eq + 1));
            if (preg_match(self::TOKEN, $value) !== 1) {
                continue;
            }
            if ($name === self::SECURE_COOKIE) {
                return $value;
            }
            if ($name === self::COOKIE && $plain === null) {
                $plain = $value;
            }
        }
        return $plain;
    }

    /** 設定登入 Cookie 的 Set-Cookie 值。不記住時不給 Max-Age（瀏覽器關閉時刪除）。 */
    public static function cookie(Request $req, string $token, string $kind, int $until, int $now): string
    {
        $secure = $req->isHttps();
        $parts = [($secure ? self::SECURE_COOKIE : self::COOKIE) . '=' . $token, 'Path=' . self::cookiePath($req->path), 'HttpOnly', 'SameSite=Strict'];
        if ($secure) {
            $parts[] = 'Secure';
        }
        if ($kind === 'remember') {
            $parts[] = 'Max-Age=' . max(0, intdiv($until - $now, 1000));
        }
        return implode('; ', $parts);
    }

    /** 刪除登入 Cookie（登出）。 */
    public static function clearCookie(Request $req): string
    {
        $secure = $req->isHttps();
        $parts = [($secure ? self::SECURE_COOKIE : self::COOKIE) . '=', 'Path=' . self::cookiePath($req->path), 'HttpOnly', 'SameSite=Strict'];
        if ($secure) {
            $parts[] = 'Secure';
        }
        $parts[] = 'Max-Age=0';
        return implode('; ', $parts);
    }

    /** CSRF 權杖：由登入權杖推導（不另外保存；推不回權杖）。 */
    public static function csrfToken(string $token): string
    {
        return substr(hash('sha256', 'fd-csrf:' . $token), 0, 32);
    }

    /** 瀏覽器告知這是跨站或跨來源的請求（Sec-Fetch-Site 有送且不是 same-origin）。 */
    public static function crossSite(Request $req): bool
    {
        $site = $req->header('Sec-Fetch-Site');
        return $site !== null && strtolower(Util::jsTrim($site)) !== 'same-origin';
    }

    /** Content-Type 是 JSON（可以帶 charset）。 */
    public static function isJsonContent(Request $req): bool
    {
        $type = $req->contentType() ?? '';
        $semi = strpos($type, ';');
        return strtolower(Util::jsTrim($semi === false ? $type : substr($type, 0, $semi))) === 'application/json';
    }
}
