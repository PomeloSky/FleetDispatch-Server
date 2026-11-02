<?php

declare(strict_types=1);

namespace FleetDispatch;

/** HTTP 回應：API 一律是 JSON（204 沒有本體），加上 no-store、nosniff，不送 CORS 標頭；網頁管理的頁面與程式用 raw()。 */
final class Response
{
    /**
     * @param array<string, string> $headers
     */
    public function __construct(
        public readonly int $status,
        public readonly mixed $body = null,
        public readonly array $headers = [],
        /** 不經 JSON 編碼、原樣送出的本體（網頁管理）；Content-Type 由 $headers 指定。 */
        public readonly ?string $raw = null,
    ) {
    }

    /**
     * @param array<string, string> $headers
     */
    public static function raw(int $status, string $body, array $headers): self
    {
        return new self($status, null, $headers, $body);
    }

    public static function json(mixed $body, int $status = 200): self
    {
        return new self($status, $body);
    }

    public static function noContent(): self
    {
        return new self(204);
    }

    public static function error(ApiError $e): self
    {
        $headers = [];
        if ($e->retryAfter !== null) {
            $headers['Retry-After'] = (string) $e->retryAfter;
        }
        return new self($e->status, ['error' => ['code' => $e->errorCode, 'message' => $e->getMessage()]], $headers);
    }

    /** 編碼本體（失敗時丟例外，由呼叫者改回 500）。 */
    public function encodeBody(): string
    {
        if ($this->raw !== null) {
            return $this->raw;
        }
        return $this->status === 204 ? '' : Json::encodeResponse($this->body);
    }

    /**
     * 送出回應。$bufferLevel 以上的輸出緩衝區會先丟掉（例如 config.php 前後意外的空白或 BOM），避免弄壞 JSON 與標頭。
     */
    public function send(string $encoded, int $bufferLevel): void
    {
        while (ob_get_level() > $bufferLevel) {
            if (!@ob_end_clean()) {
                break;
            }
        }
        if (!headers_sent()) {
            http_response_code($this->status);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
            foreach ($this->headers as $name => $value) {
                header($name . ': ' . $value);
            }
            header_remove('X-Powered-By');
        }
        if ($this->status !== 204) {
            echo $encoded;
        }
    }
}
