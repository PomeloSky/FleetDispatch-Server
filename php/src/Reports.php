<?php

declare(strict_types=1);

namespace FleetDispatch;

/**
 * 報表（對應 core/src/reports.ts；規格 docs/reports.md）：期間摘要與 CSV 匯出，計算規則與 App 的報表相同。
 * 內容是 stdClass（Json::decodeObject）；日期以呼叫端給的時區計算。
 */
final class Reports
{
    public const EXPORT_KINDS = ['trips', 'maintenance', 'workOrders', 'inspections'];
    private const APPLE = 978307200;
    private const WORK_ORDER_STATUS = ['inProgress' => '進行中', 'waitingParts' => '待料', 'completed' => '已完成', 'cancelled' => '已取消'];

    /** @var array<string, \DateTimeZone> */
    private static array $zones = [];

    /** 時區名稱是否可用（IANA 名稱，與 TypeScript 版接受的格式相同）。 */
    public static function validTimeZone(string $tz): bool
    {
        if ($tz === '' || strlen($tz) > 64 || preg_match('/^[A-Za-z][A-Za-z0-9_+\-\/]*\z/', $tz) !== 1) {
            return false;
        }
        if ($tz === 'UTC') {
            return true;
        }
        static $known = null;
        $known ??= array_flip(\DateTimeZone::listIdentifiers(\DateTimeZone::ALL_WITH_BC));
        return isset($known[$tz]);
    }

    private static function zone(string $tz): \DateTimeZone
    {
        return self::$zones[$tz] ??= new \DateTimeZone($tz);
    }

    private static function at(int|float $ms, string $tz): \DateTimeImmutable
    {
        return (new \DateTimeImmutable('@' . (int) floor($ms / 1000)))->setTimezone(self::zone($tz));
    }

    public static function localDate(int|float $ms, string $tz): string
    {
        return self::at($ms, $tz)->format('Y-m-d');
    }

    public static function localTime(int|float $ms, string $tz): string
    {
        return self::at($ms, $tz)->format('H:i');
    }

    private static function addDays(string $date, int $n): string
    {
        $d = \DateTimeImmutable::createFromFormat('!Y-m-d', $date, new \DateTimeZone('UTC'));
        if ($d === false) {
            throw new \RuntimeException('日期格式錯誤');
        }
        return $d->modify(($n >= 0 ? '+' : '') . $n . ' day')->format('Y-m-d');
    }

    private static function finite(mixed $v): int|float
    {
        return Admin::finite($v) ?? 0;
    }

    private static function text(mixed $v): string
    {
        return is_string($v) ? $v : '';
    }

    private static function appleToMs(mixed $v): int|float|null
    {
        $n = Admin::finite($v);
        return $n === null ? null : ($n + self::APPLE) * 1000;
    }

    private static function round2(int|float $v): float
    {
        return floor($v * 100 + 0.5) / 100;
    }

    public static function tripDistance(\stdClass $p): int|float
    {
        $d = self::finite($p->odometerEnd ?? null) - self::finite($p->odometerStart ?? null);
        return $d > 0 ? $d : 0;
    }

    private static function tripCost(\stdClass $p): int|float
    {
        return self::finite($p->fuelCost ?? null) + self::finite($p->tollCost ?? null) + self::finite($p->parkingCost ?? null);
    }

    private static function workOrderCost(\stdClass $p): int|float
    {
        $s = 0;
        foreach (is_array($p->lines ?? null) ? $p->lines : [] as $l) {
            if (!$l instanceof \stdClass) {
                continue;
            }
            $q = Admin::finite($l->quantity ?? null) ?? 1;
            $s += $q * self::finite($l->unitCost ?? null);
        }
        return $s;
    }

    private static function isDefect(mixed $l): bool
    {
        return $l instanceof \stdClass && ($l->status ?? null) === 'defect';
    }

    /** @return array<string, int|float> */
    private static function emptyTotals(): array
    {
        return ['trips' => 0, 'distance' => 0, 'fuel' => 0, 'fuelCost' => 0, 'tollCost' => 0, 'parkingCost' => 0, 'tripCost' => 0];
    }

    /** @param array<string, int|float> $t */
    private static function addTrip(array &$t, \stdClass $p): void
    {
        $t['trips']++;
        $t['distance'] += self::tripDistance($p);
        $t['fuel'] += self::finite($p->fuelAmount ?? null);
        $t['fuelCost'] += self::finite($p->fuelCost ?? null);
        $t['tollCost'] += self::finite($p->tollCost ?? null);
        $t['parkingCost'] += self::finite($p->parkingCost ?? null);
        $t['tripCost'] += self::tripCost($p);
    }

