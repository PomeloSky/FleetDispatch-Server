<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 儲存層（對應 core/src/db.ts 的 Repo）。資料表與欄位和 TypeScript 版相同；SQL 只用 MySQL 與 SQLite 都支援的語法，
 * 「沒有就新增、有就更新」在寫入交易中先讀再寫（不依賴 UPSERT 語法，舊版 SQLite 也能用）。
 */
final class Repo
{
    private const RECORD_COLUMNS = 'entity, id, seq, modified_at, deleted, payload, driver_uuid, driver_name, requester_device, vehicle_plate, created_by, revision';
    private const DEVICE_COLUMNS = 'device_id, name, platform, role, driver_uuid, driver_name, token_hash, token_expires_at, paired_at, last_seen_at, revoked_at, identity, web_session, session_until';
    /** 可以使用的管理員（參數：現在的時間）。 */
    private const USABLE_ADMIN = "role = 'admin' AND revoked_at IS NULL AND token_hash IS NOT NULL AND token_expires_at > ?";
    private const CODE_COLUMNS = 'id, code_hash, role, driver_uuid, driver_name, label, created_by, created_at, expires_at, used_at';

    public function __construct(private readonly Db $db)
    {
    }

    private static function nstr(mixed $v): ?string
    {
        return $v === null ? null : (string) $v;
    }

    private static function nint(mixed $v): ?int
    {
        return $v === null ? null : (int) $v;
    }

    // ───────── 伺服器資訊 ─────────

    /** @return array{serverId: string, name: string} */
    public function meta(): array
    {
        $out = ['serverId' => '', 'name' => ''];
        foreach ($this->db->all("SELECT k, v FROM fd_meta WHERE k IN ('serverId', 'name')") as $r) {
            $out[(string) $r['k']] = (string) $r['v'];
        }
        return $out;
    }

    public function setName(string $name): void
    {
        $this->db->run("UPDATE fd_meta SET v = ? WHERE k = 'name'", [$name]);
    }

    public function currentSeq(): int
    {
        return (int) ($this->db->value("SELECT v FROM fd_meta WHERE k = 'seq'") ?? 0);
    }

    // ───────── 裝置 ─────────

    /**
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private static function device(array $r): array
    {
        return [
            'device_id' => (string) $r['device_id'],
            'name' => (string) $r['name'],
            'platform' => (string) $r['platform'],
            'role' => (string) $r['role'],
            'driver_uuid' => self::nstr($r['driver_uuid']),
            'driver_name' => self::nstr($r['driver_name']),
            'token_hash' => self::nstr($r['token_hash']),
            'token_expires_at' => self::nint($r['token_expires_at']),
            'paired_at' => (int) $r['paired_at'],
            'last_seen_at' => self::nint($r['last_seen_at']),
            'revoked_at' => self::nint($r['revoked_at']),
            'identity' => self::nstr($r['identity']),
            'web_session' => self::nstr($r['web_session']),
            'session_until' => self::nint($r['session_until']),
        ];
    }

    /**
     * 可以使用的管理員（沒有解除配對、權杖還沒過期）的數量。是 0 時設定碼有效：第一次設定，或所有管理員的登入都已失效時
     * 可以用設定碼重新建立管理員（docs/security-review.md §2）。
     */
    public function countActiveAdmins(int $now): int
    {
        return (int) $this->db->value('SELECT COUNT(*) AS n FROM fd_devices WHERE ' . self::USABLE_ADMIN, [$now]);
    }

    /** 不含 $id 的其他可以使用的管理員數量（解除配對、降級前檢查；在寫入交易中呼叫）。 */
    public function countOtherAdmins(string $id, int $now): int
    {
        return (int) $this->db->value('SELECT COUNT(*) AS n FROM fd_devices WHERE ' . self::USABLE_ADMIN . ' AND device_id != ?', [$now, $id]);
    }

    /** @return array<string, mixed>|null */
    public function deviceByTokenHash(string $hash): ?array
    {
        $r = $this->db->first('SELECT ' . self::DEVICE_COLUMNS . ' FROM fd_devices WHERE token_hash = ? AND revoked_at IS NULL', [$hash]);
        return $r === null ? null : self::device($r);
    }

