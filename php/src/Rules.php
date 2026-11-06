<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 寫入授權、讀取範圍與遮蔽（docs/protocol.md §2、§5；對應 core/src/rules.ts）。純函式，不存取資料庫。
 *
 * 「記錄」（record）是 Repo 回傳的關聯陣列：
 * entity、id、seq、modifiedAt、deleted、payload（stdClass|null）、payloadText、driverUuid、driverName、requesterDevice、vehiclePlate、
 * createdBy（建立這筆資料的配對身分，見 Session::$identity）。
 */
final class Rules
{
    public const ENTITIES = [
        'trip', 'vehicle', 'driver', 'maintenance', 'maintenanceItem', 'preset', 'tripRequest', 'part', 'workOrder', 'inspection',
    ];

    public const ROLES = ['admin', 'driver', 'viewer'];

    public const OPERATIONS = ['create', 'update', 'delete'];

    /** 快照中各種類的陣列名稱。 */
    public const SNAPSHOT_KEYS = [
        'trip' => 'trips',
        'vehicle' => 'vehicles',
        'driver' => 'drivers',
        'maintenance' => 'maintenanceRecords',
        'maintenanceItem' => 'maintenanceItems',
        'preset' => 'presets',
        'tripRequest' => 'tripRequests',
        'part' => 'parts',
        'workOrder' => 'workOrders',
        'inspection' => 'inspections',
    ];

    /** 刪除車輛時一併刪除的種類（依車牌）。 */
    public const VEHICLE_CHILDREN = ['trip', 'maintenance', 'maintenanceItem', 'workOrder', 'inspection'];

    public static function isEntity(mixed $v): bool
    {
        return is_string($v) && in_array($v, self::ENTITIES, true);
    }

    public static function isOperation(mixed $v): bool
    {
        return is_string($v) && in_array($v, self::OPERATIONS, true);
    }

    public static function isRole(mixed $v): bool
    {
        return is_string($v) && in_array($v, self::ROLES, true);
    }

    /** 字串轉大寫；不是字串或是空字串時回傳 null。 */
    private static function upperOrNull(mixed $v): ?string
    {
        return is_string($v) && $v !== '' ? Util::upper($v) : null;
    }

    /**
     * 從資料內容取出查詢欄位（車牌、駕駛人、申請裝置）。
     *
     * @return array{driverUuid: ?string, driverName: ?string, requesterDevice: ?string, vehiclePlate: ?string}
     */
    public static function scopeFields(string $entity, \stdClass $payload): array
    {
        $out = ['driverUuid' => null, 'driverName' => null, 'requesterDevice' => null, 'vehiclePlate' => null];
        switch ($entity) {
            case 'trip':
                $out['driverUuid'] = self::upperOrNull($payload->driverEntityUUID ?? null);
                $out['driverName'] = Util::str($payload->driver ?? null);
                $out['vehiclePlate'] = Util::str($payload->vehiclePlateNumber ?? null);
                break;
            case 'inspection':
                $out['driverName'] = Util::str($payload->driverName ?? null);
                $out['vehiclePlate'] = Util::str($payload->vehiclePlateNumber ?? null);
                break;
            case 'tripRequest':
                $out['requesterDevice'] = self::upperOrNull($payload->requestedByDeviceID ?? null);
                break;
            case 'maintenance':
            case 'maintenanceItem':
            case 'workOrder':
                $out['vehiclePlate'] = Util::str($payload->vehiclePlateNumber ?? null);
                break;
            case 'vehicle':
                $out['vehiclePlate'] = Util::str($payload->plateNumber ?? null);
                break;
        }
        return $out;
    }

    /**
     * 「自己的車趟」：有駕駛人 UUID 時比對綁定的 UUID，沒有時比對姓名（非空字串）。
     *
     * @param array{driverUuid: string, driverName: string}|null $binding
     */
    public static function isOwnTrip(?string $driverUuid, ?string $driverName, ?array $binding): bool
    {
        if ($binding === null) {
            return false;
        }
        if ($driverUuid !== null && $driverUuid !== '') {
            return $driverUuid === Util::upper($binding['driverUuid']);
        }
        return $binding['driverName'] !== '' && $driverName === $binding['driverName'];
    }

    private static function blank(\stdClass $p, string $key): bool
    {
        return !isset($p->{$key}) || $p->{$key} === '';
    }

    /** 沒有核准相關的欄位（approvedAt 沒有；approvedBy、rejectionReason、resultingTripUUID 沒有或是空字串）。 */
    private static function hasNoDecision(\stdClass $p): bool
    {
        return !isset($p->approvedAt)
            && self::blank($p, 'approvedBy')
            && self::blank($p, 'rejectionReason')
            && self::blank($p, 'resultingTripUUID');
    }