    /**
     * @param array<string, int|float> $t
     * @return array<string, int|float>
     */
    private static function roundTotals(array $t): array
    {
        return [
            'trips' => (int) $t['trips'], 'distance' => self::round2($t['distance']), 'fuel' => self::round2($t['fuel']),
            'fuelCost' => self::round2($t['fuelCost']), 'tollCost' => self::round2($t['tollCost']), 'parkingCost' => self::round2($t['parkingCost']),
            'tripCost' => self::round2($t['tripCost']),
        ];
    }

    /** @param array<string, string> $names 駕駛人 UUID → 姓名 */
    private static function driverOf(\stdClass $p, array $names): string
    {
        $id = is_string($p->driverEntityUUID ?? null) ? strtoupper($p->driverEntityUUID) : null;
        if ($id !== null && array_key_exists($id, $names)) {
            return $names[$id];
        }
        return self::text($p->driver ?? null);
    }

    /** @param array{from: int, to: int} $f */
    private static function within(int|float|null $ms, array $f): bool
    {
        return $ms !== null && $ms >= $f['from'] && $ms < $f['to'];
    }

    /**
     * @param array{drivers: list<array{id: string, payload: \stdClass}>} $in
     * @return array<string, string>
     */
    private static function driverNames(array $in): array
    {
        $out = [];
        foreach ($in['drivers'] as $d) {
            $out[$d['id']] = self::text($d['payload']->name ?? null);
        }
        return $out;
    }

    /**
     * 篩選後、期間內已回車的車趟（依出車時間排序；相同時依 UUID）。
     *
     * @param array<string, mixed> $in
     * @param array<string, mixed> $f
     * @return list<\stdClass>
     */
    public static function periodTrips(array $in, array $f): array
    {
        $names = self::driverNames($in);
        $out = [];
        foreach ($in['trips'] as $p) {
            if (($p->isCompleted ?? null) !== true || !self::within(self::appleToMs($p->startTime ?? null), $f)) {
                continue;
            }
            if ($f['plate'] !== null && ($p->vehiclePlateNumber ?? null) !== $f['plate']) {
                continue;
            }
            if ($f['driver'] !== null && self::driverOf($p, $names) !== $f['driver']) {
                continue;
            }
            if ($f['costCenter'] !== null && self::text($p->costCenter ?? null) !== $f['costCenter']) {
                continue;
            }
            $out[] = $p;
        }
        usort($out, static fn (\stdClass $a, \stdClass $b): int => (self::finite($a->startTime ?? null) <=> self::finite($b->startTime ?? null))
            ?: Admin::compareStrings(self::text($a->entityUUID ?? null), self::text($b->entityUUID ?? null)));
        return $out;
    }

