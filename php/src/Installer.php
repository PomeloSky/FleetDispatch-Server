<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 安裝精靈（只有 PHP 版、只在還沒有 config.php 時存在）：檢查主機環境、測試資料庫、建立資料表、
 * 產生設定碼與管理網址，寫入 config.php。畫面在網頁管理（web/admin.js），透過下面三個端點操作；
 * 安裝完成（config.php 存在）後這些端點回 404，畫面也不再出現。
 *
 *   GET  /api/v1/install        主機環境（Authorization 標頭用來檢查權杖能不能傳到 PHP）；建立安裝金鑰檔
 *   POST /api/v1/install/test   測試資料庫連線（需要安裝金鑰）
 *   POST /api/v1/install        建立資料表並寫入 config.php（需要安裝金鑰；只能成功一次）
 *
 * 安裝金鑰：程式資料夾裡的 install-key.php（PHP 檔，從網站直接開啟不會輸出內容）。只有能用檔案管理員
 * 讀取主機檔案的人拿得到，避免知道網址的其他人搶先安裝，或拿測試連線探測其他主機。程式資料夾不能寫入時
 * 無法建立金鑰檔，安裝精靈不提供測試與安裝（請手動建立 config.php）。
 */
final class Installer
{
    /** 測試與安裝的嘗試次數限制（每個 IP，存在系統暫存資料夾；安裝前沒有資料庫可用）。 */
    private const WINDOW_SECONDS = 900;
    private const MAX_ATTEMPTS = 20;
    private const SQLITE_FILE = '/data/fleetdispatch.sqlite';
    private const KEY_FILE = '/install-key.php';
    private const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

    public static function handle(Request $request, string $path, string $appDir, string $configPath): Response
    {
        $method = $request->method;
        if ($path === 'install') {
            if ($method === 'GET') {
                return Response::json(self::status($request, $appDir, $configPath));
            }
            if ($method === 'POST') {
                self::limit($request, $appDir);
                $in = self::input($request);
                self::requireKey($in, $appDir, $configPath);
                return Response::json(self::install($in, $appDir, $configPath));
            }
        } elseif ($path === 'install/test' && $method === 'POST') {
            self::limit($request, $appDir);
            $in = self::input($request);
            self::requireKey($in, $appDir, $configPath);
            return Response::json(self::test($in, $appDir));
        }
        throw new ApiError(405, 'method_not_allowed', '不支援這個方法');
    }

    /** @return array<string, mixed> */
    private static function status(Request $request, string $appDir, string $configPath): array
    {
        $writable = is_dir($appDir) && is_writable($appDir);
        $keyReady = $writable && self::installable($appDir, $configPath) && self::ensureKey($appDir) !== null;
        return [
            'installed' => false,
            'installable' => self::installable($appDir, $configPath),
            'phpVersion' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION . '.' . PHP_RELEASE_VERSION,
            'drivers' => ['mysql' => extension_loaded('pdo_mysql'), 'sqlite' => extension_loaded('pdo_sqlite')],
            'mbstring' => extension_loaded('mbstring'),
            // 經過 index.php/ 的網址代表網址改寫沒有作用（App 的主機網址要加上 /index.php）。
            'rewrite' => !str_contains($request->path, '/index.php'),
            'authorization' => $request->authorization() !== '',
            'https' => $request->isHttps(),
            'writable' => $writable,
            // 安裝金鑰檔的檔名（在 config.sample.php 所在的資料夾）；建立不了時是 null。
            'keyFile' => $keyReady ? ltrim(self::KEY_FILE, '/') : null,
        ];
    }

    /** 讀取安裝金鑰；檔案不存在時建立（'x' 模式，不覆寫）。程式資料夾不能寫入時回 null。 */
    private static function ensureKey(string $appDir): ?string
    {
        $file = $appDir . self::KEY_FILE;
        $key = self::readKey($file);
        if ($key !== null) {
            return $key;
        }
        $key = self::random(4, self::KEY_ALPHABET) . '-' . self::random(4, self::KEY_ALPHABET) . '-' . self::random(4, self::KEY_ALPHABET);
        $content = "<?php\n"
            . "// FleetDispatch Server 安裝金鑰：網頁的安裝精靈會要求輸入下面這組金鑰，用來確認是能管理這台主機檔案的人在安裝。\n"
            . "// 安裝完成後這個檔案會自動刪除。不要把金鑰告訴別人。\n"
            . "// 安裝金鑰：{$key}\n";
        $fh = @fopen($file, 'x');
        if ($fh === false) {
            return self::readKey($file); // 同時有另一個請求建立了
        }
        $ok = fwrite($fh, $content) === strlen($content);
        fclose($fh);
        if (!$ok) {
            @unlink($file);
            return null;
        }
        @chmod($file, 0600);
        return $key;
    }

