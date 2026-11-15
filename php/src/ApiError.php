<?php

declare(strict_types=1);

namespace FleetDispatch;

/** API 錯誤：回應 `{ "error": { "code", "message", …details } }`（docs/protocol.md §10）。 */
final class ApiError extends \RuntimeException
{
    /**
     * @param array<string, mixed>|null $details 錯誤的補充資料（1.2.0），併入 `error` 物件，例如欄位錯誤 `fields`、衝突時的 `current`
     */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly ?int $retryAfter = null,
        public readonly ?array $details = null,
    ) {
        parent::__construct($message);
    }

    public static function badRequest(string $message): self
    {
        return new self(400, 'invalid_request', $message);
    }
}

/**
 * 部署環境的問題（設定檔有誤、資料庫無法連線…）。訊息只含固定的說明文字（不含路徑、SQL 或密碼），
 * 以 `500 server_error` 回給用戶端，方便架設時用 `curl …/api/v1/info` 檢查；詳細原因寫進 PHP 的錯誤日誌。
 */
class SetupError extends \RuntimeException
{
}

/** 還沒有 config.php（尚未安裝）：PHP 版這時提供安裝精靈（Installer）。 */
final class MissingConfig extends SetupError
{
}
