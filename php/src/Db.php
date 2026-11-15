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
    /** 資料表版本：1（1.0–1.1）、2（1.2.0：每筆資料的 revision、修改前後歷史、已處理事件）。 */
    public const SCHEMA_VERSION = 3;

    /** 1.2.0 新增的資料表（從版本 1 遷移時，從結構檔取出這些敘述執行）。 */
    private const V2_TABLES = ['fd_record_history', 'fd_processed_events'];

    private const TABLES = ['fd_meta', 'fd_records', 'fd_devices', 'fd_pairing_codes', 'fd_audit', 'fd_locations', 'fd_attempts'];

    /** 自動建立的 SQLite 資料夾裡放的 .htaccess（Apache：禁止從網站直接下載資料庫檔案）。 */
    private const DENY_HTACCESS = "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n";

    /** 交易中目前的序號（已鎖定）；不在交易中時為 null。 */
    private ?int $txSeq = null;

    private function __construct(
        /** mysql 或 sqlite */
        public readonly string $driver,
        private readonly \PDO $pdo,
        /** SQLite 檔案路徑（升級前備份用）；MySQL 為 null。 */
        private readonly ?string $sqlitePath = null,
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
                return new self('sqlite', $pdo, substr($dsn, strlen('sqlite:')));
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
     * 建立資料表（第一次請求時）與伺服器 ID、名稱、序號；舊版本的資料表逐步遷移到目前版本（1.2.0 起）。
     * 已是目前版本時只多一個查詢。資料表已經手動匯入（帳號沒有建表權限）時不再執行 CREATE TABLE。
     */
    public function ensureSchema(string $schemaDir, string $defaultName): void
    {
        $current = null;
        try {
            $v = $this->value("SELECT v FROM fd_meta WHERE k = 'schema'");
            $current = $v === null ? null : (int) $v;
            if ($current !== null && $current >= self::SCHEMA_VERSION) {
                return;
            }
        } catch (\PDOException) {
            // 資料表還不存在：往下建立。
        }
        if ($current !== null) {
            $this->migrate($schemaDir);
            return;
        }
        $existed = $this->tablesExist();
        if (!$existed) {
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
            // 最後寫入：有這一列表示初始化完成。手動匯入的資料表沒有版本紀錄：依實際的欄位判斷，之後的遷移只補缺少的部分
            ['schema', (string) ($existed ? $this->detectVersion() : self::SCHEMA_VERSION)],
        ];
        foreach ($rows as [$k, $v]) {
            $this->run($insert, [$k, $v]);
        }
        // 舊版建立的資料表（手動匯入 1.1 的結構檔）：補上新版本的欄位與資料表
        $this->migrate($schemaDir);
    }

    /** 目前資料庫的結構版本（還沒初始化時為 0）。 */
    public function schemaVersion(): int
    {
        try {
            return (int) ($this->value("SELECT v FROM fd_meta WHERE k = 'schema'") ?? 0);
        } catch (\PDOException) {
            return 0;
        }
    }

    /**
     * 結構遷移（1.2.0 起）：逐步升級，每一步都可以重複執行，完成後才更新版本。
     * - SQLite：升級前先以 VACUUM INTO 備份資料庫檔案；整步在 BEGIN IMMEDIATE 的交易中（DDL 可回滾）。
     * - MySQL：DDL 會自動提交，以 GET_LOCK 避免兩個請求同時遷移，並逐項檢查是否已完成；升級前請自行備份（mysqldump）。
     */
    private function migrate(string $schemaDir): void
    {
        $from = $this->schemaVersion();
        if ($from >= self::SCHEMA_VERSION) {
            return;
        }
        if ($this->driver === 'sqlite') {
            $this->backupSqlite($from);
            $this->pdo->exec('BEGIN IMMEDIATE');
            try {
                $this->migrateSteps($schemaDir);
                $this->pdo->exec('COMMIT');
            } catch (\Throwable $e) {
                $this->pdo->exec('ROLLBACK');
                throw $e;
            }
            return;
        }
        if ((int) $this->value("SELECT GET_LOCK('fleetdispatch_migrate', 30)") !== 1) {
            throw new SetupError('資料庫正在升級，請稍後再試');
        }
        try {
            $this->migrateSteps($schemaDir);
        } finally {
            $this->value("SELECT RELEASE_LOCK('fleetdispatch_migrate')");
        }
    }

    private function migrateSteps(string $schemaDir): void
    {
        // 在鎖內重新讀取：另一個請求可能已經完成
        $v = $this->schemaVersion();
        if ($v < 2) {
            if (!$this->hasColumn('fd_records', 'revision')) {
                $this->pdo->exec($this->driver === 'sqlite'
                    ? 'ALTER TABLE fd_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 0'
                    : 'ALTER TABLE fd_records ADD COLUMN revision BIGINT NOT NULL DEFAULT 0');
            }
            foreach ($this->schemaStatements($schemaDir) as $sql) {
                foreach (self::V2_TABLES as $table) {
                    if (str_contains($sql, $table)) {
                        $this->pdo->exec($sql);
                        break;
                    }
                }
            }
            // 既有資料的版本從 1 開始（之後的寫入再加 1）
            $this->run('UPDATE fd_records SET revision = 1 WHERE revision = 0');
            // 1.0–1.1 的稽核摘要含駕駛人的個資（證號、電話、備註）：清除摘要，保留誰、何時、做了什麼（docs/audit-history.md）
            $this->run("UPDATE fd_audit SET summary = '' WHERE entity = 'driver'");
            $this->run("UPDATE fd_meta SET v = '2' WHERE k = 'schema'");
            error_log('[fleetdispatch-server] 資料表已由版本 ' . $v . ' 升級到 2');
            $v = 2;
        }
        if ($v < 3) {
            // 網頁管理以 Cookie 登入的種類與期限（docs/security-review.md §1）
            if (!$this->hasColumn('fd_devices', 'web_session')) {
                $this->pdo->exec($this->driver === 'sqlite'
                    ? 'ALTER TABLE fd_devices ADD COLUMN web_session TEXT'
                    : 'ALTER TABLE fd_devices ADD COLUMN web_session VARCHAR(16) NULL');
            }
            if (!$this->hasColumn('fd_devices', 'session_until')) {
                $this->pdo->exec($this->driver === 'sqlite'
                    ? 'ALTER TABLE fd_devices ADD COLUMN session_until INTEGER'
                    : 'ALTER TABLE fd_devices ADD COLUMN session_until BIGINT NULL');
            }
            if ($this->driver === 'mysql') {
                // 修改的欄位清單可能超過 TEXT 的 64 KB（欄位很多的內容）；SQLite 沒有長度限制
                $this->pdo->exec('ALTER TABLE fd_record_history MODIFY changed_fields MEDIUMTEXT NULL');
            }
            // 1.0–1.1 的網頁管理把權杖存在瀏覽器：不再延長，最多再用 30 天（期間內開啟網頁管理會自動換成 Cookie）
            $cap = Util::nowMs() + WebSession::LEGACY_WEB_TTL_MS;
            $this->run(
                "UPDATE fd_devices SET token_expires_at = ? WHERE platform = 'web' AND web_session IS NULL AND revoked_at IS NULL AND token_expires_at > ?",
                [$cap, $cap],
            );
            $this->run("UPDATE fd_meta SET v = '3' WHERE k = 'schema'");
            error_log('[fleetdispatch-server] 資料表已由版本 ' . $v . ' 升級到 3');
        }
    }

    /**
     * 手動匯入（帳號沒有建表權限時，以 phpMyAdmin 匯入結構檔）的資料表的版本：1.1 的結構檔是 1；1.2.0 的結構檔是目前版本，
     * 不需要遷移（這種帳號通常也沒有 ALTER 權限）。
     */
    private function detectVersion(): int
    {
        if (!$this->hasColumn('fd_records', 'revision')) {
            return 1;
        }
        foreach (self::V2_TABLES as $table) {
            try {
                $this->pdo->query("SELECT 1 FROM {$table} WHERE 1 = 0");
            } catch (\PDOException) {
                return 1;
            }
        }
        if (!$this->hasColumn('fd_devices', 'web_session') || !$this->hasColumn('fd_devices', 'session_until')) {
            return 2;
        }
        return self::SCHEMA_VERSION;
    }

    private function hasColumn(string $table, string $column): bool
    {
        if ($this->driver === 'sqlite') {
            foreach ($this->all("PRAGMA table_info({$table})") as $c) {
                if ((string) $c['name'] === $column) {
                    return true;
                }
            }
            return false;
        }
        return (int) $this->value(
            'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [$table, $column],
        ) > 0;
    }

    /** SQLite：升級前把資料庫複製一份（與資料庫同一個資料夾，已禁止從網站存取）。 */
    private function backupSqlite(int $from): void
    {
        $path = $this->sqlitePath;
        if ($path === null || $path === '' || $path === ':memory:' || str_starts_with($path, 'file:')) {
            return;
        }
        $target = $path . '.before-v' . self::SCHEMA_VERSION . '-' . gmdate('Y-m-d\\TH-i-s\\Z') . '.bak';
        $this->pdo->exec("VACUUM INTO " . $this->pdo->quote($target));
        error_log("[fleetdispatch-server] 資料表將由版本 {$from} 升級到 " . self::SCHEMA_VERSION . "；升級前的備份：{$target}");
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