    private static function readKey(string $file): ?string
    {
        $raw = @file_get_contents($file);
        if (!is_string($raw) || preg_match('/安裝金鑰：([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/u', $raw, $m) !== 1) {
            return null;
        }
        return $m[1];
    }

    /** 測試與安裝都要附上安裝金鑰（嘗試次數限制在檢查之前，猜測也會被計入）。 */
    private static function requireKey(array $in, string $appDir, string $configPath): void
    {
        if (!self::installable($appDir, $configPath)) {
            throw new ApiError(409, 'not_installable', '設定檔的位置由環境變數 FD_PHP_CONFIG 指定，請手動建立設定檔');
        }
        $expected = self::readKey($appDir . self::KEY_FILE);
        if ($expected === null) {
            throw new ApiError(409, 'not_writable', '程式資料夾不能寫入，無法使用安裝精靈；請依架設說明手動建立 config.php');
        }
        $given = is_string($in['installKey'] ?? null) ? strtoupper((string) preg_replace('/[^A-Za-z0-9]/', '', $in['installKey'])) : '';
        if (!hash_equals(str_replace('-', '', $expected), $given)) {
            throw new ApiError(403, 'invalid_install_key', '安裝金鑰不正確（請用檔案管理員打開程式資料夾裡的 install-key.php 查看）');
        }
    }

    /** 設定檔位置由環境變數 FD_PHP_CONFIG 指定時不使用安裝精靈（進階的部署方式，請手動建立）。 */
    private static function installable(string $appDir, string $configPath): bool
    {
        return $configPath === $appDir . '/config.php';
    }

    /** @return array<string, mixed> */
    private static function input(Request $request): array
    {
        $raw = $request->body(65536);
        if (strlen($raw) > 65536) {
            throw new ApiError(413, 'payload_too_large', '請求本體太大');
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw ApiError::badRequest('請求本體必須是 JSON 物件');
        }
        return $data;
    }

    /**
     * 驗證資料庫設定。主機名稱、資料庫名稱只允許一般字元（不能有 ; = 等會改變 DSN 的字元）；SQLite 的檔案位置固定。
     *
     * @param array<string, mixed> $in
     * @return array{driver: string, dsn: string, user: ?string, password: ?string, label: string}
     */
    private static function dbConfig(array $in, string $appDir): array
    {
        $driver = $in['driver'] ?? null;
        if ($driver === 'sqlite') {
            if (!extension_loaded('pdo_sqlite')) {
                throw ApiError::badRequest('這台主機的 PHP 沒有啟用 pdo_sqlite');
            }
            return ['driver' => 'sqlite', 'dsn' => 'sqlite:' . $appDir . self::SQLITE_FILE, 'user' => null, 'password' => null, 'label' => 'SQLite'];
        }
        if ($driver !== 'mysql') {
            throw ApiError::badRequest('請選擇資料庫類型');
        }
        if (!extension_loaded('pdo_mysql')) {
            throw ApiError::badRequest('這台主機的 PHP 沒有啟用 pdo_mysql，請在主機控制台的 PHP 設定中啟用');
        }
        $host = is_string($in['host'] ?? null) ? trim($in['host']) : '';
        if ($host === '') {
            $host = 'localhost';
        }
        if (preg_match('/^[A-Za-z0-9._-]{1,253}$/D', $host) !== 1) {
            throw ApiError::badRequest('資料庫主機只能是主機名稱或 IP（例如 localhost）');
        }
        $port = $in['port'] ?? 3306;
        if (is_string($port) && trim($port) !== '' && ctype_digit(trim($port))) {
            $port = (int) trim($port);
        }
        if ($port === '' || $port === null) {
            $port = 3306;
        }
        if (!is_int($port) || $port < 1 || $port > 65535) {
            throw ApiError::badRequest('連接埠必須是 1–65535 的整數（MySQL 通常是 3306）');
        }
        $name = is_string($in['name'] ?? null) ? trim($in['name']) : '';
        if (preg_match('/^[A-Za-z0-9_$-]{1,64}$/D', $name) !== 1) {
            throw ApiError::badRequest('請輸入資料庫名稱（英數字、底線與 -，最多 64 個字元）');
        }
        $user = is_string($in['user'] ?? null) ? trim($in['user']) : '';
        if ($user === '' || strlen($user) > 80 || preg_match('/[\x00-\x1F\x7F]/', $user) === 1) {
            throw ApiError::badRequest('請輸入資料庫使用者');
        }
        $password = is_string($in['password'] ?? null) ? $in['password'] : '';
        if (strlen($password) > 200 || preg_match('/[\x00-\x1F\x7F]/', $password) === 1) {
            throw ApiError::badRequest('資料庫密碼格式不正確');
        }
        return [
            'driver' => 'mysql',
            'dsn' => "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4",
            'user' => $user,
            'password' => $password,
            'label' => 'MySQL',
        ];
    }

