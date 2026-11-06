<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 路由、驗證與各端點（docs/protocol.md；對應 core/src/handler.ts）。
 * 狀態碼、錯誤碼、欄位名稱、檢查順序都與 TypeScript 版相同。
 */
final class Api
{
    public const MAX_EVENTS_PER_REQUEST = 500;
    public const MAX_BODY_BYTES = 5 * 1024 * 1024;
    /** 單筆內容上限（與 TypeScript 版相同，以 JavaScript 字串長度計）。 */
    public const MAX_PAYLOAD_LENGTH = 1024 * 1024;

    private const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;
    private const TOUCH_INTERVAL_MS = 3600 * 1000;
    private const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
    private const MAX_FAILURES = 10;
    private const LOCATION_STALE_MS = 300 * 1000;
    private const LOCATION_TTL_MS = 30 * 60 * 1000;

    /** 可能超出浮點數範圍的數字（指數三位數以上，或三百位以上的數字）；只是預先篩選，符合時才解碼確認。 */
    private const OUT_OF_RANGE_NUMBER = '/[eE]\+?[0-9]{3}|[0-9]{300}/';

    /** 各路徑允許的方法（`*` 是一段任意值）。 */
    private const ROUTES = [
        ['info', ['GET']],
        ['pair', ['POST']],
        // 1.2.0：網頁管理以 HttpOnly Cookie 登入（docs/protocol.md §13.1）
        ['web/login', ['POST']],
        ['web/upgrade', ['POST']],
        ['session', ['GET']],
        ['unpair', ['POST']],
        ['snapshot', ['GET']],
        ['changes', ['GET']],
        ['events', ['POST']],
        ['locations', ['GET', 'POST']],
        ['admin/devices', ['GET']],
        ['admin/devices/*', ['PATCH', 'DELETE']],
        ['admin/pairing-codes', ['GET', 'POST']],
        ['admin/pairing-codes/*', ['DELETE']],
        ['admin/server', ['PATCH']],
        ['admin/audit', ['GET']],
        ['admin/history', ['GET']],
        // 1.2.0：網頁管理的資料查詢與受控修改（docs/protocol.md §7.2–7.6）
        ['admin/schema', ['GET']],
        ['admin/records', ['GET']],
        ['admin/records/*/*', ['GET', 'PATCH']],
        ['admin/records/*/*/impact', ['GET']],
        ['admin/records/*/*/delete', ['POST']],
        ['admin/requests/*/approve', ['POST']],
        ['admin/requests/*/reject', ['POST']],
        // 1.2.0：報表（docs/reports.md）
        ['admin/reports/summary', ['GET']],
        ['admin/reports/export', ['GET']],
    ];

    /** 已處理事件的保留期間（毫秒）。 */
    private const PROCESSED_TTL_MS = 30 * 24 * 3600 * 1000;

    private readonly Repo $repo;
    private readonly string $ip;

    public function __construct(
        private readonly Request $req,
        private readonly Config $config,
        private readonly Db $db,
    ) {
        $this->repo = new Repo($db);
        $this->ip = $req->clientIp($config->trustedProxies);
    }

    /** 取 `/api/v1/` 之後的路徑（支援基底路徑與 `/index.php/api/v1/`）；不是 API 路徑時回傳 null。 */
    public static function apiPath(string $path): ?string
    {
        $i = strpos($path, '/api/v1/');
        if ($i !== false) {
            return rtrim(substr($path, $i + strlen('/api/v1/')), '/');
        }
        if (str_ends_with($path, '/api/v1')) {
            return '';
        }
        return null;
    }

    /**
     * @param list<string> $seg
     * @return array{0: string, 1: list<string>}|null
     */
    private static function matchRoute(array $seg): ?array
    {
        foreach (self::ROUTES as [$pattern, $methods]) {
            $parts = explode('/', $pattern);
            if (count($parts) !== count($seg)) {
                continue;
            }
            $ok = true;
            foreach ($parts as $i => $p) {
                if ($p !== '*' && $p !== $seg[$i]) {
                    $ok = false;
                    break;
                }
            }
            if ($ok) {
                return [$pattern, $methods];
            }
        }
        return null;
    }

    public function route(string $path): Response
    {
        $m = $this->req->method;
        $seg = explode('/', $path);
        $route = self::matchRoute($seg);
        if ($route === null) {
            throw new ApiError(404, 'not_found', '找不到這個端點');
        }
        [$pattern, $methods] = $route;
        if (!in_array($m, $methods, true)) {
            throw new ApiError(405, 'method_not_allowed', '不支援這個方法');
        }
        $is = static fn (string $method, string $p): bool => $m === $method && $pattern === $p;

        if ($is('GET', 'info')) {
            return Response::json($this->info());
        }
        if ($is('POST', 'pair')) {
            return Response::json($this->pair($this->readJson()));
        }
        if ($is('POST', 'web/login')) {
            $this->requireWebRequest();
            return $this->webLogin($this->readJson());
        }
        if ($is('POST', 'web/upgrade')) {
            $this->requireWebRequest();
            return $this->webUpgrade($this->readJson());
        }

        // 以下需要權杖（App：Authorization 標頭；網頁管理：登入 Cookie）。
        $s = $this->authenticate();

        if ($is('GET', 'session')) {
            return Response::json($this->sessionJson($s));
        }
        if ($is('POST', 'unpair')) {
            return $this->unpairSelf($s);
        }
        if ($is('GET', 'snapshot')) {
            return Response::json($this->snapshot($s));
        }
        if ($is('GET', 'changes')) {
            return Response::json($this->changes($s));
        }
        if ($is('POST', 'events')) {
            return Response::json($this->events($s, $this->readJson()));
        }
        if ($is('POST', 'locations')) {
            return $this->postLocation($s, $this->readJson());
        }
        if ($is('GET', 'locations')) {
            return Response::json($this->locations($s));
        }

        if ($seg[0] === 'admin') {
            if ($s->role !== 'admin') {
                throw new ApiError(403, 'forbidden', '只有管理員可以使用');
            }
            if ($is('GET', 'admin/devices')) {
                return Response::json(['devices' => array_map(static fn (array $d): array => self::deviceJson($d), $this->repo->listDevices())]);
            }
            if ($is('PATCH', 'admin/devices/*')) {
                $body = $this->readJson();
                return Response::json($this->patchDevice($seg[2], $body));
            }
            if ($is('DELETE', 'admin/devices/*')) {
                return $this->deleteDevice($seg[2]);
            }
            if ($is('POST', 'admin/pairing-codes')) {
                return Response::json($this->createCode($s, $this->readJson()));
            }
            if ($is('GET', 'admin/pairing-codes')) {
                return Response::json($this->listCodes());
            }
            if ($is('DELETE', 'admin/pairing-codes/*')) {
                return $this->deleteCode($seg[2]);
            }
            if ($is('PATCH', 'admin/server')) {
                return Response::json($this->rename($this->readJson()));
            }
            if ($is('GET', 'admin/audit')) {
                return Response::json($this->audit());
            }
            if ($is('GET', 'admin/history')) {
                return Response::json($this->history($s));
            }
            $admin = new AdminApi($this->repo, $this->db, $s, $this->req);
            if ($is('GET', 'admin/schema')) {
                return Response::json($admin->schema());
            }
            if ($is('GET', 'admin/records')) {
                return Response::json($admin->list());
            }
            if ($is('GET', 'admin/records/*/*')) {
                return Response::json($admin->detail($seg[2], $seg[3]));
            }
            if ($is('PATCH', 'admin/records/*/*')) {
                return Response::json($admin->edit($seg[2], $seg[3], $this->readJson()));
            }
            if ($is('GET', 'admin/records/*/*/impact')) {
                return Response::json($admin->impact($seg[2], $seg[3]));
            }
            if ($is('POST', 'admin/records/*/*/delete')) {
                return Response::json($admin->remove($seg[2], $seg[3], $this->readJson()));
            }
            if ($is('POST', 'admin/requests/*/approve')) {
                return Response::json($admin->decide($seg[2], 'approve', $this->readJson()));
            }
            if ($is('POST', 'admin/requests/*/reject')) {
                return Response::json($admin->decide($seg[2], 'reject', $this->readJson()));
            }
            if ($is('GET', 'admin/reports/summary')) {
                return Response::json($admin->reportSummary());
            }
            if ($is('GET', 'admin/reports/export')) {
                return $admin->reportExport();
            }
        }
        throw new ApiError(404, 'not_found', '找不到這個端點');
    }

