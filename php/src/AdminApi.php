<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 網頁管理的資料端點（對應 core/src/admin-api.ts；規格 docs/protocol.md §7.2–7.6）。只有管理員。
 * 修改在一個交易中完成（先取得全主機寫入鎖再讀取、檢查、寫入資料、修改前後歷史與稽核紀錄），App 以原本的同步取得。
 */
final class AdminApi
{
    private const MAX_PAYLOAD_LENGTH = 1024 * 1024;
    private const RELATED_LIMIT = 20;
    private const DAY = 86400;

    public function __construct(
        private readonly Repo $repo,
        private readonly Db $db,
        private readonly Session $s,
        private readonly Request $req,
    ) {
    }

    public function schema(): RawJson
    {
        return new RawJson(AdminSpec::JSON);
    }

    private static function entityParam(?string $raw): string
    {
        if (!Rules::isEntity($raw)) {
            throw ApiError::badRequest('entity 不正確');
        }
        return $raw;
    }

    private static function revisionParam(mixed $v): int
    {
        if (!is_int($v) || $v < 0) {
            throw ApiError::badRequest('expectedRevision 必須是非負整數');
        }
        return $v;
    }

    /** @return array<string, string> */
    private function names(): array
    {
        $out = [];
        foreach ($this->repo->listDevices() as $d) {
            $out[$d['device_id']] = $d['name'];
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $f
     * @return list<array{row: array<string, mixed>, payload: \stdClass}>
     */
    private function parsed(string $entity, array $f): array
    {
        $out = [];
        foreach ($this->repo->adminRows($entity, $f) as $row) {
            $p = $row['payload'] === null ? null : Json::decodeObject((string) $row['payload']);
            if ($p !== null) {
                $out[] = ['row' => $row, 'payload' => $p];
            }
        }
        return $out;
    }

    /** @return array{row: array<string, mixed>, payload: \stdClass} */
    private function liveRow(string $entity, string $rawId): array
    {
        $id = Util::normalizeUuid($rawId);
        if ($id === null) {
            throw ApiError::badRequest('id 必須是 UUID');
        }
        $row = $this->repo->adminRow($entity, $id);
        $p = $row !== null && (int) $row['deleted'] === 0 && $row['payload'] !== null ? Json::decodeObject((string) $row['payload']) : null;
        if ($row === null || $p === null) {
            throw new ApiError(404, 'not_found', '找不到這筆資料（可能已被刪除）');
        }
        return ['row' => $row, 'payload' => $p];
    }

    /** @return array{uuid: string, name: string}|null */
    private function driverById(string $id): ?array
    {
        $row = $this->repo->adminRow('driver', $id);
        $p = $row !== null && (int) $row['deleted'] === 0 && $row['payload'] !== null ? Json::decodeObject((string) $row['payload']) : null;
        return $p === null ? null : ['uuid' => $id, 'name' => is_string($p->name ?? null) ? $p->name : ''];
    }

    /** @return array{row: array<string, mixed>, payload: \stdClass}|null */
    private function vehicleByPlate(string $plate): ?array
    {
        foreach ($this->parsed('vehicle', ['plate' => $plate]) as $r) {
            if (($r['payload']->plateNumber ?? null) === $plate) {
                return $r;
            }
        }
        return null;
    }

    /**
     * @param array<string, mixed> $row
     * @param array<string, string> $names
     */
    private static function conflict(array $row, array $names): never
    {
        throw new ApiError(409, 'revision_mismatch', '這筆資料已被其他裝置修改，請重新載入後再修改', null, ['current' => Admin::recordJson($row, $names)]);
    }

    /**
     * @param list<array{row: array<string, mixed>, payload: \stdClass}> $rows
     * @param array<string, string> $names
     * @return array<string, mixed>
     */
    private static function relatedOf(string $entity, array $rows, array $names): array
    {
        $es = Admin::spec($entity);
        $page = Admin::query($entity, $rows, [
            'terms' => [], 'from' => null, 'to' => null, 'status' => null, 'sort' => $es['defaultSort'], 'order' => $es['defaultOrder'],
            'limit' => self::RELATED_LIMIT, 'offset' => 0,
        ]);
        return [
            'entity' => $entity,
            'total' => $page['total'],
            'records' => array_map(static fn (array $p): array => Admin::recordJson($p['row'], $names), $page['page']),
        ];
    }

    /**
     * @param array<string, mixed> $d
     * @return array<string, mixed>
     */
    private static function deviceBrief(array $d): array
    {
        return [
            'deviceId' => $d['device_id'],
            'name' => $d['name'],
            'platform' => $d['platform'],
            'role' => $d['role'],
            'lastSeenAt' => $d['last_seen_at'],
            'revokedAt' => $d['revoked_at'],
        ];
    }

    private function actorName(): string
    {
        return $this->s->deviceName;
    }

    // ───────── 查詢 ─────────

    /** @return array<string, mixed> */
    public function list(): array
    {
        $entity = self::entityParam($this->req->query('entity'));
        $es = Admin::spec($entity);
        $q = $this->req->query('q');
        if ($q !== null && Util::cpLength($q) > 100) {
            throw ApiError::badRequest('q 最多 100 個字');
        }
        $status = $this->req->query('status');
        if ($status !== null && $status !== '' && !array_key_exists($status, $es['statuses'])) {
            throw ApiError::badRequest('status 不正確');
        }
        $sort = $this->req->query('sort');
        $sort = $sort === null || $sort === '' ? $es['defaultSort'] : $sort;
        if (!array_key_exists($sort, $es['sorts'])) {
            throw ApiError::badRequest('sort 不正確');
        }
        $order = $this->req->query('order');
        if ($order !== null && $order !== '' && $order !== 'asc' && $order !== 'desc') {
            throw ApiError::badRequest('order 必須是 asc 或 desc');
        }
        $time = function (string $key): int|float|null {
            $raw = $this->req->query($key);
            if ($raw === null || $raw === '') {
                return null;
            }
            return Util::intParam($this->req, $key, 0, 0, Util::MAX_SAFE_INTEGER) / 1000 - 978307200;
        };
        $params = [
            'terms' => Admin::searchTerms($q),
            'from' => $time('from'),
            'to' => $time('to'),
            'status' => $status === null || $status === '' ? null : $status,
            'sort' => $sort,
            'order' => $order === 'asc' || $order === 'desc' ? $order : $es['defaultOrder'],
            'limit' => Util::intParam($this->req, 'limit', 50, 1, 200),
            'offset' => Util::intParam($this->req, 'offset', 0, 0, 1000000),
        ];

        $filter = [];
        $plate = $this->req->query('plate');
        if ($plate !== null && $plate !== '') {
            $filter['plate'] = $plate;
        }
        $requester = null;
        $driverRaw = $this->req->query('driverId');
        if ($driverRaw !== null && $driverRaw !== '') {
            $id = Util::normalizeUuid($driverRaw);
            if ($id === null) {
                throw ApiError::badRequest('driverId 必須是 UUID');
            }
            $d = $this->driverById($id);
            if ($d === null) {
                throw new ApiError(404, 'not_found', '找不到這位駕駛人');
            }
            if ($entity === 'trip') {
                $filter['driverOwn'] = $d;
            } elseif ($entity === 'inspection') {
                $filter['driverName'] = $d['name'] === '' ? "\0" : $d['name'];
            } elseif ($entity === 'tripRequest') {
                $requester = $d['name'];
            } else {
                throw ApiError::badRequest('driverId 只能用於車趟、巡檢與用車申請');
            }
        }
        $deviceRaw = $this->req->query('deviceId');
        if ($deviceRaw !== null && $deviceRaw !== '') {
            $id = Util::normalizeUuid($deviceRaw);
            if ($id === null) {
                throw ApiError::badRequest('deviceId 必須是 UUID');
            }
            $d = $this->repo->deviceById($id);
            if ($d === null) {
                throw new ApiError(404, 'not_found', '找不到這台裝置');
            }
            $filter['createdBy'] = $d['identity'] ?? "\0";
        }
        $rows = $this->parsed($entity, $filter);
        if ($requester !== null) {
            $rows = array_values(array_filter($rows, static fn (array $r): bool => $requester !== '' && ($r['payload']->requestedBy ?? null) === $requester));
        }
        $result = Admin::query($entity, $rows, $params);
        $names = $this->names();
        return [
            'entity' => $entity,
            'total' => $result['total'],
            'offset' => $params['offset'],
            'limit' => $params['limit'],
            'records' => array_map(static fn (array $r): array => Admin::recordJson($r['row'], $names), $result['page']),
        ];
    }

    /** @return array<string, mixed> */
    public function detail(string $entityRaw, string $rawId): array
    {
        $entity = self::entityParam($entityRaw);
        $id = Util::normalizeUuid($rawId);
        if ($id === null) {
            throw ApiError::badRequest('id 必須是 UUID');
        }
        $row = $this->repo->adminRow($entity, $id);
        if ($row === null) {
            throw new ApiError(404, 'not_found', '找不到這筆資料');
        }
        $names = $this->names();
        $record = Admin::recordJson($row, $names);
        $related = [];
        $location = null;
        $p = (int) $row['deleted'] === 0 && $row['payload'] !== null ? Json::decodeObject((string) $row['payload']) : null;
        if ($p !== null) {
            $related = $this->related($entity, $id, $p, $names);
            if ($entity === 'trip') {
                $l = $this->repo->locationOf($id);
                if ($l !== null) {
                    $location = [
                        'latitude' => (float) $l['latitude'], 'longitude' => (float) $l['longitude'],
                        'speed' => $l['speed'] === null ? null : (float) $l['speed'], 'course' => $l['course'] === null ? null : (float) $l['course'],
                        'timestamp' => (float) $l['ts'], 'deviceName' => (string) $l['device_name'],
                        'stale' => Util::nowMs() - (int) $l['updated_at'] > 300 * 1000,
                    ];
                }
            }
        }
        return ['record' => $record, 'related' => (object) $related, 'location' => $location];
    }

    /**
     * @param array<string, string> $names
     * @return array<string, mixed>
     */
    private function related(string $entity, string $id, \stdClass $p, array $names): array
    {
        $out = [];
        $plateOf = static fn (mixed $v): ?string => is_string($v) && $v !== '' ? $v : null;
        $byPlate = fn (string $e, string $plate): array => $this->parsed($e, ['plate' => $plate]);
        $vehicles = function (?string $plate) use ($names): array {
            $v = $plate === null ? null : $this->vehicleByPlate($plate);
            return self::relatedOf('vehicle', $v === null ? [] : [$v], $names);
        };
        $nowApple = Util::msToApple(Util::nowMs());
        switch ($entity) {
            case 'vehicle':
                $plate = $plateOf($p->plateNumber ?? null);
                if ($plate === null) {
                    break;
                }
                $out['trips'] = self::relatedOf('trip', $byPlate('trip', $plate), $names);
                $out['maintenance'] = self::relatedOf('maintenance', $byPlate('maintenance', $plate), $names);
                $out['maintenanceItems'] = self::relatedOf('maintenanceItem', $byPlate('maintenanceItem', $plate), $names);
                $out['workOrders'] = self::relatedOf('workOrder', $byPlate('workOrder', $plate), $names);
                $out['inspections'] = self::relatedOf('inspection', $byPlate('inspection', $plate), $names);
                $out['tripRequests'] = self::relatedOf('tripRequest', array_values(array_filter($this->parsed('tripRequest', []),
                    static fn (array $r): bool => ($r['payload']->vehiclePlateNumber ?? null) === $plate)), $names);
                break;
            case 'driver':
                $name = is_string($p->name ?? null) ? $p->name : '';
                $out['trips'] = self::relatedOf('trip', $this->parsed('trip', ['driverOwn' => ['uuid' => $id, 'name' => $name]]), $names);
                $out['inspections'] = self::relatedOf('inspection', $name === '' ? [] : $this->parsed('inspection', ['driverName' => $name]), $names);
                $out['tripRequests'] = self::relatedOf('tripRequest', $name === '' ? [] : array_values(array_filter($this->parsed('tripRequest', []),
                    static fn (array $r): bool => ($r['payload']->requestedBy ?? null) === $name)), $names);
                $out['devices'] = array_map(static fn (array $d): array => self::deviceBrief($d), $this->repo->devicesBoundTo($id));
                break;
            case 'trip':
                $plate = $plateOf($p->vehiclePlateNumber ?? null);
                $start = Admin::finite($p->startTime ?? null);
                $end = ($p->isCompleted ?? null) === true ? Admin::finite($p->endTime ?? null) : $nowApple;
                if ($plate !== null) {
                    $out['vehicles'] = $vehicles($plate);
                    if ($start !== null && $end !== null) {
                        $lo = $start - self::DAY;
                        $hi = max($start, $end) + self::DAY;
                        $out['inspections'] = self::relatedOf('inspection', array_values(array_filter($byPlate('inspection', $plate), static function (array $r) use ($lo, $hi): bool {
                            $t = Admin::finite($r['payload']->date ?? null);
                            return $t !== null && $t >= $lo && $t <= $hi;
                        })), $names);
                        $out['workOrders'] = self::relatedOf('workOrder', array_values(array_filter($byPlate('workOrder', $plate), static function (array $r) use ($lo, $hi): bool {
                            $opened = Admin::finite($r['payload']->openedAt ?? null);
                            $closed = Admin::finite($r['payload']->closedAt ?? null);
                            return $opened !== null && $opened <= $hi && ($closed === null || $closed >= $lo);
                        })), $names);
                    }
                }
                $driverId = is_string($p->driverEntityUUID ?? null) ? Util::normalizeUuid($p->driverEntityUUID) : null;
                $drivers = [];
                if ($driverId !== null) {
                    $row = $this->repo->adminRow('driver', $driverId);
                    $dp = $row !== null && (int) $row['deleted'] === 0 && $row['payload'] !== null ? Json::decodeObject((string) $row['payload']) : null;
                    if ($dp !== null) {
                        $drivers[] = ['row' => $row, 'payload' => $dp];
                    }
                } elseif (is_string($p->driver ?? null) && $p->driver !== '') {
                    $want = $p->driver;
                    $drivers = array_values(array_filter($this->parsed('driver', []), static fn (array $r): bool => ($r['payload']->name ?? null) === $want));
                }
                $out['drivers'] = self::relatedOf('driver', $drivers, $names);
                $out['tripRequests'] = self::relatedOf('tripRequest', array_values(array_filter($this->parsed('tripRequest', []),
                    static fn (array $r): bool => is_string($r['payload']->resultingTripUUID ?? null) && strtoupper($r['payload']->resultingTripUUID) === $id)), $names);
                break;
            case 'tripRequest':
                $tripId = is_string($p->resultingTripUUID ?? null) ? Util::normalizeUuid($p->resultingTripUUID) : null;
                $trips = [];
                if ($tripId !== null) {
                    $row = $this->repo->adminRow('trip', $tripId);
                    $tp = $row !== null && (int) $row['deleted'] === 0 && $row['payload'] !== null ? Json::decodeObject((string) $row['payload']) : null;
                    if ($tp !== null) {
                        $trips[] = ['row' => $row, 'payload' => $tp];
                    }
                }
                $out['trips'] = self::relatedOf('trip', $trips, $names);
                $out['vehicles'] = $vehicles($plateOf($p->vehiclePlateNumber ?? null));
                $deviceId = is_string($p->requestedByDeviceID ?? null) ? Util::normalizeUuid($p->requestedByDeviceID) : null;
                $d = $deviceId === null ? null : $this->repo->deviceById($deviceId);
                $out['devices'] = $d === null ? [] : [self::deviceBrief($d)];
                break;
            case 'workOrder':
                $out['vehicles'] = $vehicles($plateOf($p->vehiclePlateNumber ?? null));
                $ids = [];
                foreach (is_array($p->lines ?? null) ? $p->lines : [] as $l) {
                    if ($l instanceof \stdClass && is_string($l->partEntityUUID ?? null)) {
                        $ids[strtoupper($l->partEntityUUID)] = true;
                    }
                }
                $out['parts'] = self::relatedOf('part', array_values(array_filter($this->parsed('part', []),
                    static fn (array $r): bool => isset($ids[(string) $r['row']['id']]))), $names);
                break;
            case 'part':
                $out['workOrders'] = self::relatedOf('workOrder', array_values(array_filter($this->parsed('workOrder', []),
                    static fn (array $r): bool => self::referencesPart($r['payload'], $id))), $names);
                break;
            case 'inspection':
                $plate = $plateOf($p->vehiclePlateNumber ?? null);
                $out['vehicles'] = $vehicles($plate);
                $name = is_string($p->driverName ?? null) ? $p->driverName : '';
                $out['drivers'] = self::relatedOf('driver', $name === '' ? [] : array_values(array_filter($this->parsed('driver', []),
                    static fn (array $r): bool => ($r['payload']->name ?? null) === $name)), $names);
                $date = Admin::finite($p->date ?? null);
                $out['trips'] = self::relatedOf('trip', $plate !== null && $date !== null ? array_values(array_filter($byPlate('trip', $plate), static function (array $r) use ($date): bool {
                    $t = Admin::finite($r['payload']->startTime ?? null);
                    return $t !== null && $t >= $date - self::DAY && $t <= $date + self::DAY;
                })) : [], $names);
                break;
            case 'maintenance':
            case 'maintenanceItem':
                $out['vehicles'] = $vehicles($plateOf($p->vehiclePlateNumber ?? null));
                break;
            default:
                break;
        }
        return $out;
    }

    private static function referencesPart(\stdClass $workOrder, string $partId): bool
    {
        foreach (is_array($workOrder->lines ?? null) ? $workOrder->lines : [] as $l) {
            if ($l instanceof \stdClass && is_string($l->partEntityUUID ?? null) && strtoupper($l->partEntityUUID) === $partId) {
                return true;
            }
        }
        return false;
    }

    // ───────── 受控編輯 ─────────

    /** @return array<string, mixed> */
    public function edit(string $entityRaw, string $rawId, \stdClass $body): array
    {
        $entity = self::entityParam($entityRaw);
        if ($entity === 'tripRequest') {
            throw ApiError::badRequest('用車申請請用核准或退回');
        }
        $expected = self::revisionParam($body->expectedRevision ?? null);
        $dryRun = ($body->dryRun ?? null) === true;
        $reason = Admin::cleanReason($body->reason ?? null);
        if (!$dryRun && $reason === null) {
            throw ApiError::badRequest('reason（修改原因）必須是 1–500 個字');
        }
        $names = $this->names();
        $changes = $body->changes ?? null;
        return $this->db->transaction(function () use ($entity, $rawId, $expected, $dryRun, $reason, $names, $changes): array {
            ['row' => $row, 'payload' => $payload] = $this->liveRow($entity, $rawId);
            if ((int) $row['revision'] !== $expected) {
                self::conflict($row, $names);
            }
            $now = Util::nowMs();
            $modifiedAt = max(Util::msToApple($now), (float) $row['modified_at'] + 0.001);
            $r = Admin::applyChanges($entity, $payload, $changes, $modifiedAt);
            $errors = $r['errors'];
            if ($errors === [] && $r['plate'] !== null && $this->vehicleByPlate($r['plate']) === null) {
                $errors['vehiclePlateNumber'] = '找不到這個車牌的車輛';
            }
            if ($errors === [] && $r['driverId'] !== null) {
                $d = $this->driverById($r['driverId']);
                if ($d === null) {
                    $errors['driverEntityUUID'] = '找不到這位駕駛人';
                } else {
                    $r['after']->driver = $d['name'];
                }
            }
            if ($errors !== []) {
                throw new ApiError(400, 'invalid_changes', '修改的內容不正確', null, ['fields' => (object) $errors]);
            }
            $after = $r['after'];
            $changed = Admin::changedFields($payload, $after);
            if ($dryRun) {
                return [
                    'dryRun' => true, 'revision' => (int) $row['revision'], 'before' => new RawJson((string) $row['payload']), 'after' => $after,
                    'changedFields' => $changed, 'warnings' => $r['warnings'],
                ];
            }
            $text = Json::encode($after);
            if (Util::utf16Length($text) > self::MAX_PAYLOAD_LENGTH) {
                throw new ApiError(413, 'payload_too_large', '內容超過 1 MB');
            }
            $existing = $this->repo->getRecord($entity, (string) $row['id']);
            $seq = $this->db->nextSeq();
            $this->repo->writeRecord($existing, $entity, (string) $row['id'], $seq, $modifiedAt, $text, Rules::scopeFields($entity, $after),
                $this->s->identity, $this->s->deviceId, $now);
            $this->repo->addHistory($now, $entity, (string) $row['id'], null, 'update', 'web', $this->s->deviceId, $this->s->identity, $this->actorName(),
                (string) $row['payload'], $text, $changed, $reason, $seq, (int) $row['revision'] + 1);
            $this->repo->addAudit($now, $this->s->deviceId, $this->actorName(), $entity, (string) $row['id'], 'update', Admin::auditSummary($entity, $text));
            if ($entity === 'trip' && ($after->isCompleted ?? null) === true && ($payload->isCompleted ?? null) !== true) {
                $this->repo->deleteLocation((string) $row['id']);
            }
            $fresh = $this->repo->adminRow($entity, (string) $row['id']);
            return ['record' => Admin::recordJson($fresh ?? $row, $names), 'changedFields' => $changed, 'warnings' => $r['warnings']];
        });
    }

    // ───────── 刪除 ─────────

    /** @return array<string, mixed> */
    public function impact(string $entityRaw, string $rawId): array
    {
        $entity = self::entityParam($entityRaw);
        ['row' => $row, 'payload' => $payload] = $this->liveRow($entity, $rawId);
        $blockers = [];
        $cascade = [];
        $references = [];
        $id = (string) $row['id'];
        if ($entity === 'vehicle') {
            $plate = is_string($payload->plateNumber ?? null) && $payload->plateNumber !== '' ? $payload->plateNumber : null;
            if ($plate !== null && (string) $row['vehicle_plate'] === $plate) {
                $cascade = $this->repo->childCounts($plate, Rules::VEHICLE_CHILDREN);
                $active = $this->repo->activeTripsOfPlate($plate);
                if ($active > 0) {
                    $blockers[] = ['code' => 'vehicle-has-active-trips', 'message' => '這台車還有出車中的車趟，請先回車', 'count' => $active];
                }
            }
        } elseif ($entity === 'driver') {
            $name = is_string($payload->name ?? null) ? $payload->name : '';
            $references['trips'] = count($this->repo->adminRows('trip', ['driverOwn' => ['uuid' => $id, 'name' => $name]]));
            $references['devices'] = count($this->repo->devicesBoundTo($id));
        } elseif ($entity === 'part') {
            $references['workOrders'] = count(array_filter($this->parsed('workOrder', []), static fn (array $r): bool => self::referencesPart($r['payload'], $id)));
        }
        return [
            'entity' => $entity, 'id' => $id, 'revision' => (int) $row['revision'], 'blockers' => $blockers,
            'cascade' => (object) $cascade, 'references' => (object) $references,
        ];
    }

    /** @return array<string, mixed> */
    public function remove(string $entityRaw, string $rawId, \stdClass $body): array
    {
        $entity = self::entityParam($entityRaw);
        $expected = self::revisionParam($body->expectedRevision ?? null);
        $reason = Admin::cleanReason($body->reason ?? null);
        if ($reason === null) {
            throw ApiError::badRequest('reason（刪除原因）必須是 1–500 個字');
        }
        $names = $this->names();
        $expectedCascade = $body->expectedCascade ?? null;
        return $this->db->transaction(function () use ($entity, $rawId, $expected, $reason, $names, $expectedCascade): array {
            ['row' => $row, 'payload' => $payload] = $this->liveRow($entity, $rawId);
            if ((int) $row['revision'] !== $expected) {
                self::conflict($row, $names);
            }
            $id = (string) $row['id'];
            $now = Util::nowMs();
            $at = max(Util::msToApple($now), (float) $row['modified_at'] + 0.001);
            $counts = [];
            $plate = null;
            if ($entity === 'vehicle') {
                $p = is_string($payload->plateNumber ?? null) && $payload->plateNumber !== '' ? $payload->plateNumber : null;
                if ($p !== null && (string) $row['vehicle_plate'] === $p) {
                    $plate = $p;
                    if ($this->repo->activeTripsOfPlate($plate) > 0) {
                        throw new ApiError(409, 'vehicle_has_active_trips', '這台車還有出車中的車趟，請先回車再刪除');
                    }
                    $counts = $this->repo->childCounts($plate, Rules::VEHICLE_CHILDREN);
                    if (!$expectedCascade instanceof \stdClass) {
                        throw ApiError::badRequest('請先預覽刪除的影響範圍（expectedCascade）');
                    }
                    foreach (Rules::VEHICLE_CHILDREN as $e) {
                        if (($expectedCascade->{$e} ?? null) !== $counts[$e]) {
                            throw new ApiError(409, 'impact_changed', '刪除的影響範圍已經改變，請重新預覽', null, ['cascade' => (object) $counts]);
                        }
                    }
                }
            }
            $seq = $this->db->nextSeq();
            $this->repo->tombstone($entity, $id, $seq, $at, $this->s->deviceId, $now);
            $this->repo->addHistory($now, $entity, $id, null, 'delete', 'web', $this->s->deviceId, $this->s->identity, $this->actorName(),
                (string) $row['payload'], null, null, $reason, $seq, (int) $row['revision'] + 1);
            $this->repo->addAudit($now, $this->s->deviceId, $this->actorName(), $entity, $id, 'delete', '');
            if ($entity === 'trip') {
                $this->repo->deleteLocation($id);
            }
            if ($plate !== null) {
                foreach ($this->repo->liveChildrenOfPlate($plate, Rules::VEHICLE_CHILDREN) as $child) {
                    $before = $this->repo->getRecord($child['entity'], $child['id']);
                    $cseq = $this->db->nextSeq();
                    if ($this->repo->tombstone($child['entity'], $child['id'], $cseq, $at, $this->s->deviceId, $now)) {
                        $this->repo->addHistory($now, $child['entity'], $child['id'], null, 'delete', 'cascade', $this->s->deviceId, $this->s->identity,
                            $this->actorName(), $before['payloadText'] ?? null, null, null, 'vehicle-deleted', $cseq, ($before['revision'] ?? 0) + 1);
                        $this->repo->addAudit($now, $this->s->deviceId, $this->actorName(), $child['entity'], $child['id'], 'delete', '');
                        if ($child['entity'] === 'trip') {
                            $this->repo->deleteLocation($child['id']);
                        }
                    }
                }
            }
            return ['deleted' => ['entity' => $entity, 'id' => $id, 'revision' => (int) $row['revision'] + 1], 'cascade' => (object) $counts];
        });
    }

    // ───────── 報表（docs/reports.md） ─────────

    /** @return array{from: int, to: int, tz: string, plate: ?string, driver: ?string, costCenter: ?string} */
    private function reportFilter(): array
    {
        $fromRaw = $this->req->query('from');
        $toRaw = $this->req->query('to');
        if ($fromRaw === null || $fromRaw === '' || $toRaw === null || $toRaw === '') {
            throw ApiError::badRequest('需要 from 與 to（1970 起算的毫秒）');
        }
        $from = Util::intParam($this->req, 'from', 0, 0, Util::MAX_SAFE_INTEGER);
        $to = Util::intParam($this->req, 'to', 0, 0, Util::MAX_SAFE_INTEGER);
        if ($to <= $from) {
            throw ApiError::badRequest('to 必須晚於 from');
        }
        if ($to - $from > 400 * 86400 * 1000) {
            throw ApiError::badRequest('期間最多 400 天');
        }
        $tz = $this->req->query('tz');
        $tz = $tz === null || $tz === '' ? 'UTC' : $tz;
        if (!Reports::validTimeZone($tz)) {
            throw ApiError::badRequest('tz 必須是時區名稱（例如 Asia/Taipei）');
        }
        $plate = $this->req->query('plate');
        $driver = $this->req->query('driver');
        $driverRaw = $this->req->query('driverId');
        if ($driverRaw !== null && $driverRaw !== '') {
            $id = Util::normalizeUuid($driverRaw);
            if ($id === null) {
                throw ApiError::badRequest('driverId 必須是 UUID');
            }
            $d = $this->driverById($id);
            if ($d === null) {
                throw new ApiError(404, 'not_found', '找不到這位駕駛人');
            }
            $driver = $d['name'];
        }
        return [
            'from' => $from, 'to' => $to, 'tz' => $tz,
            'plate' => $plate === null || $plate === '' ? null : $plate,
            'driver' => $driver === null || $driver === '' ? null : $driver,
            'costCenter' => $this->req->query('costCenter'),
        ];
    }

    /** @return array<string, mixed> */
    private function reportInput(): array
    {
        $rows = function (string $entity): array {
            $out = [];
            foreach ($this->repo->adminRows($entity, []) as $r) {
                $p = $r['payload'] === null ? null : Json::decodeObject((string) $r['payload']);
                if ($p !== null) {
                    $out[] = $p;
                }
            }
            return $out;
        };
        $drivers = [];
        foreach ($this->repo->adminRows('driver', []) as $r) {
            $p = $r['payload'] === null ? null : Json::decodeObject((string) $r['payload']);
            if ($p !== null) {
                $drivers[] = ['id' => (string) $r['id'], 'payload' => $p];
            }
        }
        return [
            'trips' => $rows('trip'), 'vehicles' => $rows('vehicle'), 'drivers' => $drivers, 'maintenance' => $rows('maintenance'),
            'workOrders' => $rows('workOrder'), 'inspections' => $rows('inspection'), 'now' => Util::nowMs(),
        ];
    }

    /** @return array<string, mixed> */
    public function reportSummary(): array
    {
        $f = $this->reportFilter();
        return Reports::summary($this->reportInput(), $f);
    }

    /** CSV 匯出（text/csv；檔名同時給 ASCII 版本與 RFC 5987 的 UTF-8 版本）。 */
    public function reportExport(): Response
    {
        $kind = $this->req->query('kind');
        if (!in_array($kind, Reports::EXPORT_KINDS, true)) {
            throw ApiError::badRequest('kind 必須是 trips、maintenance、workOrders 或 inspections');
        }
        $f = $this->reportFilter();
        $body = Reports::exportCsv($kind, $this->reportInput(), $f);
        $filename = 'FleetDispatch_' . $kind . '_' . Reports::localDate($f['from'], $f['tz']) . '_' . Reports::localDate($f['to'] - 1, $f['tz'])
            . ($f['plate'] !== null ? '_' . $f['plate'] : '') . '.csv';
        $ascii = preg_replace('/[^A-Za-z0-9._-]/', '_', $filename) ?? 'export.csv';
        return Response::raw(200, $body, [
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => 'attachment; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($filename),
            'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    // ───────── 用車申請的簽核 ─────────

    /** @return array<string, mixed> */
    public function decide(string $rawId, string $action, \stdClass $body): array
    {
        $expected = self::revisionParam($body->expectedRevision ?? null);
        $names = $this->names();
        $rejection = null;
        $note = null;
        if ($action === 'reject') {
            $rejection = Admin::cleanReason($body->rejectionReason ?? null);
            if ($rejection === null) {
                throw ApiError::badRequest('rejectionReason（退回原因）必須是 1–500 個字');
            }
        } elseif (isset($body->note) && $body->note !== '') {
            $note = Admin::cleanReason($body->note);
            if ($note === null) {
                throw ApiError::badRequest('note 最多 500 個字');
            }
        }
        $driver = null;
        if ($action === 'approve' && isset($body->driverId) && $body->driverId !== '') {
            $id = Util::normalizeUuid($body->driverId);
            if ($id === null) {
                throw ApiError::badRequest('driverId 必須是 UUID');
            }
            $driver = $this->driverById($id);
            if ($driver === null) {
                throw ApiError::badRequest('找不到這位駕駛人');
            }
        }
        return $this->db->transaction(function () use ($rawId, $action, $expected, $names, $rejection, $note, $driver): array {
            ['row' => $row, 'payload' => $payload] = $this->liveRow('tripRequest', $rawId);
            if ((int) $row['revision'] !== $expected) {
                self::conflict($row, $names);
            }
            if (($payload->status ?? null) !== 'pending') {
                throw new ApiError(409, 'request_not_pending', '這筆申請已經處理過了');
            }
            $id = (string) $row['id'];
            $now = Util::nowMs();
            $at = max(Util::msToApple($now), (float) $row['modified_at'] + 0.001);
            $updated = clone $payload;
            $updated->status = $action === 'approve' ? 'approved' : 'rejected';
            $updated->approvedAt = $at;
            $updated->approvedBy = $this->actorName();
            if ($rejection !== null) {
                $updated->rejectionReason = $rejection;
            }
            $tripId = null;
            if ($action === 'approve') {
                $plateRaw = is_string($payload->vehiclePlateNumber ?? null) && $payload->vehiclePlateNumber !== '' ? $payload->vehiclePlateNumber : null;
                $plate = $plateRaw !== null && $this->vehicleByPlate($plateRaw) !== null ? $plateRaw : null;
                $odometerStart = 0;
                if ($plate !== null) {
                    $best = null;
                    foreach ($this->parsed('trip', ['plate' => $plate]) as $t) {
                        if (($t['payload']->isCompleted ?? null) !== true) {
                            continue;
                        }
                        $end = Admin::finite($t['payload']->endTime ?? null);
                        $odo = Admin::finite($t['payload']->odometerEnd ?? null);
                        if ($end !== null && $odo !== null && ($best === null || $end > $best)) {
                            $best = $end;
                            $odometerStart = $odo;
                        }
                    }
                }
                $tripId = Crypto::uuid4();
                $updated->resultingTripUUID = $tripId;
                $trip = Admin::tripFromRequest($payload, $tripId, $plate, $odometerStart, $driver, $at);
                $tripText = Json::encode($trip);
                $tseq = $this->db->nextSeq();
                $this->repo->writeRecord(null, 'trip', $tripId, $tseq, $at, $tripText, Rules::scopeFields('trip', $trip), $this->s->identity, $this->s->deviceId, $now);
                $this->repo->addHistory($now, 'trip', $tripId, null, 'create', 'web', $this->s->deviceId, $this->s->identity, $this->actorName(),
                    null, $tripText, Admin::changedFields(null, $trip), $note ?? '核准用車申請', $tseq, 1);
                $this->repo->addAudit($now, $this->s->deviceId, $this->actorName(), 'trip', $tripId, 'create', Admin::auditSummary('trip', $tripText));
            }
            $updated->lastModifiedAt = $at;
            $text = Json::encode($updated);
            $existing = $this->repo->getRecord('tripRequest', $id);
            $seq = $this->db->nextSeq();
            $this->repo->writeRecord($existing, 'tripRequest', $id, $seq, $at, $text, Rules::scopeFields('tripRequest', $updated), $this->s->identity, $this->s->deviceId, $now);
            $this->repo->addHistory($now, 'tripRequest', $id, null, 'update', 'web', $this->s->deviceId, $this->s->identity, $this->actorName(),
                (string) $row['payload'], $text, Admin::changedFields($payload, $updated), $action === 'approve' ? ($note ?? '核准用車申請') : $rejection,
                $seq, (int) $row['revision'] + 1);
            $this->repo->addAudit($now, $this->s->deviceId, $this->actorName(), 'tripRequest', $id, 'update', Admin::auditSummary('tripRequest', $text));
            $request = $this->repo->adminRow('tripRequest', $id);
            $trip = $tripId === null ? null : $this->repo->adminRow('trip', $tripId);
            return [
                'request' => Admin::recordJson($request ?? $row, $names),
                'trip' => $trip === null ? null : Admin::recordJson($trip, $names),
            ];
        });
    }
}
