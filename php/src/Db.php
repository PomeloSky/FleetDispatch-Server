<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 資料庫連線（PDO）：MySQL 8.0+／MariaDB 10.6+（正式使用）或 SQLite（測試與很小的主機）。
 *
 * 寫入一律在 transaction() 中進行，交易一開始先取得「全主機寫入鎖」：
 * - SQLite：BEGIN IMMEDIATE（同一時間只有一個寫入者）。
 * - MySQL：交易的第一句是 `SELECT v FROM fd_meta WHERE k = 'seq' FOR UPDATE`（鎖住序號那一列）。
 * 所以每筆寫入都取得唯一、依提交順序遞增的序號；授權與最後寫入者勝也都以鎖定之後讀到的最新狀態判斷，
 * 並行的請求不會互相覆蓋。所有 SQL 都是參數化查詢。
 */
final class Db
{
    public const SCHEMA_VERSION = 1;

    private const TABLES = ['fd_meta', 'fd_records', 'fd_devices', 'fd_pairing_codes', 'fd_audit', 'fd_locations', 'fd_attempts'];

    /** 自動建立的 SQLite 資料夾裡放的 .htaccess（Apache：禁止從網站直接下載資料庫檔案）。 */
    private const DENY_HTACCESS = "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n";

    /** 交易中目前的序號（已鎖定）；不在交易中時為 null。 */
    private ?int $txSeq = null;

    private function __construct(
        /** mysql 或 sqlite */
        public readonly string $driver,
        private readonly \PDO $pdo,
    ) {
    }

    public static function connect(Config $config): self
    {
        $options = [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_STRINGIFY_FETCHES => false,
        ];
        $dsn = $config->dsn;
        $sqlite = str_starts_with($dsn, 'sqlite:');
        $driver = $sqlite ? 'pdo_sqlite' : 'pdo_mysql';
        if (!extension_loaded($driver)) {
            throw new SetupError("PHP 沒有啟用 {$driver} 擴充功能（請在主機的 PHP 設定中啟用）");
        }
        try {
            if ($sqlite) {
                self::prepareSqliteDir(substr($dsn, strlen('sqlite:')));
                $options[\PDO::ATTR_TIMEOUT] = 5;
                $pdo = new \PDO($dsn, null, null, $options);
                $pdo->exec('PRAGMA busy_timeout = 5000');
                try {
                    // WAL：讀取不會被寫入擋住（與 Docker 版相同）。切換失敗（例如檔案系統不支援）時維持原本的模式。
                    $pdo->exec('PRAGMA journal_mode = WAL');
                } catch (\PDOException) {
                }
                $pdo->exec('PRAGMA synchronous = NORMAL');
                return new self('sqlite', $pdo);
            }
            // 一律用 utf8mb4（中文以外也能存表情符號等 4 位元組字元）。
            if (preg_match('/(^|;)\s*charset\s*=/i', substr($dsn, strlen('mysql:'))) === 1) {
                $dsn = (string) preg_replace('/charset\s*=[^;]*/i', 'charset=utf8mb4', $dsn);
            } else {
                $dsn .= (str_ends_with($dsn, ';') ? '' : ';') . 'charset=utf8mb4';
            }
            // 伺服器端的預備陳述式：浮點數、整數以原生型別往返，LIMIT ? 也能綁定整數。
            $options[\PDO::ATTR_EMULATE_PREPARES] = false;
            $options[\PDO::ATTR_TIMEOUT] = 10;
            $pdo = new \PDO($dsn, $config->dbUser, $config->dbPassword, $options);
            // 嚴格模式（資料過長時報錯而不是截斷）；沒有 InnoDB 時建表失敗，而不是改用不支援交易的引擎。
            $pdo->exec("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'");
            return new self('mysql', $pdo);
        } catch (\PDOException $e) {
            // PDO 的錯誤訊息可能含主機名稱與帳號，只寫進日誌，不回給用戶端。
            error_log('[fleetdispatch-server] 無法連線到資料庫：' . $e->getMessage());
            throw new SetupError('無法連線到資料庫（請檢查 config.php 的 db 設定，以及資料庫是否正在執行）');
        }
    }

