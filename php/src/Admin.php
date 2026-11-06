<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 網頁管理的純函式（對應 core/src/admin.ts）：篩選、排序、分頁、修改的驗證、個資遮蔽、差異。
 * 字串比較以位元組（等同碼位）、大小寫只轉換 ASCII，數字以數值比較——結果與 TypeScript 版逐項一致。
 *
 * 「列」是 Repo::adminRows() 的關聯陣列；payload 是 stdClass（Json::decodeObject）。
 */
final class Admin
{
    /** 時間欄位（Apple 秒）的合理範圍：1970-01-01 到 2101-01-01。 */
    private const APPLE_MIN = -978307200;
    private const APPLE_MAX = 3155760000;
    /** 碼錶合理範圍（App 的 TripRules.sanityDistanceKm）。 */
    public const SANITY_DISTANCE_KM = 1000;
    public const REASON_MAX = 500;

    /** @return array<string, mixed> */
    public static function spec(string $entity): array
    {
        return AdminSpec::get()['entities'][$entity];
    }

    /** @return array<string, mixed>|null */
    public static function fieldOf(string $entity, string $key): ?array
    {
        foreach (self::spec($entity)['fields'] as $f) {
            if ($f['key'] === $key) {
                return $f;
            }
        }
        return null;
    }

    // ───────── 字串 ─────────