    /**
     * 期間摘要。
     *
     * @param array<string, mixed> $in trips、vehicles、drivers、maintenance、workOrders、inspections、now
     * @param array<string, mixed> $f from、to、tz、plate、driver、costCenter
     * @return array<string, mixed>
     */
    public static function summary(array $in, array $f): array
    {
        $names = self::driverNames($in);
        $trips = self::periodTrips($in, $f);
        $totals = self::emptyTotals();
        $byVehicle = [];
        $byDriver = [];
        $byCostCenter = [];
        $daily = [];
        $bump = static function (array &$m, string $k, \stdClass $p): void {
            if (!isset($m['k' . $k])) {
                $m['k' . $k] = ['key' => $k, 't' => self::emptyTotals()];
            }
            self::addTrip($m['k' . $k]['t'], $p);
        };
        foreach ($trips as $p) {
            self::addTrip($totals, $p);
            $bump($byVehicle, self::text($p->vehiclePlateNumber ?? null), $p);
            $bump($byDriver, self::driverOf($p, $names), $p);
            $bump($byCostCenter, self::text($p->costCenter ?? null), $p);
            $bump($daily, self::localDate(self::appleToMs($p->startTime), $f['tz']), $p);
        }

        $plateOk = static fn (\stdClass $p): bool => $f['plate'] === null || ($p->vehiclePlateNumber ?? null) === $f['plate'];
        $maintenance = array_values(array_filter($in['maintenance'], static fn (\stdClass $p): bool => $plateOk($p) && self::within(self::appleToMs($p->maintenanceDate ?? null), $f)));
        $workOrders = array_values(array_filter($in['workOrders'], static fn (\stdClass $p): bool => $plateOk($p) && self::within(self::appleToMs($p->openedAt ?? null), $f)));
        $inspections = array_values(array_filter($in['inspections'], static fn (\stdClass $p): bool => $plateOk($p) && self::within(self::appleToMs($p->date ?? null), $f)));
        $maintenanceCost = 0;
        $maintenanceByPlate = [];
        foreach ($maintenance as $p) {
            $c = self::finite($p->cost ?? null);
            $maintenanceCost += $c;
            $k = 'k' . self::text($p->vehiclePlateNumber ?? null);
            $maintenanceByPlate[$k] = ($maintenanceByPlate[$k] ?? 0) + $c;
        }
        $workOrderCost = 0;
        $workOrderByPlate = [];
        foreach ($workOrders as $p) {
            $c = self::workOrderCost($p);
            $workOrderCost += $c;
            $k = 'k' . self::text($p->vehiclePlateNumber ?? null);
            $workOrderByPlate[$k] = ($workOrderByPlate[$k] ?? 0) + $c;
        }

        // 稼動率
        $fleet = array_values(array_filter($in['vehicles'], static fn (\stdClass $v): bool => is_string($v->plateNumber ?? null)
            && ($f['plate'] === null || $v->plateNumber === $f['plate'])));
        $firstDay = self::localDate($f['from'], $f['tz']);
        $lastInPeriod = self::localDate($f['to'] - 1, $f['tz']);
        $today = self::localDate($in['now'], $f['tz']);
        $lastDay = strcmp($lastInPeriod, $today) < 0 ? $lastInPeriod : $today;
        $days = 0;
        for ($d = $firstDay; strcmp($d, $lastDay) <= 0 && $days < 4000; $d = self::addDays($d, 1)) {
            $days++;
        }
        $days = max($days, 1);
        $usage = [];
        foreach ($fleet as $v) {
            $plate = (string) $v->plateNumber;
            $set = [];
            foreach ($in['trips'] as $p) {
                if (($p->isCompleted ?? null) !== true || ($p->vehiclePlateNumber ?? null) !== $plate) {
                    continue;
                }
                $start = self::appleToMs($p->startTime ?? null);
                $end = self::appleToMs($p->endTime ?? null);
                if ($start === null || $end === null) {
                    continue;
                }
                $s = max($start, $f['from']);
                $e = min($end, $f['to']);
                if ($e < $s) {
                    continue;
                }
                $d = self::localDate($s, $f['tz']);
                $until = self::localDate($e, $f['tz']);
                for ($guard = 0; strcmp($d, $until) <= 0 && strcmp($d, $lastDay) <= 0 && $guard < 4000; $d = self::addDays($d, 1), $guard++) {
                    if (strcmp($d, $firstDay) >= 0) {
                        $set[$d] = true;
                    }
                }
            }
            $usage['k' . $plate] = count($set);
        }
        $used = array_sum($usage);
        $utilization = $fleet === [] ? null : self::round2($used / ($days * count($fleet)) * 100);

        $total = $totals['tripCost'] + $maintenanceCost + $workOrderCost;
        $plates = [];
        foreach ($fleet as $v) {
            $plates['k' . $v->plateNumber] = (string) $v->plateNumber;
        }
        foreach ($byVehicle as $entry) {
            $plates['k' . $entry['key']] = $entry['key'];
        }
        $plateList = array_values($plates);
        usort($plateList, [Admin::class, 'compareStrings']);
        $vehicles = [];
        foreach ($plateList as $plate) {
            $vehicle = null;
            foreach ($fleet as $v) {
                if ($v->plateNumber === $plate) {
                    $vehicle = $v;
                    break;
                }
            }
            $vehicles[] = ['plate' => $plate, 'vehicleId' => $vehicle !== null && is_string($vehicle->entityUUID ?? null) ? strtoupper($vehicle->entityUUID) : null]
                + self::roundTotals($byVehicle['k' . $plate]['t'] ?? self::emptyTotals())
                + [
                    'maintenanceCost' => self::round2($maintenanceByPlate['k' . $plate] ?? 0),
                    'workOrderCost' => self::round2($workOrderByPlate['k' . $plate] ?? 0),
                    'utilization' => $vehicle !== null ? self::round2(($usage['k' . $plate] ?? 0) / $days * 100) : null,
                ];
        }
        $driverIds = [];
        foreach ($in['drivers'] as $d) {
            $n = self::text($d['payload']->name ?? null);
            $driverIds['k' . $n] = $d['id']; // 同名時取最後一位（與 TypeScript 的 Map 相同）
        }
        $sorted = static function (array $m): array {
            $list = array_values($m);
            usort($list, static fn (array $a, array $b): int => Admin::compareStrings($a['key'], $b['key']));
            return $list;
        };
        $inspectionDefects = 0;
        foreach ($inspections as $p) {
            $bad = ($p->overallResult ?? null) === 'fail';
            foreach (is_array($p->lines ?? null) ? $p->lines : [] as $l) {
                $bad = $bad || self::isDefect($l);
            }
            if ($bad) {
                $inspectionDefects++;
            }
        }
        return [
            'period' => ['from' => $f['from'], 'to' => $f['to'], 'tz' => $f['tz'], 'firstDay' => $firstDay, 'lastDay' => $lastDay, 'days' => $days],
            'filter' => ['plate' => $f['plate'], 'driver' => $f['driver'], 'costCenter' => $f['costCenter']],
            'totals' => self::roundTotals($totals) + [
                'maintenanceCost' => self::round2($maintenanceCost),
                'workOrderCost' => self::round2($workOrderCost),
                'totalCost' => self::round2($total),
                'costPerKm' => $totals['distance'] > 0 ? self::round2($total / $totals['distance']) : null,
                'utilization' => $utilization,
                'maintenanceCount' => count($maintenance),
                'workOrderCount' => count($workOrders),
                'inspectionCount' => count($inspections),
                'inspectionDefects' => $inspectionDefects,
            ],
            'vehicles' => $vehicles,
            'drivers' => array_map(static fn (array $e): array => ['name' => $e['key'], 'driverId' => $driverIds['k' . $e['key']] ?? null] + self::roundTotals($e['t']), $sorted($byDriver)),
            'costCenters' => array_map(static fn (array $e): array => ['costCenter' => $e['key']] + self::roundTotals($e['t']), $sorted($byCostCenter)),
            'daily' => array_map(static fn (array $e): array => ['date' => $e['key']] + self::roundTotals($e['t']), $sorted($daily)),
        ];
    }