    /**
     * 一筆事件的寫入授權。`$existing` 是主機上現存的版本（含墓碑：駕駛不能藉由重新建立復活別人的資料）。
     *
     * @param array<string, mixed>|null $existing
     * @return string|null null 表示允許；字串是拒絕原因
     */
    public static function authorize(Session $s, string $entity, string $op, ?\stdClass $incoming, ?array $existing): ?string
    {
        $live = $existing !== null && !$existing['deleted'] ? $existing : null;
        if ($s->role === 'admin') {
            return null;
        }
        if ($s->role === 'viewer') {
            return 'role';
        }

        // 以下是駕駛。主機的寫入是「有就更新、沒有就建立」：主機上已有這筆（含墓碑，保留查詢欄位與建立者）時，
        // 不論事件標示 create 或 update，一律依修改的規則檢查（不能用 create 覆寫或復活別人的資料）。
        $rec = $existing;
        $mine = $rec !== null && $rec['createdBy'] === $s->identity;
        $named = $s->binding !== null && $s->binding['driverName'] !== '';
        switch ($entity) {
            case 'trip':
                if ($op === 'delete') {
                    return 'role';
                }
                if ($s->binding === null) {
                    return $rec === null || $mine ? null : 'not-own-trip';
                }
                // 已綁定：新建立的車趟也必須是自己的（不能替別的駕駛建立）。
                if ($incoming === null) {
                    return 'not-own-trip';
                }
                $f = self::scopeFields('trip', $incoming);
                if (!self::isOwnTrip($f['driverUuid'], $f['driverName'], $s->binding)) {
                    return 'not-own-trip';
                }
                return $rec === null || self::isOwnTrip($rec['driverUuid'], $rec['driverName'], $s->binding) ? null : 'not-own-trip';

            case 'inspection':
                if ($op === 'delete') {
                    return 'role';
                }
                if ($s->binding === null) {
                    return $rec === null || $mine ? null : 'not-own-inspection';
                }
                // 綁定的姓名是空字串時不認任何巡檢（否則會「擁有」所有駕駛人姓名空白的巡檢）。
                if (!$named || $incoming === null || Util::str($incoming->driverName ?? null) !== $s->binding['driverName']) {
                    return 'not-own-inspection';
                }
                return $rec === null || $rec['driverName'] === $s->binding['driverName'] ? null : 'not-own-inspection';

            case 'tripRequest':
                if ($op === 'delete') {
                    return 'only-admin-can-delete';
                }
                if ($incoming === null) {
                    return 'invalid-payload';
                }
                $me = Util::upper($s->deviceId);
                if ($op === 'create') {
                    if ($rec !== null) {
                        return 'request-already-exists';
                    }
                    if (($incoming->status ?? null) !== 'pending') {
                        return 'create-must-be-pending';
                    }
                    if (!self::hasNoDecision($incoming)) {
                        return 'approval-fields-not-allowed';
                    }
                    if (self::upperOrNull($incoming->requestedByDeviceID ?? null) !== $me) {
                        return 'requester-mismatch';
                    }
                    return null;
                }
                if ($live === null || $live['payload'] === null) {
                    return 'request-not-found';
                }
                // 修改：必須是這次配對建立的申請（重新配對不繼承），且不能改申請人。
                if ($live['createdBy'] !== $s->identity || self::upperOrNull($incoming->requestedByDeviceID ?? null) !== $live['requesterDevice']) {
                    return 'not-own-request';
                }
                if (($live['payload']->status ?? null) !== 'pending') {
                    return 'request-not-pending';
                }
                $status = $incoming->status ?? null;
                if ($status !== 'pending' && $status !== 'cancelled') {
                    return 'status-transition-not-allowed';
                }
                if (!self::hasNoDecision($incoming)) {
                    return 'approval-fields-not-allowed';
                }
                return null;

            default:
                return 'role';
        }
    }

    /**
     * 讀取範圍：這筆資料（或墓碑）能不能給這台裝置。
     *
     * @param array<string, mixed> $rec 至少要有 entity、driverUuid、driverName、createdBy
     */
    public static function visible(Session $s, array $rec): bool
    {
        if ($s->role !== 'driver') {
            return true;
        }
        switch ($rec['entity']) {
            case 'trip':
                return self::isOwnTrip($rec['driverUuid'], $rec['driverName'], $s->binding);
            case 'tripRequest':
                // 駕駛只看得到這次配對建立的申請（以主機端身分判斷，不以用戶端自報的裝置 ID）。
                return $rec['createdBy'] === $s->identity;
            case 'inspection':
                return $s->binding !== null && $s->binding['driverName'] !== '' && $rec['driverName'] === $s->binding['driverName'];
            default:
                return true;
        }
    }

