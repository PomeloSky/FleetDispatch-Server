<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 共用小工具（對應 core/src/util.ts）。
 * 字串長度、修剪與大小寫轉換都依 JavaScript 的規則計算，讓 PHP 版與 TypeScript 版的檢查結果一致。
 */
final class Util
{
    /** 2001-01-01 UTC 與 1970-01-01 UTC 相差的秒數。 */
    public const APPLE_EPOCH_OFFSET = 978307200;

    /** JavaScript 的 Number.MAX_SAFE_INTEGER。 */
    public const MAX_SAFE_INTEGER = 9007199254740991;

    /** JavaScript 的 trim() 與正規表示式 `\s` 視為空白的字元（用在 /u 的字元類別中）。 */
    public const JS_SPACE = '\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

    public static function nowMs(): int
    {
        return (int) floor(microtime(true) * 1000);
    }

    public static function msToApple(int $ms): float
    {
        return $ms / 1000.0 - self::APPLE_EPOCH_OFFSET;
    }

    public static function isUuid(mixed $v): bool
    {
        return is_string($v)
            && preg_match('/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\z/', $v) === 1;
    }

    /** 合法的 UUID 轉大寫；不合法回傳 null。 */
    public static function normalizeUuid(mixed $v): ?string
    {
        return self::isUuid($v) ? strtoupper($v) : null;
    }

    /** 字串（含空字串）原樣回傳，其他型別回傳 null。 */
    public static function str(mixed $v): ?string
    {
        return is_string($v) ? $v : null;
    }

    /** 有限的 JSON 數字；其他型別（含布林、字串）回傳 null。 */
    public static function num(mixed $v): int|float|null
    {
        if (is_int($v)) {
            return $v;
        }
        if (is_float($v) && is_finite($v)) {
            return $v;
        }
        return null;
    }

    /** JavaScript 的 toUpperCase()：有 mbstring 時做完整的 Unicode 大小寫對應，否則只轉 ASCII。 */
    public static function upper(string $s): string
    {
        return function_exists('mb_strtoupper') ? mb_strtoupper($s, 'UTF-8') : strtoupper($s);
    }

    /** JavaScript 的 trim()（含全形空白等 Unicode 空白）。 */
    public static function jsTrim(string $s): string
    {
        $out = preg_replace('/^[' . self::JS_SPACE . ']+|[' . self::JS_SPACE . ']+\z/u', '', $s);
        return $out ?? $s;
    }

    /** 移除所有 JavaScript `\s` 空白與連字號（配對碼比對用）。 */
    public static function stripSpaceAndDash(string $s): string
    {
        $out = preg_replace('/[' . self::JS_SPACE . '-]/u', '', $s);
        return $out ?? $s;
    }

    /** JavaScript 的字串長度（UTF-16 單位數）。輸入必須是合法的 UTF-8。 */
    public static function utf16Length(string $s): int
    {
        $n = 0;
        foreach (count_chars($s, 1) as $byte => $count) {
            if ($byte < 0x80 || $byte >= 0xC0) {
                $n += $count; // ASCII 或多位元組字元的第一個位元組
            }
            if ($byte >= 0xF0) {
                $n += $count; // 4 位元組的字元在 UTF-16 是代理對（2 個單位）
            }
        }
        return $n;
    }

    /** JavaScript 的 slice(0, max)（以 UTF-16 單位計）。 */
    public static function utf16Slice(string $s, int $max): string
    {
        if (strlen($s) <= $max) {
            return $s;
        }
        $units = 0;
        $len = strlen($s);
        for ($i = 0; $i < $len; $i++) {
            $b = ord($s[$i]);
            if (($b & 0xC0) === 0x80) {
                continue;
            }
            $w = $b >= 0xF0 ? 2 : 1;
            if ($units + $w > $max) {
                // JavaScript 會留下半個代理對，存進資料庫後變成 U+FFFD；這裡得到相同的結果。
                return substr($s, 0, $i) . ($units < $max ? "\u{FFFD}" : '');
            }
            $units += $w;
        }
        return $s;
    }

    /** 前 n 個 Unicode 字元（JavaScript 的 `[...s].slice(0, n).join('')`）。 */
    public static function firstCodePoints(string $s, int $n): string
    {
        if (strlen($s) <= $n) {
            return $s;
        }
        $count = 0;
        $len = strlen($s);
        for ($i = 0; $i < $len; $i++) {
            if ((ord($s[$i]) & 0xC0) !== 0x80) {
                if ($count === $n) {
                    return substr($s, 0, $i);
                }
                $count++;
            }
        }
        return $s;
    }

    /** 名稱類欄位：去除前後空白，長度 1–max（UTF-16 單位）。 */
    public static function cleanName(mixed $v, int $max): ?string
    {
        if (!is_string($v)) {
            return null;
        }
        $t = self::jsTrim($v);
        $len = self::utf16Length($t);
        return $len >= 1 && $len <= $max ? $t : null;
    }

    /** 查詢參數的非負整數；沒有給或空字串時用預設值，超出範圍時夾在 min–max 之間。 */
    public static function intParam(Request $req, string $key, int $fallback, int $min, int $max): int
    {
        $raw = $req->query($key);
        if ($raw === null || $raw === '') {
            return $fallback;
        }
        if (preg_match('/^[0-9]+\z/', $raw) !== 1) {
            throw ApiError::badRequest("{$key} 必須是非負整數");
        }
        $digits = ltrim($raw, '0');
        if ($digits === '') {
            $n = 0;
        } elseif (strlen($digits) > 16 || (int) $digits > self::MAX_SAFE_INTEGER) {
            throw ApiError::badRequest("{$key} 太大");
        } else {
            $n = (int) $digits;
        }
        return min(max($n, $min), $max);
    }
}
