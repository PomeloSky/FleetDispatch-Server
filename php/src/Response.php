<?php

declare(strict_types=1);

namespace FleetDispatch;

/** HTTP 回應：一律是 JSON（204 沒有本體），加上 no-store、nosniff，不送 CORS 標頭。 */
final class Response
{
    /**
     * @param array<string, string> $headers
     */
    public function __construct(
        public readonly int $status,
        public readonly mixed $body = null,
        public readonly array $headers = [],
    ) {
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