    public static function asciiLower(string $s): string
    {
        return strtr($s, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
    }

    /** 依碼位比較（UTF-8 的位元組順序等同碼位順序）：-1、0、1。 */
    public static function compareStrings(string $a, string $b): int
    {
        $c = strcmp($a, $b);
        return $c < 0 ? -1 : ($c > 0 ? 1 : 0);
    }

    /** @return list<string> */
    public static function searchTerms(?string $q): array
    {
        if ($q === null) {
            return [];
        }
        $parts = preg_split('/[ \t\n\r\x0C\x0B\x{00A0}\x{3000}]+/u', $q, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        return array_map(static fn (string $t): string => self::asciiLower($t), array_slice($parts, 0, 10));
    }

    // ───────── 篩選、排序、分頁 ─────────

    public static function finite(mixed $v): int|float|null
    {
        if (is_int($v)) {
            return $v;
        }
        return is_float($v) && is_finite($v) ? $v : null;
    }

    public static function tripDistance(\stdClass $p): int|float|null
    {
        if (($p->isCompleted ?? null) !== true) {
            return null;
        }
        $a = self::finite($p->odometerStart ?? null);
        $b = self::finite($p->odometerEnd ?? null);
        return $a === null || $b === null ? null : $b - $a;
    }

    public static function tripCost(\stdClass $p): int|float
    {
        return (self::finite($p->fuelCost ?? null) ?? 0) + (self::finite($p->tollCost ?? null) ?? 0) + (self::finite($p->parkingCost ?? null) ?? 0);
    }

    public static function statusOf(string $entity, \stdClass $p): ?string
    {
        switch ($entity) {
            case 'trip':
                $c = $p->isCompleted ?? null;
                return $c === true ? 'completed' : ($c === false ? 'active' : null);
            case 'tripRequest':
            case 'workOrder':
                return is_string($p->status ?? null) ? $p->status : null;
            case 'inspection':
                return is_string($p->overallResult ?? null) ? $p->overallResult : null;
            case 'part':
                $stock = self::finite($p->stockQuantity ?? null);
                $threshold = self::finite($p->reorderThreshold ?? null);
                return $stock !== null && $threshold !== null && $threshold > 0 && $stock <= $threshold ? 'low' : null;
            default:
                return null;
        }
    }

    private static function matches(mixed $value, string $term): bool
    {
        if (is_string($value)) {
            return str_contains(self::asciiLower($value), $term);
        }
        if (is_array($value)) {
            foreach ($value as $v) {
                if (is_string($v) && str_contains(self::asciiLower($v), $term)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** @param array<string, mixed> $sort */
    private static function sortValue(array $sort, \stdClass $p): int|float|string|null
    {
        $computed = $sort['computed'] ?? null;
        if ($computed === 'distance') {
            return self::tripDistance($p);
        }
        if ($computed === 'cost') {
            return self::tripCost($p);
        }
        $field = $sort['field'] ?? null;
        $v = $field === null ? null : ($p->{$field} ?? null);
        if (is_int($v) || is_float($v)) {
            return self::finite($v);
        }
        if (is_string($v)) {
            return $v;
        }
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        return null;
    }

    private static function compareValues(int|float|string|null $a, int|float|string|null $b, bool $desc): int
    {
        $rank = static fn ($v): int => is_int($v) || is_float($v) ? 0 : (is_string($v) ? 1 : 2);
        $ra = $rank($a);
        $rb = $rank($b);
        if ($ra !== $rb) {
            return $ra < $rb ? -1 : 1;
        }
        if ($ra === 2) {
            return 0;
        }
        $c = $ra === 0 ? ($a < $b ? -1 : ($a > $b ? 1 : 0)) : self::compareStrings((string) $a, (string) $b);
        return $desc ? -$c : $c;
    }

    /**
     * 篩選、排序、分頁。
     *
     * @param list<array{row: array<string, mixed>, payload: \stdClass}> $rows
     * @param array{terms: list<string>, from: int|float|null, to: int|float|null, status: ?string, sort: string, order: string, limit: int, offset: int} $q
     * @return array{total: int, page: list<array{row: array<string, mixed>, payload: \stdClass}>}
     */
    public static function query(string $entity, array $rows, array $q): array
    {
        $es = self::spec($entity);
        $timeField = $es['time'];
        $filtered = [];
        foreach ($rows as $r) {
            $p = $r['payload'];
            if ($q['terms'] !== []) {
                $ok = true;
                foreach ($q['terms'] as $t) {
                    $hit = false;
                    foreach ($es['search'] as $f) {
                        if (self::matches($p->{$f} ?? null, $t)) {
                            $hit = true;
                            break;
                        }
                    }
                    if (!$hit) {
                        $ok = false;
                        break;
                    }
                }
                if (!$ok) {
                    continue;
                }
            }
            if ($q['from'] !== null || $q['to'] !== null) {
                $t = $timeField === null ? null : self::finite($p->{$timeField} ?? null);
                if ($t === null || ($q['from'] !== null && $t < $q['from']) || ($q['to'] !== null && $t >= $q['to'])) {
                    continue;
                }
            }
            if ($q['status'] !== null && self::statusOf($entity, $p) !== $q['status']) {
                continue;
            }
            $filtered[] = $r;
        }
        $sort = $es['sorts'][$q['sort']];
        $desc = $q['order'] === 'desc';
        $keyed = [];
        foreach ($filtered as $r) {
            $keyed[] = ['r' => $r, 'k' => self::sortValue($sort, $r['payload'])];
        }
        usort($keyed, static function (array $x, array $y) use ($desc): int {
            return self::compareValues($x['k'], $y['k'], $desc) ?: self::compareStrings((string) $x['r']['row']['id'], (string) $y['r']['row']['id']);
        });
        $page = array_map(static fn (array $x): array => $x['r'], array_slice($keyed, $q['offset'], $q['limit']));
        return ['total' => count($keyed), 'page' => $page];
    }

    /**
     * 資料列的 API 形狀。
     *
     * @param array<string, mixed> $r
     * @param array<string, string> $names 裝置 ID → 名稱
     * @return array<string, mixed>
     */
    public static function recordJson(array $r, array $names): array
    {
        $deleted = (int) $r['deleted'] === 1;
        $payload = null;
        if (!$deleted && $r['payload'] !== null && Json::isObjectText((string) $r['payload'])) {
            $payload = new RawJson((string) $r['payload']);
        }
        $by = $r['updated_by'] === null ? null : (string) $r['updated_by'];
        return [
            'entity' => (string) $r['entity'],
            'id' => (string) $r['id'],
            'revision' => (int) $r['revision'],
            'seq' => (int) $r['seq'],
            'modifiedAt' => (float) $r['modified_at'],
            'deleted' => $deleted,
            'updatedAt' => (int) $r['updated_at'],
            'updatedBy' => $by === null || $by === '' ? null : ['deviceId' => $by, 'name' => $names[$by] ?? null],
            'payload' => $payload,
        ];
    }

    // ───────── 個資 ─────────

    public static function maskValue(string $v, string $mode): string
    {
        if ($mode === 'full') {
            return '［已遮蔽］';
        }
        $n = Util::cpLength($v);
        if ($n <= 4) {
            return '••••';
        }
        preg_match_all('/./us', $v, $m);
        return '••••' . implode('', array_slice($m[0], -3));
    }

    public static function maskPayload(string $entity, mixed $p): mixed
    {
        if ($entity !== 'driver' || !$p instanceof \stdClass) {
            return $p;
        }
        $out = clone $p;
        foreach (self::spec('driver')['fields'] as $f) {
            $key = $f['key'];
            $mode = $f['pii'] ?? null;
            if ($mode !== null && is_string($out->{$key} ?? null) && $out->{$key} !== '') {
                $out->{$key} = self::maskValue($out->{$key}, $mode);
            }
        }
        return $out;
    }

    /** 稽核紀錄的摘要：駕駛人只留 UUID 與姓名，其他資料是內容的前 2,000 個字元。 */
    public static function auditSummary(string $entity, ?string $payloadText): string
    {
        if ($payloadText === null || $payloadText === '') {
            return '';
        }
        if ($entity === 'driver') {
            $p = Json::decodeObject($payloadText);
            if ($p === null) {
                return '';
            }
            return Json::encode([
                'entityUUID' => is_string($p->entityUUID ?? null) ? $p->entityUUID : '',
                'name' => is_string($p->name ?? null) ? $p->name : '',
            ]);
        }
        return Util::firstCodePoints($payloadText, 2000);
    }

    // ───────── 差異 ─────────

    /** 兩個 JSON 值是否相同（等同 JavaScript 比較 JSON.stringify 的結果：數字以數值比較，物件的鍵依順序）。 */
    public static function sameJson(mixed $a, mixed $b): bool
    {
        $num = static fn ($v): bool => is_int($v) || is_float($v);
        if ($num($a) && $num($b)) {
            $x = is_float($a) && !is_finite($a) ? null : (float) $a;
            $y = is_float($b) && !is_finite($b) ? null : (float) $b;
            return $x === $y;
        }
        if (is_array($a) && is_array($b)) {
            if (count($a) !== count($b) || array_is_list($a) !== array_is_list($b)) {
                return false;
            }
            $ka = array_keys($a);
            $kb = array_keys($b);
            foreach ($ka as $i => $k) {
                if ($k !== $kb[$i] || !self::sameJson($a[$k], $b[$k])) {
                    return false;
                }
            }
            return true;
        }
        if ($a instanceof \stdClass && $b instanceof \stdClass) {
            return self::sameJson(get_object_vars($a), get_object_vars($b));
        }
        return $a === $b;
    }

    /**
     * 修改的欄位（第一層的鍵；不含 lastModifiedAt），依碼位排序。新增時是所有欄位。
     *
     * @return list<string>
     */
    public static function changedFields(?\stdClass $before, ?\stdClass $after): array
    {
        $b = $before === null ? [] : get_object_vars($before);
        $a = $after === null ? [] : get_object_vars($after);
        $out = [];
        foreach (array_unique(array_merge(array_map('strval', array_keys($b)), array_map('strval', array_keys($a)))) as $k) {
            if ($k === 'lastModifiedAt') {
                continue;
            }
            $hasB = array_key_exists($k, $b);
            $hasA = array_key_exists($k, $a);
            if ($hasB !== $hasA || ($hasB && !self::sameJson($b[$k], $a[$k]))) {
                $out[] = $k;
            }
        }
        sort($out, SORT_STRING);
        return $out;
    }

    /**
     * 修改前後歷史的一筆（API 回傳）。$pii 為 false 時遮蔽駕駛人的個資。
     *
     * @param array<string, mixed> $r
     * @return array<string, mixed>
     */
    public static function historyJson(array $r, bool $pii): array
    {
        $entity = (string) $r['entity'];
        $decode = static function (mixed $text) use ($entity, $pii): mixed {
            if ($text === null) {
                return null;
            }
            $j = Json::decodeObject((string) $text);
            if ($j === null) {
                return null;
            }
            return $pii || $entity !== 'driver' ? new RawJson((string) $text) : self::maskPayload($entity, $j);
        };
        $changed = $r['changed_fields'] === null ? null : json_decode((string) $r['changed_fields'], true);
        return [
            'id' => (int) $r['id'],
            'at' => (int) $r['at'],
            'entity' => $entity,
            'entityId' => (string) $r['entity_id'],
            'eventId' => $r['event_id'] === null ? null : (string) $r['event_id'],
            'operation' => (string) $r['operation'],
            'source' => (string) $r['source'],
            'outcome' => (string) ($r['outcome'] ?? 'applied'),
            'actor' => [
                'deviceId' => $r['actor_device'] === null ? null : (string) $r['actor_device'],
                'identity' => $r['actor_identity'] === null ? null : (string) $r['actor_identity'],
                'name' => $r['actor_name'] === null ? null : (string) $r['actor_name'],
            ],
            'before' => $decode($r['before_json']),
            'after' => $decode($r['after_json']),
            'changedFields' => is_array($changed) && array_is_list($changed) ? $changed : null,
            'reason' => $r['reason'] === null ? null : (string) $r['reason'],
            'seq' => (int) $r['seq'],
            'revision' => (int) $r['revision'],
        ];
    }

    // ───────── 受控編輯 ─────────

    public static function cleanReason(mixed $v): ?string
    {
        if (!is_string($v)) {
            return null;
        }
        $t = Util::jsTrim($v);
        return $t !== '' && Util::cpLength($t) <= self::REASON_MAX ? $t : null;
    }

    /**
     * @param array<string, mixed> $f
     * @return array{ok: bool, value?: mixed, error?: string}
     */
    private static function checkValue(array $f, mixed $raw, mixed $current): array
    {
        $bad = static fn (string $e): array => ['ok' => false, 'error' => $e];
        $min = $f['min'] ?? null;
        $max = $f['max'] ?? null;
        switch ($f['type']) {
            case 'text':
            case 'multiline':
                if (!is_string($raw)) {
                    return $bad('必須是文字');
                }
                $v = Util::jsTrim($raw);
                if ($max !== null && Util::cpLength($v) > $max) {
                    return $bad("最多 {$max} 個字");
                }
                if (($f['required'] ?? false) && $v === '') {
                    return $bad('不能空白');
                }
                return ['ok' => true, 'value' => $v];
            case 'number':
                if (self::finite($raw) === null) {
                    return $bad('必須是數字');
                }
                if ($min !== null && $raw < $min) {
                    return $bad("不能小於 {$min}");
                }
                if ($max !== null && $raw > $max) {
                    return $bad("不能大於 {$max}");
                }
                return ['ok' => true, 'value' => $raw];
            case 'integer':
                if (!is_int($raw) && !(is_float($raw) && is_finite($raw) && floor($raw) === $raw)) {
                    return $bad('必須是整數');
                }
                if ($min !== null && $raw < $min) {
                    return $bad("不能小於 {$min}");
                }
                if ($max !== null && $raw > $max) {
                    return $bad("不能大於 {$max}");
                }
                return ['ok' => true, 'value' => (int) $raw];
            case 'bool':
                return is_bool($raw) ? ['ok' => true, 'value' => $raw] : $bad('必須是 true 或 false');
            case 'time':
            case 'date':
                if ($raw === null && ($f['nullable'] ?? false)) {
                    return ['ok' => true, 'value' => null];
                }
                if (self::finite($raw) === null) {
                    return $bad('必須是時間');
                }
                if ($raw < self::APPLE_MIN || $raw > self::APPLE_MAX) {
                    return $bad('時間超出範圍');
                }
                return ['ok' => true, 'value' => $raw];
            case 'list':
                if (!is_array($raw) || !array_is_list($raw)) {
                    return $bad('必須是文字清單');
                }
                $v = [];
                foreach ($raw as $x) {
                    if (!is_string($x)) {
                        return $bad('必須是文字清單');
                    }
                    $t = Util::jsTrim($x);
                    if ($t !== '') {
                        $v[] = $t;
                    }
                }
                if (isset($f['maxItems']) && count($v) > $f['maxItems']) {
                    return $bad("最多 {$f['maxItems']} 項");
                }
                foreach ($v as $x) {
                    if ($max !== null && Util::cpLength($x) > $max) {
                        return $bad("每一項最多 {$max} 個字");
                    }
                }
                return ['ok' => true, 'value' => $v];
            case 'enum':
                if (!is_string($raw)) {
                    return $bad('不是可用的選項');
                }
                $known = false;
                foreach ($f['values'] ?? [] as $pair) {
                    if ($pair[0] === $raw) {
                        $known = true;
                        break;
                    }
                }
                if (!$known && $raw !== $current) {
                    return $bad('不是可用的選項');
                }
                return ['ok' => true, 'value' => $raw];
            case 'plate':
                if (!is_string($raw) || Util::jsTrim($raw) === '') {
                    return $bad('請選擇車輛');
                }
                return ['ok' => true, 'value' => Util::jsTrim($raw)];
            case 'driverRef':
                if (!is_string($raw) || !Util::isUuid($raw)) {
                    return $bad('請選擇駕駛人');
                }
                return ['ok' => true, 'value' => strtoupper($raw)];
            default:
                return $bad('這個欄位不能在網頁修改');
        }
    }

    /**
     * 套用網頁的修改（對應 admin.ts 的 applyChanges）。
     *
     * @return array{after: \stdClass, errors: array<string, string>, warnings: list<string>, plate: ?string, driverId: ?string}
     */
    public static function applyChanges(string $entity, \stdClass $before, mixed $changes, int|float $modifiedAt): array
    {
        $errors = [];
        $warnings = [];
        $after = clone $before;
        $out = ['after' => $after, 'errors' => [], 'warnings' => [], 'plate' => null, 'driverId' => null];
        if (!$changes instanceof \stdClass || get_object_vars($changes) === []) {
            $out['errors'] = ['_' => '沒有要修改的欄位'];
            return $out;
        }
        $has = static fn (string $k): bool => property_exists($changes, $k);
        foreach (get_object_vars($changes) as $key => $raw) {
            $key = (string) $key;
            $f = self::fieldOf($entity, $key);
            if ($f === null || !($f['edit'] ?? false)) {
                $errors[$key] = '這個欄位不能在網頁修改';
                continue;
            }
            $r = self::checkValue($f, $raw, $before->{$key} ?? null);
            if (!$r['ok']) {
                $errors[$key] = $r['error'];
                continue;
            }
            if ($r['value'] === null) {
                unset($after->{$key});
            } else {
                $after->{$key} = $r['value'];
            }
            if ($f['type'] === 'plate') {
                $out['plate'] = $r['value'];
            }
            if ($f['type'] === 'driverRef') {
                $out['driverId'] = $r['value'];
            }
        }
        if ($errors !== []) {
            $out['errors'] = $errors;
            return $out;
        }
        switch ($entity) {
            case 'trip':
                $wasDone = ($before->isCompleted ?? null) === true;
                $done = ($after->isCompleted ?? null) === true;
                if ($wasDone && !$done) {
                    $errors['isCompleted'] = '已回車的車趟不能改回出車中';
                }
                if (!$done && ($has('endTime') || $has('odometerEnd'))) {
                    $errors[$has('endTime') ? 'endTime' : 'odometerEnd'] = '出車中的車趟沒有回車資料；要回車請一併把狀態改為已回車';
                }
                if (!$wasDone && $done) {
                    if (!$has('endTime')) {
                        $errors['endTime'] = '回車需要回車時間';
                    }
                    if (!$has('odometerEnd')) {
                        $errors['odometerEnd'] = '回車需要結束里程';
                    }
                    $dest = $after->destinations ?? null;
                    if (!is_array($dest) || $dest === []) {
                        $errors['destinations'] = '回車需要至少一個目的地';
                    }
                }
                if ($errors !== [] || !$done) {
                    break;
                }
                $start = self::finite($after->startTime ?? null);
                $end = self::finite($after->endTime ?? null);
                if (($has('startTime') || $has('endTime') || !$wasDone) && $start !== null && $end !== null && $end < $start) {
                    $errors['endTime'] = '回車時間不能早於出車時間';
                }
                $a = self::finite($after->odometerStart ?? null);
                $b = self::finite($after->odometerEnd ?? null);
                if ($has('odometerStart') || $has('odometerEnd') || !$wasDone) {
                    if ($b !== null && !$wasDone && $b <= 0) {
                        $errors['odometerEnd'] = '結束里程必須大於 0';
                    } elseif ($a !== null && $b !== null && $b < $a) {
                        $errors['odometerEnd'] = '結束里程不能小於起始里程';
                    } elseif ($a !== null && $b !== null && $b - $a > self::SANITY_DISTANCE_KM) {
                        $warnings[] = '本次行駛 ' . self::jsNumber(round(($b - $a) * 10) / 10) . ' km，超過 ' . self::SANITY_DISTANCE_KM . ' km，請確認碼錶數字無誤';
                    }
                }
                break;
            case 'vehicle':
                if ($has('modelYear')) {
                    $y = $after->modelYear;
                    if ($y !== 0 && ($y < 1900 || $y > 2100)) {
                        $errors['modelYear'] = '年份必須是 1900–2100（0 表示未設定）';
                    }
                }
                if ($has('fuelType')) {
                    $after->isElectric = ($after->fuelType ?? null) === 'electric';
                }
                break;
            case 'workOrder':
                if ($has('status') && ($after->status ?? null) === 'completed' && ($before->status ?? null) !== 'completed') {
                    $errors['status'] = '完工請在 App 操作（會扣零件庫存並寫保養紀錄）';
                }
                break;
            default:
                break;
        }
        $out['warnings'] = $warnings;
        if ($errors !== []) {
            $out['errors'] = $errors;
            return $out;
        }
        $after->lastModifiedAt = $modifiedAt;
        if (self::changedFields($before, $after) === []) {
            $out['errors'] = ['_' => '內容沒有變更'];
        }
        return $out;
    }

    /** JavaScript 的數字轉字串（整數不帶小數點）。 */
    private static function jsNumber(int|float $n): string
    {
        if (is_float($n) && floor($n) === $n && abs($n) < 1e15) {
            return (string) (int) $n;
        }
        return (string) $n;
    }

    /**
     * 核准用車申請時建立的車趟（與 App 的 FleetStore.approveRequest 相同的欄位）。
     *
     * @param array{uuid: string, name: string}|null $driver
     */
    public static function tripFromRequest(\stdClass $request, string $tripId, ?string $plate, int|float $odometerStart, ?array $driver, int|float $now): \stdClass
    {
        $dest = [];
        foreach (is_array($request->destinations ?? null) ? $request->destinations : [] as $d) {
            if (is_string($d)) {
                $dest[] = $d;
            }
        }
        $trip = new \stdClass();
        $trip->entityUUID = $tripId;
        $trip->startTime = $request->plannedStartTime ?? null;
        $trip->endTime = $request->plannedEndTime ?? null;
        $trip->odometerStart = $odometerStart;
        $trip->odometerEnd = 0;
        $trip->origin = is_string($request->origin ?? null) ? $request->origin : '';
        $trip->destinations = $dest;
        $trip->mission = is_string($request->mission ?? null) ? $request->mission : '';
        $trip->fuelAmount = 0;
        $trip->fuelCost = 0;
        $trip->tollCost = 0;
        $trip->parkingCost = 0;
        $trip->fuelType = '';
        $trip->didSwapBattery = false;
        $trip->driver = is_string($request->requestedBy ?? null) ? $request->requestedBy : '';
        $trip->isCompleted = false;
        $trip->lastModifiedAt = $now;
        if ($plate !== null) {
            $trip->vehiclePlateNumber = $plate;
        }
        if ($driver !== null) {
            $trip->driverEntityUUID = $driver['uuid'];
        }
        return $trip;
    }
}
