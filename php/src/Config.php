<?php

declare(strict_types=1);

namespace FleetDispatch;

/** 部署設定（config.php；範例見 config.sample.php）。 */
final class Config
{
    public const DEFAULT_SERVER_NAME = 'FleetDispatch Server';

    public function __construct(
        /** 第一次設定的設定碼（至少 16 個字元）；沒有設定時為 null。 */
        public readonly ?string $setupToken,
        public readonly string $dsn,
        public readonly ?string $dbUser,
        public readonly ?string $dbPassword,
        /** 第一次初始化時使用的伺服器名稱。 */
        public readonly string $serverName,
        /** 信任的反向代理層數：0 = 不採信 X-Forwarded-For；N ≥ 1 = 取 X-Forwarded-For 從右邊數來第 N 個值。 */
        public readonly int $trustedProxies,
        /** 網頁管理的網址路徑（例如 /admin）；null 表示關閉。 */
        public readonly ?string $adminPath = Web::DEFAULT_ADMIN_PATH,
        /** 修改前後歷史保留的天數（1.2.0）：0 是不自動刪除（預設）；否則至少 30 天。 */
        public readonly int $historyRetentionDays = 0,
    ) {
    }

    public static function load(string $path): self
    {
        if ($path === '' || !is_file($path)) {
            throw new MissingConfig('找不到設定檔 config.php（請打開網頁管理的安裝精靈，或依部署文件複製 config.sample.php 成 config.php 後填寫）');
        }
        if (!is_readable($path)) {
            throw new SetupError('無法讀取設定檔 config.php（請檢查檔案權限：PHP 必須能讀取它）');
        }
        try {
            $data = (static function (string $__file) {
                return require $__file;
            })($path);
        } catch (\ParseError $e) {
            error_log('[fleetdispatch-server] config.php 第 ' . $e->getLine() . ' 行：' . $e->getMessage());
            throw new SetupError('設定檔 config.php 有語法錯誤（請檢查引號、逗號與括號；錯誤的行號寫在 PHP 的錯誤日誌）');
        }
        if (!is_array($data)) {
            throw new SetupError('設定檔 config.php 必須 return 一個陣列（請參考 config.sample.php）');
        }

        $setupToken = null;
        $rawToken = $data['setup_token'] ?? null;
        if (is_string($rawToken)) {
            $t = Util::jsTrim($rawToken);
            if (Util::utf16Length($t) >= 16) {
                $setupToken = $t;
            } elseif ($t !== '') {
                error_log('[fleetdispatch-server] config.php 的 setup_token 至少要 16 個字元；目前視為沒有設定。');
            }
        }

        $db = $data['db'] ?? null;
        $dsn = is_array($db) && is_string($db['dsn'] ?? null) ? trim($db['dsn']) : '';
        if ($dsn === '') {
            throw new SetupError('設定檔 config.php 缺少 db.dsn');
        }
        if (!str_starts_with($dsn, 'mysql:') && !str_starts_with($dsn, 'sqlite:')) {
            throw new SetupError('config.php 的 db.dsn 只支援 mysql: 或 sqlite:');
        }
        $user = is_string($db['user'] ?? null) ? $db['user'] : null;
        $password = is_string($db['password'] ?? null) ? $db['password'] : null;

        $name = is_string($data['server_name'] ?? null) ? Util::jsTrim($data['server_name']) : '';

        [$adminPath, $adminError] = Web::parseAdminPath(array_key_exists('admin_path', $data) ? $data['admin_path'] : null);
        if ($adminError !== null) {
            error_log('[fleetdispatch-server] ' . $adminError);
        }
        [$retention, $retentionError] = self::retentionDays($data['history_retention_days'] ?? null);
        if ($retentionError !== null) {
            error_log('[fleetdispatch-server] ' . $retentionError);
        }

        return new self(
            $setupToken,
            $dsn,
            $user,
            $password,
            $name !== '' ? $name : self::DEFAULT_SERVER_NAME,
            self::proxyHops($data['trust_proxy'] ?? 0),
            $adminPath,
            $retention,
        );
    }

    /**
     * history_retention_days（與 core/src/util.ts 的 parseRetentionDays 相同）：沒有設定、空字串或 0 是不自動刪除；
     * 1–29 視為 30；不是非負整數時不自動刪除並回報錯誤。
     *
     * @return array{0: int, 1: string|null}
     */
    public static function retentionDays(mixed $raw): array
    {
        if ($raw === null) {
            return [0, null];
        }
        $text = is_bool($raw) ? '' : trim((string) (is_scalar($raw) ? $raw : ''));
        if (!is_scalar($raw) || is_bool($raw)) {
            return [0, '修改前後歷史的保留天數不是整數，不會自動刪除歷史'];
        }
        if ($text === '' || $text === '0') {
            return [0, null];
        }
        if (preg_match('/^\d{1,6}\z/', $text) !== 1) {
            return [0, '修改前後歷史的保留天數 ' . json_encode($text, JSON_UNESCAPED_UNICODE) . ' 不是整數，不會自動刪除歷史'];
        }
        $n = (int) $text;
        if ($n < 30) {
            return [30, '修改前後歷史的保留天數最少 30 天，已改用 30 天'];
        }
        return [$n, null];
    }

    /** trust_proxy：信任的反向代理層數（非負整數；舊式的 true 視為 1、false 視為 0）。 */
    private static function proxyHops(mixed $v): int
    {
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_int($v) || is_float($v) || (is_string($v) && is_numeric(trim($v)))) {
            $n = (float) (is_string($v) ? trim($v) : $v);
            return is_finite($n) && $n >= 1 ? (int) min(floor($n), 100) : 0;
        }
        return 0;
    }
}