    /** 這筆資料給這台裝置時是否要遮蔽（只有駕駛人資料；管理員與綁定的那一位駕駛人除外）。 */
    public static function needsRedaction(Session $s, string $entity, string $id): bool
    {
        if ($entity !== 'driver' || $s->role === 'admin') {
            return false;
        }
        if ($s->role === 'driver' && $s->binding !== null && Util::upper($s->binding['driverUuid']) === $id) {
            return false;
        }
        return true;
    }

    /** 駕駛人的個資遮蔽：證號、電話、備註改為空字串，移除證照到期日，其他欄位不變。 */
    public static function redactDriver(\stdClass $payload): \stdClass
    {
        $out = clone $payload;
        $out->licenseNumber = '';
        $out->phoneNumber = '';
        $out->notes = '';
        unset($out->licenseExpiryDate);
        return $out;
    }

    /**
     * 解析並檢查一筆事件。
     *
     * @return array{ok: true, id: string, entity: string, op: string, entityId: string, timestamp: int|float, payload: ?\stdClass, payloadText: string}|array{ok: false, id: string, reason: string}
     */
    public static function validateEvent(mixed $raw): array
    {
        $id = $raw instanceof \stdClass && is_string($raw->id ?? null) ? $raw->id : '';
        if (!$raw instanceof \stdClass) {
            return ['ok' => false, 'id' => $id, 'reason' => 'invalid-payload'];
        }
        $entity = $raw->entity ?? null;
        $op = $raw->operation ?? null;
        $entityId = Util::normalizeUuid($raw->entityID ?? null);
        $timestamp = Util::num($raw->timestamp ?? null);
        if (!self::isEntity($entity) || !self::isOperation($op) || $entityId === null || $timestamp === null) {
            return ['ok' => false, 'id' => $id, 'reason' => 'invalid-payload'];
        }
        $payloadText = is_string($raw->payloadJSON ?? null) ? $raw->payloadJSON : '';
        if ($op === 'delete') {
            return ['ok' => true, 'id' => $id, 'entity' => $entity, 'op' => $op, 'entityId' => $entityId, 'timestamp' => $timestamp, 'payload' => null, 'payloadText' => ''];
        }
        $payload = Json::decodeObject($payloadText, Json::PAYLOAD_DEPTH);
        if ($payload === null) {
            return ['ok' => false, 'id' => $id, 'reason' => 'invalid-payload'];
        }
        if (Util::normalizeUuid($payload->entityUUID ?? null) !== $entityId) {
            return ['ok' => false, 'id' => $id, 'reason' => 'invalid-payload'];
        }
        if (Util::num($payload->lastModifiedAt ?? null) === null) {
            return ['ok' => false, 'id' => $id, 'reason' => 'invalid-payload'];
        }
        // 範圍欄位的長度上限（與 core/src/rules.ts 的 MAX_SCOPE_TEXT 相同；docs/security-review.md §4.6）
        foreach (self::scopeFields($entity, $payload) as $v) {
            if ($v !== null && Util::cpLength($v) > self::MAX_SCOPE_TEXT) {
                return ['ok' => false, 'id' => $id, 'reason' => 'invalid-payload'];
            }
        }
        return ['ok' => true, 'id' => $id, 'entity' => $entity, 'op' => $op, 'entityId' => $entityId, 'timestamp' => $timestamp, 'payload' => $payload, 'payloadText' => $payloadText];
    }

    /** 範圍欄位（車牌、駕駛姓名、駕駛人 UUID、申請的裝置）的長度上限（字元）。 */
    public const MAX_SCOPE_TEXT = 200;

    /**
     * 綁定的駕駛人 `{driverUuid, driverName}`（driverName 去除前後空白後不能是空字串，最多 200 個字元）。
     *
     * @return array{driverUuid: string, driverName: string}|false|null null 表示清除；false 表示格式錯誤
     */
    public static function parseBinding(mixed $v): array|false|null
    {
        if ($v === null) {
            return null;
        }
        if (!$v instanceof \stdClass) {
            return false;
        }
        $id = Util::normalizeUuid($v->driverUuid ?? null);
        $name = is_string($v->driverName ?? null) ? Util::jsTrim($v->driverName) : null;
        if ($id === null || $name === null || $name === '' || Util::utf16Length($name) > 200) {
            return false;
        }
        return ['driverUuid' => $id, 'driverName' => $name];
    }
}