    /** 讀取 JSON 物件本體（最多 5 MB）。 */
    private function readJson(): \stdClass
    {
        if ($this->req->declaredLength() > self::MAX_BODY_BYTES) {
            throw new ApiError(413, 'payload_too_large', '請求本體超過 5 MB');
        }
        $text = $this->req->body(self::MAX_BODY_BYTES);
        if (strlen($text) > self::MAX_BODY_BYTES) {
            throw new ApiError(413, 'payload_too_large', '請求本體超過 5 MB');
        }
        if (str_starts_with($text, "\xEF\xBB\xBF")) {
            $text = substr($text, 3); // UTF-8 BOM（與 TextDecoder 相同，略過）
        }
        $v = json_decode($text, false, Json::DEPTH, JSON_INVALID_UTF8_SUBSTITUTE);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw ApiError::badRequest('請求本體不是合法的 JSON');
        }
        if (!$v instanceof \stdClass) {
            throw ApiError::badRequest('請求本體必須是 JSON 物件');
        }
        return $v;
    }

    /**
     * @param array<string, mixed> $row 有 driver_uuid、driver_name 欄位的資料列
     * @return array{driverUuid: string, driverName: string}|null
     */
    private static function bindingOf(array $row): ?array
    {
        $uuid = $row['driver_uuid'] ?? null;
        return is_string($uuid) && $uuid !== '' ? ['driverUuid' => $uuid, 'driverName' => (string) ($row['driver_name'] ?? '')] : null;
    }

    /**
     * @param array<string, mixed> $d
     * @return array<string, mixed>
     */
    private static function deviceJson(array $d): array
    {
        return [
            'deviceId' => $d['device_id'],
            'name' => $d['name'],
            'platform' => $d['platform'],
            'role' => $d['role'],
            'driverBinding' => self::bindingOf($d),
            'pairedAt' => $d['paired_at'],
            'lastSeenAt' => $d['last_seen_at'],
            'tokenExpiresAt' => $d['token_expires_at'] === null || $d['revoked_at'] !== null ? null : $d['token_expires_at'],
            'revokedAt' => $d['revoked_at'],
            // 1.2.0：網頁管理的登入（session 不記住、remember 記住；App 與 1.1 的網頁權杖是 null）與登入期限
            'webSession' => WebSession::kind($d['web_session']),
            'sessionUntil' => WebSession::kind($d['web_session']) === null ? null : $d['session_until'],
        ];
    }

    /** 網頁登入與轉換（沒有登入 Cookie 的請求）：自訂標頭、同一個來源、JSON 本體。 */
    private function requireWebRequest(): void
    {
        if (Util::jsTrim($this->req->header(WebSession::CSRF_HEADER) ?? '') === '' || WebSession::crossSite($this->req)) {
            throw new ApiError(403, 'csrf_failed', '請求來源驗證失敗，請重新整理網頁後再試');
        }
        if (!WebSession::isJsonContent($this->req)) {
            throw new ApiError(415, 'unsupported_media_type', '請求本體必須是 JSON（Content-Type: application/json）');
        }
    }

    /** @param array<string, mixed> $d */
    private static function hasLiveToken(array $d, int $now): bool
    {
        return $d['revoked_at'] === null && $d['token_hash'] !== null && (int) ($d['token_expires_at'] ?? 0) > $now;
    }

    // ───────── 公開端點 ─────────

    /** @return array<string, mixed> */
    private function info(): array
    {
        $meta = $this->repo->meta();
        return [
            'product' => 'FleetDispatch Server',
            'apiVersion' => 1,
            'serverVersion' => Version::SERVER_VERSION,
            'variant' => 'php',
            'serverId' => $meta['serverId'],
            'name' => $meta['name'],
            'time' => Util::nowMs(),
            'setupRequired' => $this->repo->countActiveAdmins(Util::nowMs()) === 0,
            'setupConfigured' => $this->config->setupToken !== null,
            // 1.2.0：冪等、revision（expectedRevision 與 conflict）、修改前後歷史、網頁管理以 Cookie 登入；舊版 App 不使用，照舊運作。
            'features' => ['liveLocations', 'audit', 'idempotency', 'revision', 'history', 'webSession'],
            'schemaVersion' => $this->db->schemaVersion(),
            'limits' => ['maxEventsPerRequest' => self::MAX_EVENTS_PER_REQUEST, 'maxBodyBytes' => self::MAX_BODY_BYTES],
        ];
    }

    /** @return array{id: string, name: string, time: int} */
    private function serverJson(): array
    {
        $meta = $this->repo->meta();
        return ['id' => $meta['serverId'], 'name' => $meta['name'], 'time' => Util::nowMs()];
    }

    /** @return array<string, mixed> */
    private function pair(\stdClass $body): array
    {
        $code = Util::str($body->code ?? null);
        $deviceId = Util::normalizeUuid($body->deviceId ?? null);
        $deviceName = Util::cleanName($body->deviceName ?? null, 100);
        $platform = is_string($body->platform ?? null) ? Util::utf16Slice(Util::jsTrim($body->platform), 20) : '';
        if ($code === null || $code === '' || $deviceId === null || $deviceName === null) {
            throw ApiError::badRequest('需要 code、deviceId（UUID）與 deviceName');
        }

        $now = Util::nowMs();
        $grant = $this->checkCode($code, $now);
        $existing = $this->repo->deviceById($deviceId);
        if ($existing !== null && self::hasLiveToken($existing, $now)) {
            throw new ApiError(409, 'device_conflict', '這台裝置已經配對；請由管理員先解除配對');
        }

        $token = Crypto::newToken();
        $expiresAt = $now + self::TOKEN_TTL_MS;
        $device = [
            'id' => $deviceId, 'name' => $deviceName, 'platform' => $platform, 'role' => $grant['role'], 'binding' => $grant['binding'],
            'tokenHash' => Crypto::sha256Hex($token), 'expiresAt' => $expiresAt,
        ];
        $outcome = $this->savePairing($grant['codeHash'], $device, $now);
        if ($outcome === 'conflict') {
            throw new ApiError(409, 'device_conflict', '這台裝置已經配對；請由管理員先解除配對');
        }
        if ($outcome !== 'ok') {
            $this->failCode($now);
        }
        return [
            'token' => $token,
            'deviceId' => $deviceId,
            'role' => $grant['role'],
            'driverBinding' => $grant['binding'],
            'server' => $this->serverJson(),
            'tokenExpiresAt' => $expiresAt,
        ];
    }

    /**
     * 檢查配對碼或設定碼（配對與網頁登入共用）：嘗試次數限制、沒有可以使用的管理員時比對設定碼、否則找可以使用的配對碼。
     * 錯誤時記一次失敗並回 401（還沒有用掉配對碼）。
     *
     * @return array{role: string, binding: array{driverUuid: string, driverName: string}|null, codeHash: string|null}
     */
    private function checkCode(string $code, int $now): array
    {
        $f = $this->repo->failures($this->ip, $now - self::ATTEMPT_WINDOW_MS);
        if ($f['count'] >= self::MAX_FAILURES) {
            $retry = max(1, (int) ceil((($f['oldest'] ?? $now) + self::ATTEMPT_WINDOW_MS - $now) / 1000));
            throw new ApiError(429, 'rate_limited', '嘗試太多次，請稍後再試', $retry);
        }
        if ($this->repo->countActiveAdmins($now) === 0) {
            if ($this->config->setupToken === null) {
                throw new ApiError(409, 'setup_not_configured', '主機尚未設定設定碼（請依部署文件在 config.php 設定 setup_token）');
            }
            if (!Crypto::constantTimeEqual(Util::jsTrim($code), $this->config->setupToken)) {
                $this->failCode($now);
            }
            return ['role' => 'admin', 'binding' => null, 'codeHash' => null];
        }
        $codeHash = Crypto::sha256Hex(Crypto::normalizePairingCode($code));
        $row = $this->repo->findUsableCode($codeHash, $now);
        if ($row === null) {
            $this->failCode($now);
        }
        $role = $row['role'];
        return ['role' => $role, 'binding' => $role === 'driver' ? self::bindingOf($row) : null, 'codeHash' => $codeHash];
    }

    private function failCode(int $now): never
    {
        $this->repo->recordFailure($this->ip, $now);
        throw new ApiError(401, 'invalid_code', '配對碼錯誤、已使用或已過期');
    }

    /**
     * 在同一個交易中再確認一次並建立裝置（並行的配對不會同時用掉同一個配對碼，也不會同時用設定碼建立兩位管理員）：
     * 'ok'、'conflict'（這台裝置已經配對）、'fail'（配對碼已被用掉，或已經有可以使用的管理員）。
     *
     * @param array<string, mixed> $device
     */
    private function savePairing(?string $codeHash, array $device, int $now): string
    {
        return $this->db->transaction(function () use ($codeHash, $device, $now): string {
            if ($codeHash === null && $this->repo->countActiveAdmins($now) > 0) {
                return 'fail';
            }
            $current = $this->repo->deviceById($device['id']);
            if ($current !== null && self::hasLiveToken($current, $now)) {
                return 'conflict';
            }
            if ($codeHash !== null && !$this->repo->consumeCode($codeHash, $device['id'], $now)) {
                return 'fail';
            }
            $this->repo->saveDevice($current !== null, $device, $now);
            return 'ok';
        });
    }

    // ───────── 網頁管理的登入（1.2.0） ─────────

    /**
     * 網頁管理登入：以管理員的配對碼（或沒有可以使用的管理員時的設定碼）建立一個網頁裝置，權杖只放在 HttpOnly Cookie。
     * 不是管理員的配對碼回 403 admin_only，配對碼不會被用掉。
     */
    private function webLogin(\stdClass $body): Response
    {
        $code = Util::str($body->code ?? null);
        $deviceName = Util::cleanName($body->deviceName ?? null, 100);
        if ($code === null || $code === '' || $deviceName === null) {
            throw ApiError::badRequest('需要 code 與 deviceName');
        }
        if (property_exists($body, 'remember') && !is_bool($body->remember)) {
            throw ApiError::badRequest('remember 必須是 true 或 false');
        }
        $kind = ($body->remember ?? false) === true ? 'remember' : 'session';

        $now = Util::nowMs();
        $grant = $this->checkCode($code, $now);
        if ($grant['role'] !== 'admin') {
            throw new ApiError(403, 'admin_only', '網頁管理只能用「管理員」的配對碼登入');
        }
        $deviceId = Crypto::uuid4();
        $token = Crypto::newToken();
        $until = $now + WebSession::LIFETIME[$kind]['maxMs'];
        $device = [
            'id' => $deviceId, 'name' => $deviceName, 'platform' => 'web', 'role' => 'admin', 'binding' => null,
            'tokenHash' => Crypto::sha256Hex($token), 'expiresAt' => WebSession::expiry($kind, $now, $until),
            'web' => ['kind' => $kind, 'until' => $until],
        ];
        if ($this->savePairing($grant['codeHash'], $device, $now) !== 'ok') {
            $this->failCode($now);
        }
        return $this->webSessionResponse($token, $deviceId, $kind, $until, $now);
    }

    /**
     * 1.1 的網頁登入（瀏覽器保存的權杖，以 Authorization 標頭送來）換成 Cookie：同一台網頁裝置換新權杖，舊權杖立即失效。
     * 只接受網頁（platform 是 web）且還沒有轉換的權杖；App 的權杖回 403 not_web_session。
     */
    private function webUpgrade(\stdClass $body): Response
    {
        if (property_exists($body, 'remember') && !is_bool($body->remember)) {
            throw ApiError::badRequest('remember 必須是 true 或 false');
        }
        $kind = ($body->remember ?? false) === true ? 'remember' : 'session';
        $header = Util::jsTrim($this->req->authorization());
        if (preg_match('/^Bearer[' . Util::JS_SPACE . ']+([A-Za-z0-9_-]{20,200})\z/u', $header, $match) !== 1) {
            throw new ApiError(401, 'unauthorized', '需要權杖');
        }
        $oldHash = Crypto::sha256Hex($match[1]);
        $device = $this->repo->deviceByTokenHash($oldHash);
        $now = Util::nowMs();
        if ($device === null || $device['token_expires_at'] === null || $device['token_expires_at'] <= $now
            || $device['identity'] === null || $device['identity'] === '' || WebSession::kind($device['web_session']) !== null) {
            throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新登入');
        }
        if ($device['platform'] !== 'web') {
            throw new ApiError(403, 'not_web_session', '只有網頁管理的登入可以轉換');
        }
        $token = Crypto::newToken();
        $until = $now + WebSession::LIFETIME[$kind]['maxMs'];
        $ok = $this->repo->upgradeWebSession($device['device_id'], $oldHash, [
            'tokenHash' => Crypto::sha256Hex($token), 'kind' => $kind, 'until' => $until, 'expiresAt' => WebSession::expiry($kind, $now, $until),
        ], $now);
        if (!$ok) {
            throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新登入');
        }
        return $this->webSessionResponse($token, $device['device_id'], $kind, $until, $now);
    }

    /** 網頁登入成功：回應不含權杖（只在 Set-Cookie），附上這次登入的資訊與 CSRF 權杖。 */
    private function webSessionResponse(string $token, string $deviceId, string $kind, int $until, int $now): Response
    {
        $d = $this->repo->deviceById($deviceId);
        if ($d === null) {
            throw new \RuntimeException('登入後找不到裝置');
        }
        $role = Rules::isRole($d['role']) ? $d['role'] : 'viewer';
        $session = new Session(
            $deviceId, (string) $d['identity'], $d['name'], $role, $role === 'driver' ? self::bindingOf($d) : null, (int) $d['token_expires_at'],
            ['kind' => $kind, 'until' => $until, 'csrf' => WebSession::csrfToken($token)],
        );
        return new Response(200, $this->sessionJson($session), ['Set-Cookie' => WebSession::cookie($this->req, $token, $kind, $until, $now)]);
    }

    // ───────── 驗證 ─────────

    /** 有 Authorization 標頭時以權杖驗證（App）；否則以網頁管理的登入 Cookie 驗證。 */
    private function authenticate(): Session
    {
        $header = Util::jsTrim($this->req->authorization());
        if ($header === '') {
            $cookie = WebSession::readCookie($this->req);
            if ($cookie !== null) {
                return $this->cookieSession($cookie);
            }
        }
        if (preg_match('/^Bearer[' . Util::JS_SPACE . ']+([A-Za-z0-9_-]{20,200})\z/u', $header, $match) !== 1) {
            throw new ApiError(401, 'unauthorized', '需要權杖');
        }
        $device = $this->repo->deviceByTokenHash(Crypto::sha256Hex($match[1]));
        $now = Util::nowMs();
        // 網頁管理的 Cookie 權杖不能放在 Authorization 標頭使用（期限與 CSRF 檢查只在 Cookie 的路徑）
        if ($device === null || $device['token_expires_at'] === null || $device['token_expires_at'] <= $now
            || WebSession::kind($device['web_session']) !== null) {
            throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新配對');
        }
        $expiresAt = $device['token_expires_at'];
        // 為了減少寫入，同一台裝置最多每小時延長一次。1.1 的網頁權杖（存在瀏覽器）只更新最後使用時間、不再延長。
        if ($device['last_seen_at'] === null || $now - $device['last_seen_at'] >= self::TOUCH_INTERVAL_MS) {
            if ($device['platform'] !== 'web') {
                $expiresAt = $now + self::TOKEN_TTL_MS;
            }
            $this->repo->touchDevice($device['device_id'], $now, $expiresAt);
        }
        $role = Rules::isRole($device['role']) ? $device['role'] : 'viewer';
        // 每次配對都會產生主機端身分；沒有身分的裝置一律重新配對。
        $identity = $device['identity'];
        if ($identity === null || $identity === '') {
            throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新配對');
        }
        return new Session($device['device_id'], $identity, $device['name'], $role, $role === 'driver' ? self::bindingOf($device) : null, $expiresAt);
    }

    /**
     * 網頁管理的登入 Cookie：閒置期限與登入期限；非 GET 的請求檢查 CSRF 權杖、Sec-Fetch-Site 與 JSON 本體
     * （檢查不通過時不延長期限）。
     */
    private function cookieSession(string $token): Session
    {
        $device = $this->repo->deviceByTokenHash(Crypto::sha256Hex($token));
        $now = Util::nowMs();
        $kind = $device === null ? null : WebSession::kind($device['web_session']);
        if ($device === null || $kind === null || $device['token_expires_at'] === null || $device['token_expires_at'] <= $now
            || $device['identity'] === null || $device['identity'] === '') {
            throw new ApiError(401, 'unauthorized', '登入已失效，請重新登入');
        }
        $csrf = WebSession::csrfToken($token);
        if ($this->req->method !== 'GET' && $this->req->method !== 'HEAD') {
            $sent = Util::jsTrim($this->req->header(WebSession::CSRF_HEADER) ?? '');
            if (!Crypto::constantTimeEqual($sent, $csrf) || WebSession::crossSite($this->req)) {
                throw new ApiError(403, 'csrf_failed', '請求來源驗證失敗，請重新整理網頁後再試');
            }
            if ((($this->req->contentType() ?? '') !== '' || $this->req->declaredLength() > 0) && !WebSession::isJsonContent($this->req)) {
                throw new ApiError(415, 'unsupported_media_type', '請求本體必須是 JSON（Content-Type: application/json）');
            }
        }
        $until = (int) ($device['session_until'] ?? 0);
        $expiresAt = $device['token_expires_at'];
        if ($device['last_seen_at'] === null || $now - $device['last_seen_at'] >= WebSession::TOUCH_INTERVAL_MS) {
            $expiresAt = WebSession::expiry($kind, $now, $until);
            $this->repo->touchDevice($device['device_id'], $now, $expiresAt);
        }
        $role = Rules::isRole($device['role']) ? $device['role'] : 'viewer';
        return new Session(
            $device['device_id'], $device['identity'], $device['name'], $role, $role === 'driver' ? self::bindingOf($device) : null, $expiresAt,
            ['kind' => $kind, 'until' => $until, 'csrf' => $csrf],
        );
    }

    /** @return array<string, mixed> */
    private function sessionJson(Session $s): array
    {
        $out = [
            'deviceId' => $s->deviceId,
            'deviceName' => $s->deviceName,
            'role' => $s->role,
            'driverBinding' => $s->binding,
            'server' => $this->serverJson(),
            'tokenExpiresAt' => $s->tokenExpiresAt,
        ];
        // 網頁管理的登入（1.2.0）：種類、登入期限與 CSRF 權杖；App 的回應沒有這個欄位
        if ($s->web !== null) {
            $out['web'] = ['remember' => $s->web['kind'] === 'remember', 'sessionUntil' => $s->web['until'], 'csrfToken' => $s->web['csrf']];
        }
        return $out;
    }

    private function unpairSelf(Session $s): Response
    {
        $this->db->transaction(function () use ($s): void {
            $now = Util::nowMs();
            if ($s->role === 'admin' && $this->repo->countOtherAdmins($s->deviceId, $now) === 0) {
                throw new ApiError(409, 'last_admin', '最後一位可以使用的管理員不能解除配對');
            }
            $this->repo->revokeDevice($s->deviceId, $now);
        });
        // 網頁管理登出：同時刪除登入 Cookie
        return $s->web !== null ? new Response(204, null, ['Set-Cookie' => WebSession::clearCookie($this->req)]) : Response::noContent();
    }

    // ───────── 讀取 ─────────

    /**
     * 給這台裝置的資料內容：必要時遮蔽駕駛人；其他情況直接嵌入主機保存的原始 JSON。內容無法解析時回傳 null（不送出）。
     *
     * @param array<string, mixed> $r
     */
    private function outgoing(Session $s, array $r): ?RawJson
    {
        $text = $r['payloadText'];
        if ($text === null) {
            return null;
        }
        if (Rules::needsRedaction($s, $r['entity'], $r['id'])) {
            $payload = Json::decodeObject($text);
            return $payload === null ? null : new RawJson(Json::encode(Rules::redactDriver($payload)));
        }
        if (preg_match(self::OUT_OF_RANGE_NUMBER, $text) === 1) {
            // 可能有超出浮點數範圍的數字（例如 1e400）：與 TypeScript 版（JSON.parse 後再 JSON.stringify）一樣輸出 null。
            $payload = Json::decodeObject($text);
            if ($payload === null) {
                return null;
            }
            return new RawJson(Json::hasNonFinite($payload) ? Json::encode($payload) : $text);
        }
        return Json::isObjectText($text) ? new RawJson($text) : null;
    }

    /** @return array<string, mixed> */
    private function snapshot(Session $s): array
    {
        // 游標必須在讀取資料之前取得：之後的變更一定會出現在 GET /changes?since=cursor。
        $cursor = $this->repo->currentSeq();
        $out = [];
        foreach (Rules::ENTITIES as $e) {
            $out[Rules::SNAPSHOT_KEYS[$e]] = [];
        }
        $revisions = [];
        foreach ($this->repo->liveRecords() as $r) {
            if (!Rules::isEntity($r['entity']) || !Rules::visible($s, $r)) {
                continue;
            }
            $payload = $this->outgoing($s, $r);
            if ($payload !== null) {
                $out[Rules::SNAPSHOT_KEYS[$r['entity']]][] = $payload;
                $revisions[$r['entity'] . ':' . $r['id']] = $r['revision'];
            }
        }
        $out['authoritative'] = true;
        // revisions（1.2.0）：每筆資料目前的版本
        return ['cursor' => $cursor, 'snapshot' => $out, 'revisions' => (object) $revisions, 'session' => $this->sessionJson($s)];
    }

    /** @return array<string, mixed> */
    private function changes(Session $s): array
    {
        $since = Util::intParam($this->req, 'since', 0, 0, Util::MAX_SAFE_INTEGER);
        $limit = Util::intParam($this->req, 'limit', 500, 1, 1000);
        $rows = $this->repo->changesSince($since, $limit);
        $changes = [];
        foreach ($rows as $r) {
            if (!Rules::visible($s, $r)) {
                continue;
            }
            $changes[] = [
                'seq' => $r['seq'],
                'entity' => $r['entity'],
                'id' => $r['id'],
                'deleted' => $r['deleted'],
                'modifiedAt' => $r['modifiedAt'],
                'revision' => $r['revision'],
                'payload' => $r['deleted'] ? null : $this->outgoing($s, $r),
            ];
        }
        $cursor = $rows !== [] ? $rows[count($rows) - 1]['seq'] : min($since, $this->repo->currentSeq());
        return ['changes' => $changes, 'cursor' => $cursor, 'hasMore' => count($rows) === $limit, 'session' => $this->sessionJson($s)];
    }

    // ───────── 寫入 ─────────

    /** @return array<string, mixed> */
    private function events(Session $s, \stdClass $body): array
    {
        $list = $body->events ?? null;
        if (!is_array($list)) {
            throw ApiError::badRequest('需要 events 陣列');
        }
        if (count($list) > self::MAX_EVENTS_PER_REQUEST) {
            throw ApiError::badRequest('每次最多 ' . self::MAX_EVENTS_PER_REQUEST . ' 筆事件');
        }
        if (random_int(1, 50) === 1) {
            $this->repo->purgeProcessed(Util::nowMs() - self::PROCESSED_TTL_MS);
        }
        $results = [];
        foreach ($list as $raw) {
            $results[] = $this->applyEvent($s, $raw);
        }
        return ['results' => $results, 'cursor' => $this->repo->currentSeq()];
    }

    /**
     * 套用一筆事件。冪等（1.2.0）：同一台裝置重送同一個事件 ID 時回傳第一次的結果，不重複寫入、不重複稽核。
     *
     * @return array<string, mixed>
     */
    private function applyEvent(Session $s, mixed $raw): array
    {
        $v = Rules::validateEvent($raw);
        if (!$v['ok']) {
            return ['id' => $v['id'], 'status' => 'rejected', 'reason' => $v['reason']];
        }
        $eventId = trim($v['id']) !== '' && strlen($v['id']) <= 100 ? $v['id'] : null;
        if ($eventId !== null) {
            $prior = $this->repo->processedResult($s->deviceId, $eventId);
            if ($prior !== null) {
                $decoded = json_decode($prior, true);
                if (is_array($decoded)) {
                    $decoded['duplicate'] = true;
                    return $decoded;
                }
            }
        }
        ['result' => $result, 'existing' => $existing] = $this->applyValidated($s, $raw, $v, $eventId);
        if ($result['status'] !== 'applied') {
            $this->recordOutcome($s, $v, $eventId, $result, $existing);
        }
        return $result;
    }

    /**
     * 沒有套用的事件（拒絕、衝突、略過）：在修改前後歷史留下摘要（主機上的內容、送來的內容、原因），與冪等紀錄在同一個交易。
     *
     * @param array<string, mixed> $v
     * @param array<string, mixed> $result
     * @param array<string, mixed>|null $existing
     */
    private function recordOutcome(Session $s, array $v, ?string $eventId, array $result, ?array $existing): void
    {
        $live = $existing !== null && !$existing['deleted'] && $existing['payload'] !== null ? $existing : null;
        $attempted = $v['op'] === 'delete' || ($result['reason'] ?? null) === 'payload-too-large' || $v['payload'] === null ? null : $v['payloadText'];
        $reason = $result['reason'] ?? ($v['op'] === 'delete' ? 'not-found' : 'stale');
        $now = Util::nowMs();
        $this->db->transaction(function () use ($s, $v, $eventId, $result, $existing, $live, $attempted, $reason, $now): void {
            $this->repo->addHistory($now, $v['entity'], $v['entityId'], $eventId, $v['op'], 'app', $s->deviceId, $s->identity, $s->deviceName,
                $live['payloadText'] ?? null, $attempted, $attempted === null ? null : Admin::changedFields($live['payload'] ?? null, $v['payload']),
                $reason, $this->repo->currentSeq(), (int) ($existing['revision'] ?? 0), (string) $result['status']);
            if ($eventId !== null) {
                $this->repo->recordProcessed($s->deviceId, $eventId, (string) $result['status'], $result['reason'] ?? null, Json::encode($result), $now);
            }
        });
    }

    /**
     * 處理一筆已驗證格式的事件（自成一個交易，取得全主機寫入鎖後讀取，授權與寫入看到同一個版本）：
     * 授權 → expectedRevision → 時間校正 → 最後寫入者勝 → 寫入、修改前後歷史、已處理事件 → 連鎖刪除 → 稽核紀錄。
     * 回傳結果與做決定時主機上的版本（沒有套用時留下摘要用）。
     *
     * @param array<string, mixed> $v
     * @return array{result: array<string, mixed>, existing: array<string, mixed>|null}
     */
    private function applyValidated(Session $s, mixed $raw, array $v, ?string $eventId): array
    {
        $id = $v['id'];
        $entity = $v['entity'];
        $entityId = $v['entityId'];
        $op = $v['op'];
        $text = $v['payloadText'];
        // 檢查順序與 TypeScript 版相同：先內容大小，再 expectedRevision
        if (strlen($text) > self::MAX_PAYLOAD_LENGTH && Util::utf16Length($text) > self::MAX_PAYLOAD_LENGTH) {
            return ['result' => ['id' => $id, 'status' => 'rejected', 'reason' => 'payload-too-large'], 'existing' => null];
        }
        $expectedRevision = self::optionalRevision($raw);
        if ($expectedRevision === false) {
            return ['result' => ['id' => $id, 'status' => 'rejected', 'reason' => 'invalid-expected-revision'], 'existing' => null];
        }
        $now = Util::nowMs();
        $nowApple = Util::msToApple($now);

        if ($op === 'delete') {
            $at = min($v['timestamp'], $nowApple);
            return $this->db->transaction(function () use ($s, $id, $entity, $entityId, $at, $now, $expectedRevision, $eventId): array {
                $existing = $this->repo->getRecord($entity, $entityId);
                $done = static fn (array $result): array => ['result' => $result, 'existing' => $existing];
                $reason = Rules::authorize($s, $entity, 'delete', null, $existing);
                if ($reason !== null) {
                    return $done(['id' => $id, 'status' => 'rejected', 'reason' => $reason]);
                }
                $conflict = self::conflict($id, $existing, $expectedRevision);
                if ($conflict !== null) {
                    return $done($conflict);
                }
                if ($existing === null || $existing['deleted']) {
                    return $done(['id' => $id, 'status' => 'ignored']);
                }
                $plate = $existing['vehiclePlate'];
                // 伺服器端的業務規則（1.2.0）：還有進行中車趟的車輛不能刪除（App 也有相同規則）。
                if ($entity === 'vehicle' && $plate !== null && $plate !== '' && $this->repo->activeTripsOfPlate($plate) > 0) {
                    return $done(['id' => $id, 'status' => 'rejected', 'reason' => 'vehicle-has-active-trips']);
                }
                $seq = $this->db->nextSeq();
                $this->repo->tombstone($entity, $entityId, $seq, $at, $s->deviceId, $now);
                $revision = $existing['revision'] + 1;
                $this->repo->addHistory($now, $entity, $entityId, $eventId, 'delete', 'app', $s->deviceId, $s->identity, $s->deviceName,
                    $existing['payloadText'], null, null, null, $seq, $revision);
                $result = ['id' => $id, 'status' => 'applied', 'revision' => $revision];
                if ($eventId !== null) {
                    $this->repo->recordProcessed($s->deviceId, $eventId, 'applied', null, Json::encode($result), $now);
                }
                $this->logAudit($s, $entity, $entityId, 'delete', '', $now);
                if ($entity === 'trip') {
                    $this->repo->deleteLocation($entityId);
                }
                if ($entity === 'vehicle' && $plate !== null && $plate !== '') {
                    $this->cascadeVehicle($s, $plate, $at, $now);
                }
                return $done($result);
            });
        }

        // 建立／修改。時間校正只改 lastModifiedAt（授權不看這個欄位），所以先算好，交易重試時也不會重複修改。
        /** @var \stdClass $payload */
        $payload = $v['payload'];
        $timestamp = $v['timestamp'];
        $restamped = false;
        $modified = $payload->lastModifiedAt;
        if ($timestamp > $nowApple || $modified > $nowApple) {
            $timestamp = min($timestamp, $nowApple);
            $payload->lastModifiedAt = min($modified, $nowApple);
            $text = Json::encode($payload);
            $restamped = true;
        }
        $modifiedAt = $payload->lastModifiedAt;
        $fields = Rules::scopeFields($entity, $payload);
        $completed = ($payload->isCompleted ?? null) === true;

        return $this->db->transaction(function () use ($s, $raw, $id, $entity, $entityId, $op, $payload, $timestamp, $text, $restamped, $modifiedAt, $fields, $completed, $now, $expectedRevision, $eventId): array {
            $existing = $this->repo->getRecord($entity, $entityId);
            $done = static fn (array $result): array => ['result' => $result, 'existing' => $existing];
            $reason = Rules::authorize($s, $entity, $op, $payload, $existing);
            if ($reason !== null) {
                return $done(['id' => $id, 'status' => 'rejected', 'reason' => $reason]);
            }
            $conflict = self::conflict($id, $existing, $expectedRevision);
            if ($conflict !== null) {
                return $done($conflict);
            }
            // 最後寫入者勝：沒有這筆、或事件時間嚴格大於現存的修改時間才寫入。墓碑的修改時間是刪除的時間，
            // 比刪除舊的修改不會讓資料復活。
            if ($existing !== null && !($timestamp > $existing['modifiedAt'])) {
                return $done(['id' => $id, 'status' => 'ignored']);
            }
            $live = $existing !== null && !$existing['deleted'] ? $existing : null;
            $seq = $this->db->nextSeq();
            $this->repo->writeRecord($existing, $entity, $entityId, $seq, $modifiedAt, $text, $fields, $s->identity, $s->deviceId, $now);
            $revision = ($existing['revision'] ?? 0) + 1;
            $operation = $live !== null ? 'update' : 'create';
            $this->repo->addHistory($now, $entity, $entityId, $eventId, $operation, 'app', $s->deviceId, $s->identity, $s->deviceName,
                $live['payloadText'] ?? null, $text, Admin::changedFields($live['payload'] ?? null, $payload), null, $seq, $revision);
            $this->logAudit($s, $entity, $entityId, $operation, $text, $now);
            if ($entity === 'trip' && $completed) {
                $this->repo->deleteLocation($entityId);
            }
            $result = ['id' => $id, 'status' => 'applied', 'revision' => $revision];
            if ($restamped) {
                // 校正後的事件：其他欄位照送出者的原樣。
                $event = clone $raw;
                $event->timestamp = $timestamp;
                $event->payloadJSON = $text;
                $result['event'] = $event;
            }
            if ($eventId !== null) {
                $this->repo->recordProcessed($s->deviceId, $eventId, 'applied', null, Json::encode($result), $now);
            }
            return $done($result);
        });
    }

    /** 刪除車輛時，同車牌的車趟、保養、保養項目、工單、巡檢一併改為墓碑（在同一個交易中）。 */
    private function cascadeVehicle(Session $s, string $plate, int|float $at, int $now): void
    {
        foreach ($this->repo->liveChildrenOfPlate($plate, Rules::VEHICLE_CHILDREN) as $child) {
            $before = $this->repo->getRecord($child['entity'], $child['id']);
            $seq = $this->db->nextSeq();
            if ($this->repo->tombstone($child['entity'], $child['id'], $seq, $at, $s->deviceId, $now)) {
                $this->repo->addHistory($now, $child['entity'], $child['id'], null, 'delete', 'cascade', $s->deviceId, $s->identity, $s->deviceName,
                    $before['payloadText'] ?? null, null, null, 'vehicle-deleted', $seq, ($before['revision'] ?? 0) + 1);
                $this->logAudit($s, $child['entity'], $child['id'], 'delete', '', $now);
                if ($child['entity'] === 'trip') {
                    $this->repo->deleteLocation($child['id']);
                }
            }
        }
    }

    private function logAudit(Session $s, string $entity, string $id, string $operation, string $payloadText, int $now): void
    {
        // 駕駛人只留 UUID 與姓名（不把個資寫進稽核紀錄）
        $this->repo->addAudit($now, $s->deviceId, $s->deviceName, $entity, $id, $operation, Admin::auditSummary($entity, $payloadText));
    }

    // ───────── 即時位置 ─────────

    private function postLocation(Session $s, \stdClass $body): Response
    {
        if ($s->role === 'viewer') {
            throw new ApiError(403, 'forbidden', '檢視者不能回報位置');
        }
        $tripId = Util::normalizeUuid($body->tripUUID ?? null);
        $lat = Util::num($body->latitude ?? null);
        $lon = Util::num($body->longitude ?? null);
        $ts = Util::num($body->timestamp ?? null);
        if ($tripId === null || $lat === null || $lon === null || $ts === null || abs($lat) > 90 || abs($lon) > 180) {
            throw ApiError::badRequest('需要 tripUUID、latitude、longitude、timestamp');
        }
        $speed = Util::num($body->speed ?? null);
        $course = Util::num($body->course ?? null);
        // 與車趟的完成／刪除在同一把鎖下，已完成的車趟不會留下位置。
        $this->db->transaction(function () use ($s, $tripId, $lat, $lon, $ts, $speed, $course): void {
            $trip = $this->repo->getRecord('trip', $tripId);
            if ($trip === null || $trip['deleted'] || $trip['payload'] === null || ($trip['payload']->isCompleted ?? null) === true || !Rules::visible($s, $trip)) {
                throw new ApiError(403, 'forbidden', '車趟不存在、已完成或不在你的範圍');
            }
            $this->repo->upsertLocation([
                'trip_id' => $tripId,
                'device_id' => $s->deviceId,
                'device_name' => $s->deviceName,
                'plate' => $trip['vehiclePlate'],
                'latitude' => $lat,
                'longitude' => $lon,
                'speed' => $speed !== null && $speed >= 0 ? $speed : null,
                'course' => $course !== null && $course >= 0 ? $course : null,
                'ts' => $ts,
                'updated_at' => Util::nowMs(),
            ]);
        });
        return Response::noContent();
    }

    /** @return array<string, mixed> */
    private function locations(Session $s): array
    {
        $now = Util::nowMs();
        $freshAfter = $now - self::LOCATION_TTL_MS;
        try {
            $this->repo->purgeLocations($freshAfter);
        } catch (\PDOException $e) {
            // 清除只是整理；失敗（例如資料庫忙碌）時下面的查詢仍只取有效期限內的位置。
            App::logThrowable($e);
        }
        $out = [];
        foreach ($this->repo->listLocations($freshAfter) as $r) {
            if ($s->role === 'driver') {
                $trip = $this->repo->getRecordScope('trip', (string) $r['trip_id']);
                if ($trip === null || !Rules::visible($s, $trip)) {
                    continue;
                }
            }
            $out[] = [
                'tripUUID' => (string) $r['trip_id'],
                'deviceId' => (string) $r['device_id'],
                'deviceName' => (string) $r['device_name'],
                'plateNumber' => $r['plate'] === null ? null : (string) $r['plate'],
                'latitude' => (float) $r['latitude'],
                'longitude' => (float) $r['longitude'],
                'speed' => $r['speed'] === null ? null : (float) $r['speed'],
                'course' => $r['course'] === null ? null : (float) $r['course'],
                'timestamp' => (float) $r['ts'],
                'stale' => $now - (int) $r['updated_at'] > self::LOCATION_STALE_MS,
            ];
        }
        return ['locations' => $out];
    }

    // ───────── 管理 ─────────

    /** @return array<string, mixed> */
    private function patchDevice(string $rawId, \stdClass $body): array
    {
        $id = Util::normalizeUuid($rawId);
        if ($id === null) {
            throw ApiError::badRequest('裝置 ID 必須是 UUID');
        }
        return $this->db->transaction(function () use ($id, $body): array {
            $d = $this->repo->deviceById($id);
            if ($d === null) {
                throw new ApiError(404, 'not_found', '找不到這台裝置');
            }
            $role = $d['role'];
            if (property_exists($body, 'role')) {
                if (!Rules::isRole($body->role)) {
                    throw ApiError::badRequest('role 必須是 admin、driver 或 viewer');
                }
                $role = $body->role;
            }
            $binding = self::bindingOf($d);
            if (property_exists($body, 'driverBinding')) {
                $b = Rules::parseBinding($body->driverBinding);
                if ($b === false) {
                    throw ApiError::badRequest('driverBinding 必須是 {driverUuid, driverName} 或 null');
                }
                $binding = $b;
            }
            if ($role !== 'driver') {
                $binding = null;
            }
            if ($d['role'] === 'admin' && $role !== 'admin' && $d['revoked_at'] === null && $this->repo->countOtherAdmins($id, Util::nowMs()) === 0) {
                throw new ApiError(409, 'last_admin', '最後一位可以使用的管理員不能降級');
            }
            $this->repo->updateDevice($id, $role, $binding);
            $updated = $this->repo->deviceById($id);
            if ($updated === null) {
                throw new \RuntimeException('更新後找不到裝置');
            }
            return self::deviceJson($updated);
        });
    }

    private function deleteDevice(string $rawId): Response
    {
        $id = Util::normalizeUuid($rawId);
        if ($id === null) {
            throw ApiError::badRequest('裝置 ID 必須是 UUID');
        }
        $this->db->transaction(function () use ($id): void {
            $d = $this->repo->deviceById($id);
            if ($d === null) {
                throw new ApiError(404, 'not_found', '找不到這台裝置');
            }
            if ($d['role'] === 'admin' && $d['revoked_at'] === null && $this->repo->countOtherAdmins($id, Util::nowMs()) === 0) {
                throw new ApiError(409, 'last_admin', '最後一位可以使用的管理員不能解除配對');
            }
            $this->repo->revokeDevice($id, Util::nowMs());
        });
        return Response::noContent();
    }

    /** @return array<string, mixed> */
    private function createCode(Session $s, \stdClass $body): array
    {
        $role = $body->role ?? null;
        if (!Rules::isRole($role)) {
            throw ApiError::badRequest('role 必須是 admin、driver 或 viewer');
        }
        $binding = null;
        if (isset($body->driverBinding)) {
            $b = Rules::parseBinding($body->driverBinding);
            if (!is_array($b)) {
                throw ApiError::badRequest('driverBinding 必須是 {driverUuid, driverName}');
            }
            $binding = $role === 'driver' ? $b : null;
        }
        $ttl = 1440;
        if (property_exists($body, 'ttlMinutes')) {
            $t = Util::num($body->ttlMinutes);
            $ttl = $t !== null && floor($t) == $t ? $t : null;
        }
        if ($ttl === null || $ttl < 5 || $ttl > 10080) {
            throw ApiError::badRequest('ttlMinutes 必須是 5–10080 的整數');
        }
        $ttl = (int) $ttl;
        $label = is_string($body->label ?? null) ? Util::utf16Slice(Util::jsTrim($body->label), 100) : '';
        $now = Util::nowMs();
        $expiresAt = $now + $ttl * 60 * 1000;
        for ($attempt = 1; ; $attempt++) {
            $code = Crypto::newPairingCode();
            $id = Crypto::uuid4();
            try {
                $this->repo->createCode([
                    'id' => $id,
                    'code_hash' => Crypto::sha256Hex(Crypto::normalizePairingCode($code)),
                    'role' => $role,
                    'driver_uuid' => $binding['driverUuid'] ?? null,
                    'driver_name' => $binding['driverName'] ?? null,
                    'label' => $label,
                    'created_by' => $s->deviceId,
                    'created_at' => $now,
                    'expires_at' => $expiresAt,
                ]);
                break;
            } catch (\PDOException $e) {
                // 極少數情況下與舊的配對碼雜湊相同：換一組再試。
                if ($attempt >= 3 || !Db::isUniqueViolation($e)) {
                    throw $e;
                }
            }
        }
        return ['id' => $id, 'code' => $code, 'role' => $role, 'driverBinding' => $binding, 'label' => $label, 'expiresAt' => $expiresAt];
    }

    /** @return array<string, mixed> */
    private function listCodes(): array
    {
        $codes = [];
        foreach ($this->repo->listCodes(Util::nowMs()) as $r) {
            $codes[] = [
                'id' => $r['id'],
                'label' => $r['label'],
                'role' => $r['role'],
                'driverBinding' => $r['role'] === 'driver' ? self::bindingOf($r) : null,
                'createdAt' => $r['created_at'],
                'expiresAt' => $r['expires_at'],
            ];
        }
        return ['codes' => $codes];
    }

    private function deleteCode(string $rawId): Response
    {
        $id = Util::normalizeUuid($rawId);
        if ($id === null || $this->repo->deleteCode($id) === 0) {
            throw new ApiError(404, 'not_found', '找不到這個配對碼');
        }
        return Response::noContent();
    }

    /** @return array<string, mixed> */
    private function rename(\stdClass $body): array
    {
        $name = Util::cleanName($body->name ?? null, 100);
        if ($name === null) {
            throw ApiError::badRequest('name 必須是 1–100 個字元');
        }
        $this->repo->setName($name);
        return $this->info();
    }

    /** 事件的 expectedRevision（1.2.0，選填）：沒有時 null；不是非負整數時 false（拒絕）。 */
    private static function optionalRevision(mixed $raw): int|false|null
    {
        if (!$raw instanceof \stdClass || !property_exists($raw, 'expectedRevision') || $raw->expectedRevision === null) {
            return null;
        }
        $n = $raw->expectedRevision;
        return is_int($n) && $n >= 0 ? $n : false;
    }

    /**
     * expectedRevision 與主機上的版本不一致時的結果（null 表示沒有衝突）。
     *
     * @param array<string, mixed>|null $existing
     * @return array<string, mixed>|null
     */
    private static function conflict(string $id, ?array $existing, ?int $expectedRevision): ?array
    {
        if ($expectedRevision === null) {
            return null;
        }
        $current = $existing === null ? 0 : (int) $existing['revision'];
        if ($current === $expectedRevision) {
            return null;
        }
        $out = ['id' => $id, 'status' => 'conflict', 'reason' => 'revision-mismatch', 'revision' => $current];
        if ($existing !== null) {
            $out['current'] = ['revision' => $current, 'modifiedAt' => $existing['modifiedAt'], 'deleted' => $existing['deleted']];
        }
        return $out;
    }

    /**
     * 修改前後歷史（1.2.0；只有管理員）：依種類、資料 ID、套用結果、來源篩選，新到舊分頁。
     * 駕駛人的個資預設遮蔽；`pii=1` 顯示完整內容，並在稽核紀錄留下「檢視個資」。
     *
     * @return array<string, mixed>
     */
    private function history(Session $s): array
    {
        $limit = Util::intParam($this->req, 'limit', 50, 1, 200);
        $beforeRaw = $this->req->query('before');
        $before = $beforeRaw === null || $beforeRaw === '' ? null : Util::intParam($this->req, 'before', 0, 0, Util::MAX_SAFE_INTEGER);
        $entity = $this->req->query('entity');
        if ($entity !== null && !Rules::isEntity($entity)) {
            throw ApiError::badRequest('entity 不正確');
        }
        $idRaw = $this->req->query('id');
        $id = $idRaw === null ? null : Util::normalizeUuid($idRaw);
        if ($idRaw !== null && $id === null) {
            throw ApiError::badRequest('id 必須是 UUID');
        }
        $outcome = $this->req->query('outcome');
        if ($outcome !== null && $outcome !== '' && $outcome !== 'applied' && $outcome !== 'notApplied') {
            throw ApiError::badRequest('outcome 必須是 applied 或 notApplied');
        }
        $source = $this->req->query('source');
        if ($source !== null && $source !== '' && !in_array($source, ['app', 'web', 'api', 'cascade'], true)) {
            throw ApiError::badRequest('source 不正確');
        }
        $pii = $this->req->query('pii') === '1';
        $rows = $this->repo->listHistory($entity, $id, $before, $limit,
            $outcome === 'applied' || $outcome === 'notApplied' ? $outcome : null, $source === null || $source === '' ? null : $source);
        if ($pii) {
            $this->repo->addAudit(Util::nowMs(), $s->deviceId, $s->deviceName, $entity ?? 'history', $id ?? '', 'view-pii', '');
        }
        $entries = [];
        foreach ($rows as $r) {
            $entries[] = Admin::historyJson($r, $pii);
        }
        return ['entries' => $entries, 'next' => count($rows) === $limit ? (int) $rows[count($rows) - 1]['id'] : null];
    }

    /** @return array<string, mixed> */
    private function audit(): array
    {
        $limit = Util::intParam($this->req, 'limit', 100, 1, 500);
        $beforeRaw = $this->req->query('before');
        $before = $beforeRaw === null || $beforeRaw === '' ? null : Util::intParam($this->req, 'before', 0, 0, Util::MAX_SAFE_INTEGER);
        $rows = $this->repo->listAudit($before, $limit);
        $entries = [];
        foreach ($rows as $r) {
            $entries[] = [
                'id' => (int) $r['id'],
                'at' => (int) $r['at'],
                'deviceId' => (string) $r['device_id'],
                'deviceName' => (string) $r['device_name'],
                'entity' => (string) $r['entity'],
                'entityId' => (string) $r['entity_id'],
                'operation' => (string) $r['operation'],
                'summary' => (string) $r['summary'],
            ];
        }
        return ['entries' => $entries, 'next' => count($rows) === $limit ? (int) $rows[count($rows) - 1]['id'] : null];
    }
}
