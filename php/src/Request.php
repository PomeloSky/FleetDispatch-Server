<?php

declare(strict_types=1);

namespace FleetDispatch;

/** 目前的 HTTP 請求（從 $_SERVER 與 php://input 讀取）。 */
final class Request
{
    private ?string $body = null;

    /**
     * @param array<string, mixed> $server
     */
    private function __construct(
        public readonly string $method,
        /** 原始的請求路徑（不含查詢字串，未解碼）。 */
        public readonly string $path,
        private readonly string $queryString,
        private readonly array $server,
    ) {
    }

    public static function fromGlobals(): self
    {
        /** @var array<string, mixed> $server */
        $server = $_SERVER;
        $method = strtoupper(self::serverString($server, 'REQUEST_METHOD') ?? 'GET');
        // REQUEST_URI 是用戶端送來的原始路徑（Apache、nginx、PHP 內建伺服器都有）；IIS 改寫後放在其他變數。
        $uri = self::serverString($server, 'REQUEST_URI')
            ?? self::serverString($server, 'HTTP_X_ORIGINAL_URL')
            ?? self::serverString($server, 'UNENCODED_URL');
        if ($uri === null || $uri === '') {
            $uri = (self::serverString($server, 'SCRIPT_NAME') ?? '') . (self::serverString($server, 'PATH_INFO') ?? '');
            $qs = self::serverString($server, 'QUERY_STRING') ?? '';
            if ($qs !== '') {
                $uri .= '?' . $qs;
            }
        }
        $q = strpos($uri, '?');
        $path = $q === false ? $uri : substr($uri, 0, $q);
        $query = $q === false ? '' : substr($uri, $q + 1);
        if ($path !== '' && $path[0] !== '/') {
            // 絕對形式（http://host/path）。
            $p = parse_url($path, PHP_URL_PATH);
            $path = is_string($p) ? $p : '/';
        }
        return new self($method, $path, $query, $server);
    }

    /** @param array<string, mixed> $server */
    private static function serverString(array $server, string $key): ?string
    {
        $v = $server[$key] ?? null;
        return is_string($v) ? $v : null;
    }

    /** 查詢參數（與 URLSearchParams.get 相同：取第一個、`+` 視為空白）；沒有時回傳 null。 */
    public function query(string $key): ?string
    {
        if ($this->queryString === '') {
            return null;
        }
        foreach (explode('&', $this->queryString) as $pair) {
            if ($pair === '') {
                continue;
            }
            $eq = strpos($pair, '=');
            $name = urldecode($eq === false ? $pair : substr($pair, 0, $eq));
            if ($name === $key) {
                return $eq === false ? '' : urldecode(substr($pair, $eq + 1));
            }
        }
        return null;
    }

    /** Authorization 標頭（Apache 的 CGI／FastCGI 模式由 .htaccess 轉成 HTTP_AUTHORIZATION 環境變數）。 */
    /** 進入點（index.php）所在的網址路徑，例如 /fleet；在網站根目錄時是空字串。首頁判斷用。 */
    public function scriptDir(): string
    {
        $script = self::serverString($this->server, 'SCRIPT_NAME') ?? '';
        $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');
        return $dir === '.' ? '' : $dir;
    }

    /** 瀏覽器開啟的請求（Accept 有 text/html）。 */
    public function acceptsHtml(): bool
    {
        return str_contains(strtolower(self::serverString($this->server, 'HTTP_ACCEPT') ?? ''), 'text/html');
    }

    public function authorization(): string
    {
        foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
            $v = self::serverString($this->server, $key);
            if ($v !== null && $v !== '') {
                return $v;
            }
        }
        if (function_exists('getallheaders')) {
            $headers = getallheaders();
            if (is_array($headers)) {
                foreach ($headers as $name => $value) {
                    if (strcasecmp((string) $name, 'Authorization') === 0 && is_string($value)) {
                        return $value;
                    }
                }
            }
        }
        return '';
    }

    /** 宣告的 Content-Length（沒有或不是數字時為 0）。 */
    public function declaredLength(): float
    {
        $v = self::serverString($this->server, 'CONTENT_LENGTH') ?? self::serverString($this->server, 'HTTP_CONTENT_LENGTH') ?? '';
        return is_numeric($v) ? (float) $v : 0.0;
    }

    /** 請求本體（最多讀 $max + 1 個位元組，用來判斷是否超過上限）。 */
    public function body(int $max): string
    {
        if ($this->body === null) {
            $data = @file_get_contents('php://input', false, null, 0, $max + 1);
            $this->body = is_string($data) ? $data : '';
        }
        return $this->body;
    }

    /**
     * 來源 IP（配對嘗試次數限制用）。預設是連線的位址（REMOTE_ADDR）；設定了信任的反向代理層數 N（≥ 1）時，
     * 取 X-Forwarded-For 從右邊數來第 N 個值（最近的 N 層代理附加的）。最左邊的值由用戶端自己填、可以偽造，不採用；
     * 值不夠 N 個時用 REMOTE_ADDR。
     */
    public function clientIp(int $trustedProxies): string
    {
        $remote = substr(self::serverString($this->server, 'REMOTE_ADDR') ?? '', 0, 64);
        if ($trustedProxies < 1) {
            return $remote;
        }
        $entries = [];
        foreach (explode(',', self::serverString($this->server, 'HTTP_X_FORWARDED_FOR') ?? '') as $part) {
            $part = trim($part);
            if ($part !== '') {
                $entries[] = $part;
            }
        }
        $ip = $entries[count($entries) - $trustedProxies] ?? null;
        // 資料庫欄位最多 64 個字元；不合理的值（非 ASCII 可見字元）改用連線的位址。
        if ($ip === null || strlen($ip) > 64 || preg_match('/^[\x21-\x7E]+\z/', $ip) !== 1) {
            return $remote;
        }
        return $ip;
    }
}