    /** SQLite 的資料夾不存在時建立（並加上禁止網站直接存取的 .htaccess）。 */
    /**
     * SQLite 檔案所在的資料夾：不存在時建立；禁止網站直接存取的 .htaccess 與空白 index.html 缺少時補上
     * （資料夾可能由其他方式建立，例如手動或安裝精靈）。
     */
    public static function prepareSqliteDir(string $path): void
    {
        if ($path === '' || $path === ':memory:' || str_starts_with($path, 'file:')) {
            return;
        }
        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
            return; // 交給 PDO 回報無法開啟
        }
        if (!is_file($dir . '/.htaccess')) {
            @file_put_contents($dir . '/.htaccess', self::DENY_HTACCESS);
        }
        if (!is_file($dir . '/index.html')) {
            @file_put_contents($dir . '/index.html', '');
        }
    }

    // ───────── 查詢 ─────────

    /**
     * @param list<mixed> $params
     */
    private function execute(string $sql, array $params): \PDOStatement
    {
        $st = $this->pdo->prepare($sql);
        $i = 1;
        foreach ($params as $p) {
            if ($p === null) {
                $st->bindValue($i, null, \PDO::PARAM_NULL);
            } elseif (is_int($p)) {
                $st->bindValue($i, $p, \PDO::PARAM_INT);
            } elseif (is_bool($p)) {
                $st->bindValue($i, $p ? 1 : 0, \PDO::PARAM_INT);
            } elseif (is_float($p)) {
                // PDO 會依 precision 設定（預設 14 位有效數字）把浮點數轉成字串而失去精度；
                // var_export 依 serialize_precision（啟動時設為 -1）輸出可完整還原的最短表示法，且不受地區設定影響。
                $st->bindValue($i, var_export($p, true), \PDO::PARAM_STR);
            } else {
                $st->bindValue($i, (string) $p, \PDO::PARAM_STR);
            }
            $i++;
        }
        $st->execute();
        return $st;
    }

    /**
     * 執行寫入，回傳受影響的列數（MySQL 是「實際改變」的列數）。
     *
     * @param list<mixed> $params
     */
    public function run(string $sql, array $params = []): int
    {
        $st = $this->execute($sql, $params);
        $n = $st->rowCount();
        $st->closeCursor();
        return $n;
    }

    /**
     * @param list<mixed> $params
     * @return list<array<string, mixed>>
     */
    public function all(string $sql, array $params = []): array
    {
        $st = $this->execute($sql, $params);
        $rows = $st->fetchAll(\PDO::FETCH_ASSOC);
        $st->closeCursor();
        return $rows;
    }

    /**
     * @param list<mixed> $params
     * @return array<string, mixed>|null
     */
    public function first(string $sql, array $params = []): ?array
    {
        $st = $this->execute($sql, $params);
        $row = $st->fetch(\PDO::FETCH_ASSOC);
        $st->closeCursor();
        return $row === false ? null : $row;
    }

    /**
     * 第一列第一欄；沒有資料時回傳 null。
     *
     * @param list<mixed> $params
     */
    public function value(string $sql, array $params = []): mixed
    {
        $row = $this->first($sql, $params);
        return $row === null ? null : reset($row);
    }

    /**
     * 逐列讀取（快照用；不必把整個結果轉成陣列）。迴圈中不要再執行其他查詢。
     *
     * @param list<mixed> $params
     * @return \Generator<int, array<string, mixed>>
     */
    public function iterate(string $sql, array $params = []): \Generator
    {
        $st = $this->execute($sql, $params);
        try {
            while (($row = $st->fetch(\PDO::FETCH_ASSOC)) !== false) {
                yield $row;
            }
        } finally {
            $st->closeCursor();
        }
    }

    // ───────── 交易與序號 ─────────

    /**
     * 在交易中執行（先取得全主機寫入鎖）。$fn 拋出例外時回滾；遇到死結、鎖等待逾時或資料庫忙碌時整個重試（最多 3 次），
     * 所以 $fn 只能做資料庫操作，不能有其他副作用。
     *
     * @template T
     * @param callable(): T $fn
     * @return T
     */
    public function transaction(callable $fn): mixed
    {
        for ($attempt = 1; ; $attempt++) {
            try {
                $this->begin();
                $result = $fn();
                $this->commit();
                return $result;
            } catch (\Throwable $e) {
                $this->rollBack();
                if ($attempt < 3 && $this->isRetryable($e)) {
                    usleep(random_int(10000, 50000) * $attempt);
                    continue;
                }
                throw $e;
            }
        }
    }

    private function begin(): void
    {
        if ($this->driver === 'sqlite') {
            $this->pdo->exec('BEGIN IMMEDIATE');
            $seq = $this->value("SELECT v FROM fd_meta WHERE k = 'seq'");
        } else {
            $this->pdo->beginTransaction();
            // 交易的第一句必須是鎖定讀取：InnoDB 的一致性快照在第一次「非鎖定」讀取時才建立，
            // 所以之後的讀取都會看到取得鎖之前已提交的最新資料。
            $seq = $this->value("SELECT v FROM fd_meta WHERE k = 'seq' FOR UPDATE");
        }
        if ($seq === null) {
            throw new \RuntimeException('fd_meta 缺少 seq');
        }
        $this->txSeq = (int) $seq;
    }

    private function commit(): void
    {
        if ($this->driver === 'sqlite') {
            $this->pdo->exec('COMMIT');
        } else {
            $this->pdo->commit();
        }
        $this->txSeq = null;
    }

    private function rollBack(): void
    {
        $this->txSeq = null;
        try {
            if ($this->driver === 'sqlite') {
                $this->pdo->exec('ROLLBACK');
            } elseif ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
        } catch (\Throwable) {
            // 交易可能已經被資料庫結束（或根本還沒開始）。
        }
    }

    private function isRetryable(\Throwable $e): bool
    {
        if (!$e instanceof \PDOException) {
            return false;
        }
        $info = is_array($e->errorInfo) ? $e->errorInfo : [];
        $state = (string) ($info[0] ?? $e->getCode());
        $code = (int) ($info[1] ?? 0);
        if ($this->driver === 'mysql') {
            return $state === '40001' || $code === 1213 || $code === 1205; // 死結、鎖等待逾時
        }
        return $code === 5 || $code === 6; // SQLITE_BUSY、SQLITE_LOCKED
    }

    public static function isUniqueViolation(\PDOException $e): bool
    {
        $info = is_array($e->errorInfo) ? $e->errorInfo : [];
        return (string) ($info[0] ?? $e->getCode()) === '23000';
    }

    /** 取得下一個變更序號（只能在 transaction() 中使用）。 */
    public function nextSeq(): int
    {
        if ($this->txSeq === null) {
            throw new \LogicException('nextSeq() 只能在交易中使用');
        }
        $this->txSeq++;
        $this->run("UPDATE fd_meta SET v = ? WHERE k = 'seq'", [(string) $this->txSeq]);
        return $this->txSeq;
    }

    // ───────── 資料表 ─────────

    /**
     * 建立資料表（第一次請求時）與伺服器 ID、名稱、序號。已初始化時只多一個查詢。
     * 資料表已經手動匯入（帳號沒有建表權限）時不再執行 CREATE TABLE。
     */
    public function ensureSchema(string $schemaDir, string $defaultName): void
    {
        try {
            $v = $this->value("SELECT v FROM fd_meta WHERE k = 'schema'");
            if ($v !== null && (int) $v >= self::SCHEMA_VERSION) {
                return;
            }
        } catch (\PDOException) {
            // 資料表還不存在：往下建立。
        }
        if (!$this->tablesExist()) {
            foreach ($this->schemaStatements($schemaDir) as $sql) {
                $this->pdo->exec($sql);
            }
        }
        $insert = $this->driver === 'sqlite'
            ? 'INSERT OR IGNORE INTO fd_meta (k, v) VALUES (?, ?)'
            : 'INSERT INTO fd_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE k = k';
        $rows = [
            ['seq', '0'],
            ['serverId', Crypto::uuid4()],
            ['name', $defaultName],
            ['createdAt', (string) Util::nowMs()],
            ['schema', (string) self::SCHEMA_VERSION], // 最後寫入：有這一列表示初始化完成
        ];
        foreach ($rows as [$k, $v]) {
            $this->run($insert, [$k, $v]);
        }
    }

    private function tablesExist(): bool
    {
        foreach (self::TABLES as $table) {
            try {
                $this->pdo->query("SELECT 1 FROM {$table} WHERE 1 = 0");
            } catch (\PDOException) {
                return false;
            }
        }
        return true;
    }

    /**
     * 讀取 schema/<driver>.sql，去掉註解行後以分號切成多個敘述。
     *
     * @return list<string>
     */
    private function schemaStatements(string $schemaDir): array
    {
        $text = @file_get_contents($schemaDir . '/' . $this->driver . '.sql');
        if ($text === false) {
            throw new SetupError("找不到資料庫結構檔 schema/{$this->driver}.sql（請確認整個程式資料夾都已上傳）");
        }
        $lines = [];
        foreach (preg_split('/\r\n|\n|\r/', $text) ?: [] as $line) {
            if (!str_starts_with(ltrim($line), '--')) {
                $lines[] = $line;
            }
        }
        $out = [];
        foreach (explode(';', implode("\n", $lines)) as $statement) {
            $statement = trim($statement);
            if ($statement !== '') {
                $out[] = $statement;
            }
        }
        return $out;
    }
}