    /** @return array<string, mixed>|null */
    public function deviceById(string $id): ?array
    {
        $r = $this->db->first('SELECT ' . self::DEVICE_COLUMNS . ' FROM fd_devices WHERE device_id = ?', [$id]);
        return $r === null ? null : self::device($r);
    }

    /** @return list<array<string, mixed>> */
    public function listDevices(): array
    {
        return array_map(static fn (array $r): array => self::device($r), $this->db->all('SELECT ' . self::DEVICE_COLUMNS . ' FROM fd_devices ORDER BY paired_at'));
    }

    public function touchDevice(string $id, int $now, int $expiresAt): void
    {
        $this->db->run('UPDATE fd_devices SET last_seen_at = ?, token_expires_at = ? WHERE device_id = ?', [$now, $expiresAt, $id]);
    }

    /**
     * 配對成功：建立裝置，或覆寫同一個 ID 的舊裝置（解除配對或權杖過期的）。在寫入交易中呼叫。
     * 每次配對都產生新的主機端身分（identity）：以同一個 deviceId 重新配對不會繼承之前建立的資料的擁有權。
     *
     * `web`：網頁管理以 Cookie 登入（1.2.0）的種類與期限；App 是 null。
     *
     * @param array{id: string, name: string, platform: string, role: string, binding: array{driverUuid: string, driverName: string}|null, tokenHash: string, expiresAt: int, web?: array{kind: string, until: int}|null} $d
     */
    public function saveDevice(bool $exists, array $d, int $now): void
    {
        $uuid = $d['binding']['driverUuid'] ?? null;
        $name = $d['binding']['driverName'] ?? null;
        $identity = Crypto::uuid4();
        $webKind = $d['web']['kind'] ?? null;
        $webUntil = $d['web']['until'] ?? null;
        if ($exists) {
            $this->db->run(
                'UPDATE fd_devices SET name = ?, platform = ?, role = ?, driver_uuid = ?, driver_name = ?, token_hash = ?, token_expires_at = ?,
                   paired_at = ?, last_seen_at = ?, revoked_at = NULL, identity = ?, web_session = ?, session_until = ? WHERE device_id = ?',
                [$d['name'], $d['platform'], $d['role'], $uuid, $name, $d['tokenHash'], $d['expiresAt'], $now, $now, $identity, $webKind, $webUntil, $d['id']],
            );
            return;
        }
        $this->db->run(
            'INSERT INTO fd_devices (device_id, name, platform, role, driver_uuid, driver_name, token_hash, token_expires_at, paired_at, last_seen_at, revoked_at, identity,
                web_session, session_until)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
            [$d['id'], $d['name'], $d['platform'], $d['role'], $uuid, $name, $d['tokenHash'], $d['expiresAt'], $now, $now, $identity, $webKind, $webUntil],
        );
    }

    /**
     * 1.1 的網頁權杖換成 Cookie 登入（POST /web/upgrade）：以舊權杖為條件換新權杖與期限，同時送出的兩個請求只有一個成功。
     *
     * @param array{tokenHash: string, kind: string, until: int, expiresAt: int} $s
     */
    public function upgradeWebSession(string $id, string $oldHash, array $s, int $now): bool
    {
        return $this->db->run(
            'UPDATE fd_devices SET token_hash = ?, token_expires_at = ?, web_session = ?, session_until = ?, last_seen_at = ?
               WHERE device_id = ? AND token_hash = ? AND revoked_at IS NULL AND web_session IS NULL AND token_expires_at > ?',
            [$s['tokenHash'], $s['expiresAt'], $s['kind'], $s['until'], $now, $id, $oldHash, $now],
        ) > 0;
    }

    public function revokeDevice(string $id, int $now): void
    {
        $this->db->run('UPDATE fd_devices SET revoked_at = ?, token_hash = NULL WHERE device_id = ? AND revoked_at IS NULL', [$now, $id]);
    }

    /** @param array{driverUuid: string, driverName: string}|null $binding */
    public function updateDevice(string $id, string $role, ?array $binding): void
    {
        $this->db->run(
            'UPDATE fd_devices SET role = ?, driver_uuid = ?, driver_name = ? WHERE device_id = ?',
            [$role, $binding['driverUuid'] ?? null, $binding['driverName'] ?? null, $id],
        );
    }

    // ───────── 配對嘗試次數 ─────────

    public function recordFailure(string $ip, int $now): void
    {
        $this->db->run('DELETE FROM fd_attempts WHERE at < ?', [$now - 24 * 3600 * 1000]);
        $this->db->run('INSERT INTO fd_attempts (ip, at) VALUES (?, ?)', [$ip, $now]);
    }

    /** @return array{count: int, oldest: int|null} */
    public function failures(string $ip, int $since): array
    {
        $r = $this->db->first('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM fd_attempts WHERE ip = ? AND at > ?', [$ip, $since]);
        return ['count' => (int) ($r['n'] ?? 0), 'oldest' => self::nint($r['oldest'] ?? null)];
    }

    // ───────── 配對碼 ─────────

    /**
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private static function code(array $r): array
    {
        return [
            'id' => (string) $r['id'],
            'code_hash' => (string) $r['code_hash'],
            'role' => (string) $r['role'],
            'driver_uuid' => self::nstr($r['driver_uuid']),
            'driver_name' => self::nstr($r['driver_name']),
            'label' => (string) $r['label'],
            'created_by' => (string) $r['created_by'],
            'created_at' => (int) $r['created_at'],
            'expires_at' => (int) $r['expires_at'],
            'used_at' => self::nint($r['used_at']),
        ];
    }

    /** @param array{id: string, code_hash: string, role: string, driver_uuid: ?string, driver_name: ?string, label: string, created_by: string, created_at: int, expires_at: int} $row */
    public function createCode(array $row): void
    {
        $this->db->run(
            'INSERT INTO fd_pairing_codes (id, code_hash, role, driver_uuid, driver_name, label, created_by, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$row['id'], $row['code_hash'], $row['role'], $row['driver_uuid'], $row['driver_name'], $row['label'], $row['created_by'], $row['created_at'], $row['expires_at']],
        );
    }

    /** @return array<string, mixed>|null */
    public function findUsableCode(string $hash, int $now): ?array
    {
        $r = $this->db->first('SELECT ' . self::CODE_COLUMNS . ' FROM fd_pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', [$hash, $now]);
        return $r === null ? null : self::code($r);
    }

    /** 用掉配對碼（單次有效：只有還沒用過、沒過期的才會被更新）。回傳是否成功。 */
    public function consumeCode(string $hash, string $deviceId, int $now): bool
    {
        return $this->db->run(
            'UPDATE fd_pairing_codes SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
            [$now, $deviceId, $hash, $now],
        ) > 0;
    }

    /** @return list<array<string, mixed>> */
    public function listCodes(int $now): array
    {
        return array_map(
            static fn (array $r): array => self::code($r),
            $this->db->all('SELECT ' . self::CODE_COLUMNS . ' FROM fd_pairing_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at', [$now]),
        );
    }

    public function deleteCode(string $id): int
    {
        return $this->db->run('DELETE FROM fd_pairing_codes WHERE id = ?', [$id]);
    }

    // ───────── 資料 ─────────

    /**
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    private static function record(array $r, bool $decode): array
    {
        $deleted = (int) $r['deleted'] === 1;
        $text = !$deleted && $r['payload'] !== null ? (string) $r['payload'] : null;
        return [
            'entity' => (string) $r['entity'],
            'id' => (string) $r['id'],
            'seq' => (int) $r['seq'],
            'modifiedAt' => (float) $r['modified_at'],
            'deleted' => $deleted,
            'payload' => $decode && $text !== null ? Json::decodeObject($text) : null,
            'payloadText' => $text,
            'driverUuid' => self::nstr($r['driver_uuid']),
            'driverName' => self::nstr($r['driver_name']),
            'requesterDevice' => self::nstr($r['requester_device']),
            'vehiclePlate' => self::nstr($r['vehicle_plate']),
            'createdBy' => self::nstr($r['created_by']),
            'revision' => (int) ($r['revision'] ?? 0),
        ];
    }

    /** @return array<string, mixed>|null 含墓碑；payload 已解碼 */
    public function getRecord(string $entity, string $id): ?array
    {
        $r = $this->db->first('SELECT ' . self::RECORD_COLUMNS . ' FROM fd_records WHERE entity = ? AND id = ?', [$entity, $id]);
        return $r === null ? null : self::record($r, true);
    }

    /** @return array<string, mixed>|null 只有查詢範圍用的欄位（不解碼 payload） */
    public function getRecordScope(string $entity, string $id): ?array
    {
        $r = $this->db->first('SELECT entity, id, driver_uuid, driver_name, requester_device, created_by FROM fd_records WHERE entity = ? AND id = ?', [$entity, $id]);
        if ($r === null) {
            return null;
        }
        return [
            'entity' => (string) $r['entity'],
            'id' => (string) $r['id'],
            'driverUuid' => self::nstr($r['driver_uuid']),
            'driverName' => self::nstr($r['driver_name']),
            'requesterDevice' => self::nstr($r['requester_device']),
            'createdBy' => self::nstr($r['created_by']),
        ];
    }

    /**
     * 建立或修改（在寫入交易中呼叫；授權與最後寫入者勝已經判斷過）。墓碑會被復原成一般資料。
     * created_by：新建立或復活墓碑時是寫入者的配對身分；修改現存的資料時保留原本的建立者。updated_by 是用戶端的裝置 ID。
     *
     * @param array<string, mixed>|null $existing 主機上現存的版本（含墓碑），在同一個交易中讀取
     * @param array{driverUuid: ?string, driverName: ?string, requesterDevice: ?string, vehiclePlate: ?string} $f
     */
    public function writeRecord(?array $existing, string $entity, string $id, int $seq, int|float $modifiedAt, string $payloadText, array $f, string $identity, string $deviceId, int $now): void
    {
        if ($existing === null) {
            $this->db->run(
                'INSERT INTO fd_records (entity, id, seq, modified_at, deleted, payload, driver_uuid, driver_name, requester_device, vehicle_plate,
                   created_by, updated_by, updated_at, revision)
                 VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
                [$entity, $id, $seq, $modifiedAt, $payloadText, $f['driverUuid'], $f['driverName'], $f['requesterDevice'], $f['vehiclePlate'], $identity, $deviceId, $now],
            );
            return;
        }
        // 在 PHP 決定建立者（不寫成 SQL 的 CASE：MySQL 的 UPDATE 會由左到右套用新值，容易讀到已改過的 deleted）。
        $createdBy = $existing['deleted'] ? $identity : $existing['createdBy'];
        $this->db->run(
            'UPDATE fd_records SET seq = ?, modified_at = ?, deleted = 0, payload = ?, driver_uuid = ?, driver_name = ?, requester_device = ?,
               vehicle_plate = ?, created_by = ?, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE entity = ? AND id = ?',
            [$seq, $modifiedAt, $payloadText, $f['driverUuid'], $f['driverName'], $f['requesterDevice'], $f['vehiclePlate'], $createdBy, $deviceId, $now, $entity, $id],
        );
    }

    /** 改為墓碑（保留查詢欄位；在寫入交易中呼叫）。回傳是否改到。 */
    public function tombstone(string $entity, string $id, int $seq, int|float $at, string $deviceId, int $now): bool
    {
        return $this->db->run(
            'UPDATE fd_records SET deleted = 1, payload = NULL, seq = ?, modified_at = ?, updated_by = ?, updated_at = ?, revision = revision + 1
             WHERE entity = ? AND id = ? AND deleted = 0',
            [$seq, $at, $deviceId, $now, $entity, $id],
        ) > 0;
    }

    /**
     * 車牌相同、還沒刪除的子資料（刪除車輛時連鎖刪除），依種類、UUID 排序（與 TypeScript 版的集合式連鎖刪除取得序號的順序相同）。
     *
     * @param list<string> $entities
     * @return list<array{entity: string, id: string}>
     */
    public function liveChildrenOfPlate(string $plate, array $entities): array
    {
        $marks = implode(', ', array_fill(0, count($entities), '?'));
        $rows = $this->db->all(
            "SELECT entity, id, vehicle_plate FROM fd_records WHERE vehicle_plate = ? AND deleted = 0 AND entity IN ({$marks}) ORDER BY entity, id",
            array_merge([$plate], $entities),
        );
        $out = [];
        foreach ($rows as $r) {
            // MySQL 的字串比較會忽略結尾空白；這裡再逐位元組比對一次，結果與 SQLite（TypeScript 版）一致。
            if ((string) $r['vehicle_plate'] === $plate) {
                $out[] = ['entity' => (string) $r['entity'], 'id' => (string) $r['id']];
            }
        }
        return $out;
    }

    /** 這個車牌還沒回車的車趟數（1.2.0：有進行中車趟的車輛不能刪除）。逐位元組比對車牌（與 TypeScript 版一致）。 */
    public function activeTripsOfPlate(string $plate): int
    {
        $n = 0;
        foreach ($this->db->all("SELECT payload, vehicle_plate FROM fd_records WHERE entity = 'trip' AND deleted = 0 AND vehicle_plate = ?", [$plate]) as $r) {
            if ((string) $r['vehicle_plate'] !== $plate || $r['payload'] === null) {
                continue;
            }
            $p = Json::decodeObject((string) $r['payload']);
            if ($p !== null && ($p->isCompleted ?? null) === false) {
                $n++;
            }
        }
        return $n;
    }

    // ───────── 修改前後歷史（1.2.0） ─────────

    /**
     * 記下一次寫入（在寫入交易中呼叫，與資料一起提交）。
     *
     * @param list<string>|null $changedFields
     */
    public function addHistory(
        int $at, string $entity, string $entityId, ?string $eventId, string $operation, string $source,
        ?string $actorDevice, ?string $actorIdentity, ?string $actorName, ?string $before, ?string $after,
        ?array $changedFields, ?string $reason, int $seq, int $revision, string $outcome = 'applied',
    ): void {
        $this->db->run(
            'INSERT INTO fd_record_history (at, entity, entity_id, event_id, operation, source, actor_device, actor_identity, actor_name,
               before_json, after_json, changed_fields, reason, seq, revision, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$at, $entity, $entityId, $eventId, $operation, $source, $actorDevice, $actorIdentity, $actorName, $before, $after,
             $changedFields === null ? null : Json::encode($changedFields), $reason, $seq, $revision, $outcome],
        );
    }

    /**
     * @param string|null $outcome applied（只有套用的）、notApplied（拒絕、衝突、略過）或 null（全部）
     * @return list<array<string, mixed>> 新到舊
     */
    public function listHistory(?string $entity, ?string $id, ?int $before, int $limit, ?string $outcome = null, ?string $source = null): array
    {
        $where = [];
        $params = [];
        if ($outcome === 'applied') {
            $where[] = "outcome = 'applied'";
        } elseif ($outcome === 'notApplied') {
            $where[] = "outcome != 'applied'";
        }
        if ($source !== null) {
            $where[] = 'source = ?';
            $params[] = $source;
        }
        if ($entity !== null) {
            $where[] = 'entity = ?';
            $params[] = $entity;
        }
        if ($id !== null) {
            $where[] = 'entity_id = ?';
            $params[] = $id;
        }
        if ($before !== null) {
            $where[] = 'id < ?';
            $params[] = $before;
        }
        $params[] = $limit;
        return $this->db->all(
            'SELECT * FROM fd_record_history ' . ($where !== [] ? 'WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY id DESC LIMIT ?',
            $params,
        );
    }

    // ───────── 管理查詢（1.2.0） ─────────

    private const ADMIN_COLUMNS = self::RECORD_COLUMNS . ', updated_by, updated_at';

    /**
     * 某一種類的有效資料（管理查詢用；其他篩選、排序與分頁在 Admin::query）。車牌、姓名在呼叫端再逐位元組比對（MySQL 的比較忽略結尾空白）。
     *
     * @param array{plate?: ?string, driverOwn?: array{uuid: string, name: string}|null, driverName?: ?string, createdBy?: ?string} $f
     * @return list<array<string, mixed>>
     */
    public function adminRows(string $entity, array $f): array
    {
        $where = ['entity = ?', 'deleted = 0'];
        $params = [$entity];
        if (($f['plate'] ?? null) !== null) {
            $where[] = 'vehicle_plate = ?';
            $params[] = $f['plate'];
        }
        if (($f['driverOwn'] ?? null) !== null) {
            $where[] = "(driver_uuid = ? OR (driver_uuid IS NULL AND driver_name = ? AND driver_name != ''))";
            $params[] = $f['driverOwn']['uuid'];
            $params[] = $f['driverOwn']['name'];
        }
        if (($f['driverName'] ?? null) !== null) {
            $where[] = 'driver_name = ?';
            $params[] = $f['driverName'];
        }
        if (($f['createdBy'] ?? null) !== null) {
            $where[] = 'created_by = ?';
            $params[] = $f['createdBy'];
        }
        $rows = $this->db->all('SELECT ' . self::ADMIN_COLUMNS . ' FROM fd_records WHERE ' . implode(' AND ', $where) . ' ORDER BY id', $params);
        $out = [];
        foreach ($rows as $r) {
            if (($f['plate'] ?? null) !== null && (string) $r['vehicle_plate'] !== $f['plate']) {
                continue;
            }
            if (($f['driverName'] ?? null) !== null && (string) $r['driver_name'] !== $f['driverName']) {
                continue;
            }
            if (($f['driverOwn'] ?? null) !== null && $r['driver_uuid'] === null && (string) $r['driver_name'] !== $f['driverOwn']['name']) {
                continue;
            }
            $out[] = $r;
        }
        return $out;
    }

    /** @return array<string, mixed>|null 一筆資料（含墓碑） */
    public function adminRow(string $entity, string $id): ?array
    {
        return $this->db->first('SELECT ' . self::ADMIN_COLUMNS . ' FROM fd_records WHERE entity = ? AND id = ?', [$entity, $id]);
    }

    /**
     * 車牌相同的子資料數（刪除車輛的影響預覽）。
     *
     * @param list<string> $entities
     * @return array<string, int>
     */
    public function childCounts(string $plate, array $entities): array
    {
        $out = array_fill_keys($entities, 0);
        foreach ($this->liveChildrenOfPlate($plate, $entities) as $c) {
            $out[$c['entity']]++;
        }
        return $out;
    }

    /** @return list<array<string, mixed>> 綁定這位駕駛人、還沒解除配對的裝置 */
    public function devicesBoundTo(string $driverUuid): array
    {
        return array_map(
            static fn (array $r): array => self::device($r),
            $this->db->all('SELECT ' . self::DEVICE_COLUMNS . ' FROM fd_devices WHERE driver_uuid = ? AND revoked_at IS NULL ORDER BY paired_at', [$driverUuid]),
        );
    }

    /** @return array<string, mixed>|null */
    public function locationOf(string $tripId): ?array
    {
        return $this->db->first(
            'SELECT trip_id, device_id, device_name, plate, latitude, longitude, speed, course, ts, updated_at FROM fd_locations WHERE trip_id = ?',
            [$tripId],
        );
    }

    // ───────── 已處理的事件（1.2.0，冪等） ─────────

    public function processedResult(string $deviceId, string $eventId): ?string
    {
        $v = $this->db->value('SELECT result_json FROM fd_processed_events WHERE device_id = ? AND event_id = ?', [$deviceId, $eventId]);
        return $v === null ? null : (string) $v;
    }

    /** 記下處理結果；同一個事件已有結果時保留第一次的。 */
    public function recordProcessed(string $deviceId, string $eventId, string $status, ?string $reason, string $resultJson, int $now): void
    {
        $sql = $this->db->driver === 'sqlite'
            ? 'INSERT OR IGNORE INTO fd_processed_events (device_id, event_id, status, reason, result_json, at) VALUES (?, ?, ?, ?, ?, ?)'
            : 'INSERT IGNORE INTO fd_processed_events (device_id, event_id, status, reason, result_json, at) VALUES (?, ?, ?, ?, ?, ?)';
        $this->db->run($sql, [$deviceId, $eventId, $status, $reason, $resultJson, $now]);
    }

    public function purgeProcessed(int $before): void
    {
        $this->db->run('DELETE FROM fd_processed_events WHERE at < ?', [$before]);
    }

    /**
     * 所有未刪除的資料（快照用），依種類、UUID 排序；payload 不解碼（payloadText 是原始 JSON）。
     *
     * @return \Generator<int, array<string, mixed>>
     */
    public function liveRecords(): \Generator
    {
        foreach ($this->db->iterate('SELECT ' . self::RECORD_COLUMNS . ' FROM fd_records WHERE deleted = 0 ORDER BY entity, id') as $r) {
            yield self::record($r, false);
        }
    }

    /** @return list<array<string, mixed>> 序號大於 $seq 的資料（含墓碑），payload 不解碼 */
    public function changesSince(int $seq, int $limit): array
    {
        $rows = $this->db->all('SELECT ' . self::RECORD_COLUMNS . ' FROM fd_records WHERE seq > ? ORDER BY seq LIMIT ?', [$seq, $limit]);
        return array_map(static fn (array $r): array => self::record($r, false), $rows);
    }

    // ───────── 稽核紀錄 ─────────

    public function addAudit(int $at, string $deviceId, string $deviceName, string $entity, string $entityId, string $operation, string $summary): void
    {
        $this->db->run(
            'INSERT INTO fd_audit (at, device_id, device_name, entity, entity_id, operation, summary) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$at, $deviceId, $deviceName, $entity, $entityId, $operation, $summary],
        );
    }

    /** @return list<array<string, mixed>> 新的在前 */
    public function listAudit(?int $before, int $limit): array
    {
        $columns = 'id, at, device_id, device_name, entity, entity_id, operation, summary';
        if ($before === null) {
            return $this->db->all("SELECT {$columns} FROM fd_audit ORDER BY id DESC LIMIT ?", [$limit]);
        }
        return $this->db->all("SELECT {$columns} FROM fd_audit WHERE id < ? ORDER BY id DESC LIMIT ?", [$before, $limit]);
    }

    // ───────── 即時位置 ─────────

    /**
     * 每趟只保留最新的一筆（在寫入交易中呼叫）。
     *
     * @param array{trip_id: string, device_id: string, device_name: string, plate: ?string, latitude: int|float, longitude: int|float, speed: int|float|null, course: int|float|null, ts: int|float, updated_at: int} $row
     */
    public function upsertLocation(array $row): void
    {
        $this->db->run('DELETE FROM fd_locations WHERE trip_id = ?', [$row['trip_id']]);
        $this->db->run(
            'INSERT INTO fd_locations (trip_id, device_id, device_name, plate, latitude, longitude, speed, course, ts, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $row['trip_id'], $row['device_id'], $row['device_name'], $row['plate'],
                (float) $row['latitude'], (float) $row['longitude'],
                $row['speed'] === null ? null : (float) $row['speed'],
                $row['course'] === null ? null : (float) $row['course'],
                (float) $row['ts'], $row['updated_at'],
            ],
        );
    }

    public function deleteLocation(string $tripId): void
    {
        $this->db->run('DELETE FROM fd_locations WHERE trip_id = ?', [$tripId]);
    }

    /** 移除太久沒有更新的位置。 */
    public function purgeLocations(int $freshAfter): void
    {
        $this->db->run('DELETE FROM fd_locations WHERE updated_at < ?', [$freshAfter]);
    }

    /** @return list<array<string, mixed>> 新的在前 */
    public function listLocations(int $freshAfter): array
    {
        return $this->db->all(
            'SELECT trip_id, device_id, device_name, plate, latitude, longitude, speed, course, ts, updated_at FROM fd_locations
             WHERE updated_at >= ? ORDER BY updated_at DESC',
            [$freshAfter],
        );
    }
}