    // ───────── CSV ─────────

    public static function csvNumber(int|float $v): string
    {
        if (is_float($v) && !is_finite($v)) {
            return '';
        }
        $cents = (int) floor(abs($v) * 100 + 0.5);
        $sign = $v < 0 && $cents > 0 ? '-' : '';
        $int = intdiv($cents, 100);
        $frac = $cents % 100;
        if ($frac === 0) {
            return $sign . $int;
        }
        $s = sprintf('%02d', $frac);
        if (str_ends_with($s, '0')) {
            $s = substr($s, 0, -1);
        }
        return $sign . $int . '.' . $s;
    }

    private static function pos(int|float $v): string
    {
        return $v > 0 ? self::csvNumber($v) : '';
    }

    public static function csvCell(string $s): string
    {
        $v = $s;
        if ($v !== '' && str_contains("=+-@\t\r", $v[0]) && preg_match('/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\z/', $v) !== 1) {
            $v = "'" . $v;
        }
        if (strpbrk($v, "\",\n\r") !== false) {
            $v = '"' . str_replace('"', '""', $v) . '"';
        }
        return $v;
    }

    /**
     * @param list<string> $header
     * @param list<list<string>> $rows
     */
    public static function csv(array $header, array $rows): string
    {
        $lines = [];
        foreach ([$header, ...$rows] as $r) {
            $lines[] = implode(',', array_map([self::class, 'csvCell'], $r));
        }
        return "\xEF\xBB\xBF" . implode("\r\n", $lines) . "\r\n";
    }

