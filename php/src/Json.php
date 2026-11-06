<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * JSON 編碼與解碼。
 * - 物件一律解碼成 stdClass（不用關聯陣列），空物件 `{}` 重新編碼後仍是物件、`"0"` 之類的鍵也不會變成陣列。
 * - 編碼與 JavaScript 的 JSON.stringify 相容：不跳脫中文、斜線與 U+2028／U+2029，Infinity／NaN 輸出 null。
 */
final class Json
{
    public const FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE;
    public const DEPTH = 512;

    /**
     * App 送來的資料內容最多 64 層陣列或物件（json_decode 的 depth 是層數加 1；與 core/src/rules.ts 的 MAX_PAYLOAD_NESTING 相同）。
     * 回應會把內容放進幾層外框再編碼，所以要比 DEPTH 小得多（docs/security-review.md §4.7）。
     */
    public const PAYLOAD_DEPTH = 65;

    /** 解析 JSON 物件；格式錯誤、超過深度或不是物件時回傳 null。 */
    public static function decodeObject(string $text, int $depth = self::DEPTH): ?\stdClass
    {
        $v = json_decode($text, false, $depth);
        return $v instanceof \stdClass ? $v : null;
    }

    /** 是否是合法的 JSON 物件文字（不保留解碼結果）。 */
    public static function isObjectText(string $text): bool
    {
        $t = ltrim($text, " \t\n\r");
        if ($t === '' || $t[0] !== '{') {
            return false;
        }
        if (function_exists('json_validate')) {
            return json_validate($text, self::DEPTH);
        }
        json_decode($text, false, self::DEPTH);
        return json_last_error() === JSON_ERROR_NONE;
    }

    /** 編碼成 JSON（Infinity／NaN 與 JSON.stringify 一樣輸出 null）。 */
    public static function encode(mixed $v): string
    {
        $out = json_encode($v, self::FLAGS, self::DEPTH);
        if ($out === false && json_last_error() === JSON_ERROR_INF_OR_NAN) {
            $out = json_encode(self::finite($v), self::FLAGS, self::DEPTH);
        }
        if ($out === false) {
            throw new \RuntimeException('JSON 編碼失敗：' . json_last_error_msg());
        }
        return $out;
    }

    /**
     * 回應本體的編碼：陣列與關聯陣列逐層組合，RawJson 直接嵌入（資料內容不必解碼再編碼），其他值照 encode()。
     */
    public static function encodeResponse(mixed $v): string
    {
        if ($v instanceof RawJson) {
            return $v->json;
        }
        if (is_array($v)) {
            $parts = [];
            if (array_is_list($v)) {
                foreach ($v as $item) {
                    $parts[] = self::encodeResponse($item);
                }
                return '[' . implode(',', $parts) . ']';
            }
            foreach ($v as $k => $item) {
                $parts[] = self::encode((string) $k) . ':' . self::encodeResponse($item);
            }
            return '{' . implode(',', $parts) . '}';
        }
        return self::encode($v);
    }

    /** 內容中是否有 Infinity／NaN（JSON 的超大數字，例如 1e400，解碼後會變成 INF）。 */
    public static function hasNonFinite(mixed $v): bool
    {
        if (is_float($v)) {
            return !is_finite($v);
        }
        if (is_array($v) || $v instanceof \stdClass) {
            foreach ($v as $item) {
                if (self::hasNonFinite($item)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 把 Infinity／NaN 換成 null（JSON.stringify 的行為）。 */
    private static function finite(mixed $v): mixed
    {
        if (is_float($v)) {
            return is_finite($v) ? $v : null;
        }
        if (is_array($v)) {
            foreach ($v as $k => $item) {
                $v[$k] = self::finite($item);
            }
            return $v;
        }
        if ($v instanceof \stdClass) {
            $o = new \stdClass();
            foreach ($v as $k => $item) {
                $o->{$k} = self::finite($item);
            }
            return $o;
        }
        return $v;
    }
}