    /**
     * @param array<string, mixed> $in
     * @return array<string, mixed>
     */
    private static function test(array $in, string $appDir): array
    {
        $db = self::dbConfig($in, $appDir);
        if ($db['driver'] === 'sqlite') {
            // 與正式執行相同的方式建立 data/（含禁止網站直接存取的 .htaccess 與空白 index.html）。
            Db::prepareSqliteDir($appDir . self::SQLITE_FILE);
            $dir = $appDir . '/data';
            if (!is_dir($dir)) {
                throw new ApiError(400, 'db_error', '無法建立 data 資料夾（程式資料夾必須讓 PHP 可以寫入）');
            }
            if (!is_writable($dir)) {
                throw new ApiError(400, 'db_error', 'data 資料夾不能寫入（請把權限改成 PHP 可以寫入）');
            }
        }
        $pdo = self::connect($db);
        $version = $db['driver'] === 'mysql'
            ? (string) $pdo->query('SELECT VERSION()')->fetchColumn()
            : 'SQLite ' . (string) $pdo->query('SELECT sqlite_version()')->fetchColumn();
        return ['ok' => true, 'version' => $version, 'warning' => self::versionWarning($db['driver'], $version)];
    }

    /** MySQL 8.0、MariaDB 10.6 以上（舊版可能缺少需要的語法）。 */
    private static function versionWarning(string $driver, string $version): ?string
    {
        if ($driver !== 'mysql' || preg_match('/^(\d+)\.(\d+)/', $version, $m) !== 1) {
            return null;
        }
        $major = (int) $m[1];
        $minor = (int) $m[2];
        if (stripos($version, 'mariadb') !== false) {
            return ($major > 10 || ($major === 10 && $minor >= 6)) ? null : '資料庫是 MariaDB ' . $m[0] . '，建議 10.6 以上';
        }
        return $major >= 8 ? null : '資料庫是 MySQL ' . $m[0] . '，建議 8.0 以上';
    }

    /** @param array{driver: string, dsn: string, user: ?string, password: ?string, label: string} $db */
    private static function connect(array $db): \PDO
    {
        try {
            return new \PDO($db['dsn'], $db['user'], $db['password'], [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                \PDO::ATTR_TIMEOUT => 5,
            ]);
        } catch (\PDOException $e) {
            // 原始訊息可能含主機名稱與帳號，只寫進日誌；回給畫面的是依錯誤代碼整理的說明。
            error_log('[fleetdispatch-server] 安裝精靈連線失敗：' . $e->getMessage());
            $code = 0;
            if (preg_match('/\[(\d{4})\]/', $e->getMessage(), $m) === 1) {
                $code = (int) $m[1];
            } elseif (isset($e->errorInfo[1]) && is_int($e->errorInfo[1])) {
                $code = $e->errorInfo[1];
            }
            $message = match ($code) {
                1045 => '帳號或密碼錯誤',
                1044 => '這個使用者沒有權限使用這個資料庫（請在主機控制台把使用者加入資料庫，並給予全部權限）',
                1049 => '找不到這個資料庫（請先在主機控制台建立，名稱通常有帳號前綴，例如 帳號_fleet）',
                2002, 2003, 2005, 2006 => '無法連到資料庫主機（請確認主機名稱與連接埠；虛擬主機通常是 localhost）',
                default => $db['driver'] === 'sqlite' ? '無法建立 SQLite 資料庫檔案' : '無法連線到資料庫' . ($code > 0 ? "（錯誤代碼 {$code}）" : ''),
            };
            throw new ApiError(400, 'db_error', $message);
        }
    }

