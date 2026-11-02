<?php

declare(strict_types=1);

namespace FleetDispatch;

/** 權杖、配對碼與雜湊（對應 core/src/crypto.ts）。亂數一律用 random_bytes／random_int（密碼學安全、沒有偏差）。 */
final class Crypto
{
    /** 配對碼字母表（排除易混淆的 0、1、I、L、O）。 */
    private const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

    /** SHA-256（十六進位小寫）。 */
    public static function sha256Hex(string $text): string
    {
        return hash('sha256', $text);
    }

    /** 32 位元組隨機權杖（base64url，無 padding，43 個字元）。 */
    public static function newToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    /** 8 個字元的配對碼，顯示為 XXXX-XXXX。 */
    public static function newPairingCode(): string
    {
        $alphabet = self::PAIRING_ALPHABET;
        $max = strlen($alphabet) - 1;
        $out = '';
        for ($i = 0; $i < 8; $i++) {
            $out .= $alphabet[random_int(0, $max)];
        }
        return substr($out, 0, 4) . '-' . substr($out, 4);
    }

    /** 比對用的配對碼：去除空白與連字號、轉大寫。 */
    public static function normalizePairingCode(string $code): string
    {
        return Util::upper(Util::stripSpaceAndDash($code));
    }

    /** 常數時間比較：比較兩者的 SHA-256，內容與長度都不會影響比較時間。 */
    public static function constantTimeEqual(string $a, string $b): bool
    {
        return hash_equals(hash('sha256', $a), hash('sha256', $b));
    }

    /** 隨機 UUID（第 4 版，大寫）。 */
    public static function uuid4(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0F) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3F) | 0x80);
        $h = bin2hex($b);
        return strtoupper(substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20, 12));
    }
}