    /**
     * @param array<string, mixed> $in
     * @param array<string, mixed> $f
     */
    public static function exportCsv(string $kind, array $in, array $f): string
    {
        $names = self::driverNames($in);
        $tz = $f['tz'];
        $date = static function (mixed $apple) use ($tz): string {
            $ms = self::appleToMs($apple);
            return $ms === null ? '' : self::localDate($ms, $tz);
        };
        $time = static function (mixed $apple) use ($tz): string {
            $ms = self::appleToMs($apple);
            return $ms === null ? '' : self::localTime($ms, $tz);
        };
        $plateOk = static fn (\stdClass $p): bool => $f['plate'] === null || ($p->vehiclePlateNumber ?? null) === $f['plate'];
        $byTime = static fn (string $key): \Closure => static fn (\stdClass $a, \stdClass $b): int => (self::finite($a->{$key} ?? null) <=> self::finite($b->{$key} ?? null))
            ?: Admin::compareStrings(self::text($a->entityUUID ?? null), self::text($b->entityUUID ?? null));
        $pick = static function (array $rows, string $key) use ($plateOk, $f, $byTime): array {
            $out = array_values(array_filter($rows, static fn (\stdClass $p): bool => $plateOk($p) && self::within(self::appleToMs($p->{$key} ?? null), $f)));
            usort($out, $byTime($key));
            return $out;
        };
        switch ($kind) {
            case 'trips':
                $rows = [];
                foreach (self::periodTrips($in, $f) as $p) {
                    $dest = [];
                    foreach (is_array($p->destinations ?? null) ? $p->destinations : [] as $d) {
                        if (is_string($d) && $d !== '') {
                            $dest[] = $d;
                        }
                    }
                    $rows[] = [
                        self::text($p->vehiclePlateNumber ?? null), $date($p->startTime ?? null), $time($p->startTime ?? null),
                        ($p->isCompleted ?? null) === true ? $time($p->endTime ?? null) : '',
                        self::csvNumber(self::finite($p->odometerStart ?? null)), self::pos(self::finite($p->odometerEnd ?? null)), self::csvNumber(self::tripDistance($p)),
                        self::text($p->origin ?? null), implode(' → ', $dest), self::text($p->mission ?? null), self::driverOf($p, $names), self::text($p->fuelType ?? null),
                        self::pos(self::finite($p->fuelAmount ?? null)), self::pos(self::finite($p->fuelCost ?? null)), self::pos(self::finite($p->tollCost ?? null)),
                        self::pos(self::finite($p->parkingCost ?? null)), ($p->didSwapBattery ?? null) === true ? '是' : '', self::text($p->costCenter ?? null),
                    ];
                }
                return self::csv(['車號', '日期', '出車時間', '回程時間', '起始碼錶', '結束碼錶', '里程', '起點', '到達地點', '任務說明', '駕駛人', '油種',
                    '加油量(L)', '加油金額', '過路費', '停車費', '電池更換', '成本中心'], $rows);
            case 'maintenance':
                $rows = [];
                foreach ($pick($in['maintenance'], 'maintenanceDate') as $p) {
                    $rows[] = [
                        $date($p->maintenanceDate ?? null), self::text($p->vehiclePlateNumber ?? null), self::pos(self::finite($p->odometerReading ?? null)),
                        self::csvNumber(self::finite($p->cost ?? null)), self::text($p->notes ?? null), self::pos(self::finite($p->intervalKm ?? null)),
                    ];
                }
                return self::csv(['日期', '車牌', '里程', '費用', '備註', '保養間隔'], $rows);
            case 'workOrders':
                $rows = [];
                foreach ($pick($in['workOrders'], 'openedAt') as $p) {
                    $closed = Admin::finite($p->closedAt ?? null);
                    $rows[] = [
                        $date($p->openedAt ?? null), self::text($p->title ?? null), self::text($p->vehiclePlateNumber ?? null),
                        self::WORK_ORDER_STATUS[self::text($p->status ?? null)] ?? '待處理', $closed === null ? '' : $date($closed),
                        self::pos(self::finite($p->odometer ?? null)), self::text($p->assignedTo ?? null), (string) count(is_array($p->lines ?? null) ? $p->lines : []),
                        self::csvNumber(self::workOrderCost($p)), self::text($p->notes ?? null),
                    ];
                }
                return self::csv(['開立日', '標題', '車輛', '狀態', '完工日', '里程', '負責人', '工項數', '合計金額', '備註'], $rows);
            default:
                $rows = [];
                foreach ($pick($in['inspections'], 'date') as $p) {
                    $defects = [];
                    foreach (is_array($p->lines ?? null) ? $p->lines : [] as $l) {
                        if (self::isDefect($l)) {
                            $defects[] = self::text($l->item ?? null) . (($l->severity ?? null) === 'major' ? '（嚴重）' : '')
                                . (self::text($l->comment ?? null) === '' ? '' : '：' . self::text($l->comment ?? null));
                        }
                    }
                    $rows[] = [
                        $date($p->date ?? null) . ' ' . $time($p->date ?? null), self::text($p->vehiclePlateNumber ?? null),
                        ($p->type ?? null) === 'postTrip' ? '收車後' : '出車前', self::text($p->driverName ?? null), self::pos(self::finite($p->odometer ?? null)),
                        ($p->overallResult ?? null) === 'pass' ? '合格' : '不合格', (string) count($defects), implode('; ', $defects), self::text($p->notes ?? null),
                    ];
                }
                return self::csv(['日期', '車輛', '類型', '點檢人', '里程', '結果', '缺陷數', '缺陷明細', '備註'], $rows);
        }
    }
}