    /**
     * @param array<string, mixed> $in
     * @return array<string, mixed>
     */
    private static function install(array $in, string $appDir, string $configPath): array
    {
        if (!self::installable($appDir, $configPath)) {
            throw new ApiError(409, 'not_installable', '設定檔的位置由環境變數 FD_PHP_CONFIG 指定，請手動建立設定檔');
        }
        if (file_exists($configPath)) {
            throw new ApiError(409, 'already_installed', '已經安裝過了（config.php 已經存在）');
        }
        $tested = self::test($in, $appDir);
        $db = self::dbConfig($in, $appDir);
        $name = is_string($in['serverName'] ?? null) ? Util::jsTrim($in['serverName']) : '';
        if ($name === '') {
            $name = Config::DEFAULT_SERVER_NAME;
        }
        if (Util::utf16Length($name) > 100 || preg_match('/[\x00-\x1F\x7F]/', $name) === 1) {
            throw ApiError::badRequest('主機名稱最多 100 個字元');
        }
        $token = self::random(32, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789');
        $adminPath = '/manage-' . self::random(10, 'abcdefghijkmnopqrstuvwxyz23456789');

        // 用同樣的設定建立資料表：確認帳號有建表權限，安裝完成後第一個請求就能使用。
        try {
            $config = new Config($token, $db['dsn'], $db['user'], $db['password'], $name, 0, $adminPath);
            Db::connect($config)->ensureSchema($appDir . '/schema', $name);
        } catch (SetupError $e) {
            throw new ApiError(400, 'db_error', '無法建立資料表：' . $e->getMessage());
        }

        $content = self::configText($db, $token, $name, $adminPath);
        $written = self::write($configPath, $content);
        if ($written) {
            @unlink($appDir . self::KEY_FILE);
        }
        return [
            'written' => $written,
            'setupToken' => $token,
            'adminPath' => $adminPath,
            'database' => $tested['version'],
            // 不能寫入時把內容交給畫面，讓使用者用檔案管理員自己建立。
            'config' => $written ? null : $content,
        ];
    }

    /** 只在設定檔不存在時建立（'x' 模式；不會覆寫別人剛完成的安裝）。資料夾不能寫入時回 false。 */
    private static function write(string $path, string $content): bool
    {
        $fh = @fopen($path, 'x');
        if ($fh === false) {
            if (file_exists($path)) {
                throw new ApiError(409, 'already_installed', '已經安裝過了（config.php 已經存在）');
            }
            return false;
        }
        $ok = fwrite($fh, $content) === strlen($content);
        fclose($fh);
        if (!$ok) {
            @unlink($path);
            return false;
        }
        @chmod($path, 0600);
        return true;
    }

    /** @param array{driver: string, dsn: string, user: ?string, password: ?string, label: string} $db */
    private static function configText(array $db, string $token, string $name, string $adminPath): string
    {
        $q = static fn (mixed $v): string => var_export($v, true);
        $lines = [
            '<?php',
            '// FleetDispatch Server（PHP 版）設定檔：由安裝精靈產生（' . gmdate('Y-m-d H:i') . ' UTC）。',
            '// 欄位說明見 config.sample.php 與 docs/setup-php-mysql.md。這個檔案含資料庫密碼與設定碼，不要公開或提交到版本控制。',
            '',
            'return [',
            '    // 設定碼：主機還沒有管理員時，用它建立第一位管理員（之後不再有效；管理員裝置遺失時用來恢復）。',
            "    'setup_token' => " . $q($token) . ',',
            '',
            "    'db' => [",
        ];
        if ($db['driver'] === 'sqlite') {
            $lines[] = "        'dsn' => 'sqlite:' . __DIR__ . " . $q(self::SQLITE_FILE) . ',';
        } else {
            $lines[] = "        'dsn' => " . $q($db['dsn']) . ',';
            $lines[] = "        'user' => " . $q($db['user']) . ',';
            $lines[] = "        'password' => " . $q($db['password']) . ',';
        }
        array_push(
            $lines,
            '    ],',
            '',
            "    'server_name' => " . $q($name) . ',',
            '',
            '    // 網頁管理的網址（不要公開分享）。',
            "    'admin_path' => " . $q($adminPath) . ',',
            '',
            '    // 前面有幾層你自己控制的反向代理（說明見 config.sample.php）。',
            "    'trust_proxy' => 0,",
            '];',
        );
        return implode("\n", $lines) . "\n";
    }

    private static function random(int $length, string $alphabet): string
    {
        $out = '';
        $max = strlen($alphabet) - 1;
        for ($i = 0; $i < $length; $i++) {
            $out .= $alphabet[random_int(0, $max)];
        }
        return $out;
    }

    private static function limit(Request $request, string $appDir): void
    {
        $file = sys_get_temp_dir() . '/fd-install-' . substr(hash('sha256', $appDir . '|' . $request->clientIp(0)), 0, 24) . '.json';
        $now = time();
        $list = [];
        $raw = @file_get_contents($file);
        if (is_string($raw)) {
            $v = json_decode($raw, true);
            if (is_array($v)) {
                $list = array_values(array_filter($v, static fn (mixed $t): bool => is_int($t) && $t > $now - self::WINDOW_SECONDS));
            }
        }
        if (count($list) >= self::MAX_ATTEMPTS) {
            throw new ApiError(429, 'rate_limited', '嘗試太多次，請稍後再試', max(1, $list[0] + self::WINDOW_SECONDS - $now));
        }
        $list[] = $now;
        @file_put_contents($file, json_encode($list), LOCK_EX);
    }
}
