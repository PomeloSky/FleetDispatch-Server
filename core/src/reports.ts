// 報表（1.2.0；規格 docs/reports.md）：期間摘要與 CSV 匯出。計算規則與 App 的報表相同：
// - 只算已回車的車趟，依「出車時間」落在期間內（含開始、不含結束）；
// - 里程是「結束里程 − 起始里程」，小於 0 時算 0；車趟費用是油資＋過路費＋停車費；
// - 保養依保養日期、工單依開單時間、巡檢依巡檢時間落在期間內；工單金額是明細的「數量 × 單價」合計；
// - 稼動率：期間內有出車（已回車的車趟與期間重疊）的「車日」÷（天數 × 車輛數），天數只算到今天；
// - 駕駛人：車趟有駕駛人 UUID 且駕駛人存在時用駕駛人的姓名，否則用車趟上的姓名。
// 日期以呼叫端給的時區（IANA 名稱）計算。PHP 版 php/src/Reports.php 逐項對應。

import { compareStrings, parsePayload } from './admin.ts';
import { APPLE_EPOCH_OFFSET, isObject } from './util.ts';

export interface ReportFilter {
  /** 期間（1970 起算的毫秒）：含 from、不含 to。 */
  from: number;
  to: number;
  tz: string;
  plate: string | null;
  /** 駕駛姓名（driverId 轉成駕駛人的姓名後也用這個比對，與 App 依姓名篩選相同）。 */
  driver: string | null;
  costCenter: string | null;
}

export interface ReportInput {
  trips: Record<string, unknown>[];
  vehicles: Record<string, unknown>[];
  drivers: { id: string; payload: Record<string, unknown> }[];
  maintenance: Record<string, unknown>[];
  workOrders: Record<string, unknown>[];
  inspections: Record<string, unknown>[];
  /** 現在（毫秒）：稼動率的天數只算到今天。 */
  now: number;
}

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const appleToMs = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? (v + APPLE_EPOCH_OFFSET) * 1000 : null);

/** 時區名稱是否可用（IANA，例如 Asia/Taipei）。 */
export function validTimeZone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string): { y: string; m: string; d: string; h: string; min: string } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(Math.floor(ms / 1000) * 1000))) out[p.type] = p.value;
  return { y: out.year.padStart(4, '0'), m: out.month, d: out.day, h: out.hour === '24' ? '00' : out.hour, min: out.minute };
}

/** 這個時刻在時區中的日期 YYYY-MM-DD。 */
export function localDate(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.y}-${p.m}-${p.d}`;
}

/** 這個時刻在時區中的時間 HH:mm。 */
export function localTime(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.h}:${p.min}`;
}

/** 日期（YYYY-MM-DD）加 n 天。 */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

const round2 = (v: number): number => Math.floor(v * 100 + 0.5) / 100;

/** 車趟的里程（與 App 的報表相同：結束 − 起始，小於 0 時是 0）。 */
export const tripDistanceKm = (p: Record<string, unknown>): number => {
  const d = finite(p.odometerEnd) - finite(p.odometerStart);
  return d > 0 ? d : 0;
};
const tripCostOf = (p: Record<string, unknown>): number => finite(p.fuelCost) + finite(p.tollCost) + finite(p.parkingCost);
const workOrderCostOf = (p: Record<string, unknown>): number =>
  (Array.isArray(p.lines) ? p.lines : []).reduce<number>((s, l) => {
    if (!isObject(l)) return s;
    const q = typeof l.quantity === 'number' && Number.isFinite(l.quantity) ? l.quantity : 1;
    return s + q * finite(l.unitCost);
  }, 0);
const isDefect = (l: unknown): boolean => isObject(l) && l.status === 'defect';

interface Totals {
  trips: number;
  distance: number;
  fuel: number;
  fuelCost: number;
  tollCost: number;
  parkingCost: number;
  tripCost: number;
}
const emptyTotals = (): Totals => ({ trips: 0, distance: 0, fuel: 0, fuelCost: 0, tollCost: 0, parkingCost: 0, tripCost: 0 });
function addTrip(t: Totals, p: Record<string, unknown>) {
  t.trips++;
  t.distance += tripDistanceKm(p);
  t.fuel += finite(p.fuelAmount);
  t.fuelCost += finite(p.fuelCost);
  t.tollCost += finite(p.tollCost);
  t.parkingCost += finite(p.parkingCost);
  t.tripCost += tripCostOf(p);
}
const roundTotals = (t: Totals): Totals => ({
  trips: t.trips, distance: round2(t.distance), fuel: round2(t.fuel), fuelCost: round2(t.fuelCost), tollCost: round2(t.tollCost),
  parkingCost: round2(t.parkingCost), tripCost: round2(t.tripCost),
});

/** 車趟的駕駛姓名（App 的報表規則）。 */
function driverOf(p: Record<string, unknown>, names: Map<string, string>): string {
  const id = typeof p.driverEntityUUID === 'string' ? p.driverEntityUUID.toUpperCase() : null;
  const linked = id === null ? undefined : names.get(id);
  return linked !== undefined ? linked : text(p.driver);
}

/** 在期間內（含 from、不含 to）。 */
const within = (ms: number | null, f: ReportFilter): boolean => ms !== null && ms >= f.from && ms < f.to;

/** 篩選後、期間內已回車的車趟（依出車時間排序；相同時依 UUID）。 */
export function periodTrips(input: ReportInput, f: ReportFilter): Record<string, unknown>[] {
  const names = new Map(input.drivers.map((d) => [d.id, text(d.payload.name)]));
  return input.trips
    .filter((p) => p.isCompleted === true && within(appleToMs(p.startTime), f))
    .filter((p) => f.plate === null || p.vehiclePlateNumber === f.plate)
    .filter((p) => f.driver === null || driverOf(p, names) === f.driver)
    .filter((p) => f.costCenter === null || text(p.costCenter) === f.costCenter)
    .sort((a, b) => finite(a.startTime) - finite(b.startTime) || compareStrings(text(a.entityUUID), text(b.entityUUID)));
}

/** 期間摘要。 */
export function summary(input: ReportInput, f: ReportFilter) {
  const names = new Map(input.drivers.map((d) => [d.id, text(d.payload.name)]));
  const trips = periodTrips(input, f);
  const totals = emptyTotals();
  const byVehicle = new Map<string, Totals>();
  const byDriver = new Map<string, Totals>();
  const byCostCenter = new Map<string, Totals>();
  const daily = new Map<string, Totals>();
  const bump = (m: Map<string, Totals>, k: string, p: Record<string, unknown>) => {
    let t = m.get(k);
    if (!t) m.set(k, (t = emptyTotals()));
    addTrip(t, p);
  };
  for (const p of trips) {
    addTrip(totals, p);
    bump(byVehicle, text(p.vehiclePlateNumber), p);
    bump(byDriver, driverOf(p, names), p);
    bump(byCostCenter, text(p.costCenter), p);
    bump(daily, localDate(appleToMs(p.startTime)!, f.tz), p);
  }

  // 保養、工單、巡檢（篩選車牌；駕駛與成本中心不適用，與 App 相同）
  const plateOk = (p: Record<string, unknown>) => f.plate === null || p.vehiclePlateNumber === f.plate;
  const maintenance = input.maintenance.filter((p) => plateOk(p) && within(appleToMs(p.maintenanceDate), f));
  const workOrders = input.workOrders.filter((p) => plateOk(p) && within(appleToMs(p.openedAt), f));
  const inspections = input.inspections.filter((p) => plateOk(p) && within(appleToMs(p.date), f));
  const maintenanceCost = maintenance.reduce((s, p) => s + finite(p.cost), 0);
  const workOrderCost = workOrders.reduce((s, p) => s + workOrderCostOf(p), 0);
  const costBy = (rows: Record<string, unknown>[], cost: (p: Record<string, unknown>) => number) => {
    const m = new Map<string, number>();
    for (const p of rows) m.set(text(p.vehiclePlateNumber), (m.get(text(p.vehiclePlateNumber)) ?? 0) + cost(p));
    return m;
  };
  const maintenanceByPlate = costBy(maintenance, (p) => finite(p.cost));
  const workOrderByPlate = costBy(workOrders, workOrderCostOf);

  // 稼動率：車輛（車牌篩選）× 天數（只算到今天）
  const fleet = input.vehicles.filter((v) => typeof v.plateNumber === 'string' && (f.plate === null || v.plateNumber === f.plate));
  const firstDay = localDate(f.from, f.tz);
  const lastInPeriod = localDate(f.to - 1, f.tz);
  const today = localDate(input.now, f.tz);
  const lastDay = lastInPeriod < today ? lastInPeriod : today;
  let days = 0;
  for (let d = firstDay; d <= lastDay && days < 4000; d = addDays(d, 1)) days++;
  days = Math.max(days, 1);
  const usage = new Map<string, number>();
  for (const v of fleet) {
    const plate = text(v.plateNumber);
    const set = new Set<string>();
    for (const p of input.trips) {
      if (p.isCompleted !== true || p.vehiclePlateNumber !== plate) continue;
      const start = appleToMs(p.startTime);
      const end = appleToMs(p.endTime);
      if (start === null || end === null) continue;
      const s = Math.max(start, f.from);
      const e = Math.min(end, f.to);
      if (e < s) continue;
      let d = localDate(s, f.tz);
      const until = localDate(e, f.tz);
      for (let guard = 0; d <= until && d <= lastDay && guard < 4000; d = addDays(d, 1), guard++) {
        if (d >= firstDay) set.add(d);
      }
    }
    usage.set(plate, set.size);
  }
  const used = [...usage.values()].reduce((s, n) => s + n, 0);
  const utilization = fleet.length === 0 ? null : round2((used / (days * fleet.length)) * 100);

  const total = totals.tripCost + maintenanceCost + workOrderCost;
  const plates = new Set<string>([...fleet.map((v) => text(v.plateNumber)), ...byVehicle.keys()]);
  const vehicles = [...plates].sort(compareStrings).map((plate) => {
    const t = roundTotals(byVehicle.get(plate) ?? emptyTotals());
    const v = fleet.find((x) => x.plateNumber === plate);
    return {
      plate,
      vehicleId: v && typeof v.entityUUID === 'string' ? v.entityUUID.toUpperCase() : null,
      ...t,
      maintenanceCost: round2(maintenanceByPlate.get(plate) ?? 0),
      workOrderCost: round2(workOrderByPlate.get(plate) ?? 0),
      utilization: v ? round2(((usage.get(plate) ?? 0) / days) * 100) : null,
    };
  });
  const driverIds = new Map(input.drivers.map((d) => [text(d.payload.name), d.id]));
  return {
    period: { from: f.from, to: f.to, tz: f.tz, firstDay, lastDay, days },
    filter: { plate: f.plate, driver: f.driver, costCenter: f.costCenter },
    totals: {
      ...roundTotals(totals),
      maintenanceCost: round2(maintenanceCost),
      workOrderCost: round2(workOrderCost),
      totalCost: round2(total),
      costPerKm: totals.distance > 0 ? round2(total / totals.distance) : null,
      utilization,
      maintenanceCount: maintenance.length,
      workOrderCount: workOrders.length,
      inspectionCount: inspections.length,
      inspectionDefects: inspections.filter((p) => p.overallResult === 'fail' || (Array.isArray(p.lines) && p.lines.some(isDefect))).length,
    },
    vehicles,
    drivers: [...byDriver.entries()].sort((a, b) => compareStrings(a[0], b[0]))
      .map(([name, t]) => ({ name, driverId: driverIds.get(name) ?? null, ...roundTotals(t) })),
    costCenters: [...byCostCenter.entries()].sort((a, b) => compareStrings(a[0], b[0]))
      .map(([costCenter, t]) => ({ costCenter, ...roundTotals(t) })),
    daily: [...daily.entries()].sort((a, b) => compareStrings(a[0], b[0])).map(([date, t]) => ({ date, ...roundTotals(t) })),
  };
}

// ───────── CSV（與 App 的報表 CSV 相同：UTF-8＋BOM、CRLF、防公式注入） ─────────

/** 數字：整數不帶小數，其他最多 2 位（去掉尾端的 0）；不加千分位。 */
export function csvNumber(v: number): string {
  if (!Number.isFinite(v)) return '';
  const cents = Math.floor(Math.abs(v) * 100 + 0.5);
  const sign = v < 0 && cents > 0 ? '-' : '';
  const int = Math.floor(cents / 100);
  const frac = cents % 100;
  if (frac === 0) return `${sign}${int}`;
  return `${sign}${int}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
const pos = (v: number): string => (v > 0 ? csvNumber(v) : '');

/** 以單引號中和公式（開頭是 = + - @ Tab CR，且不是數字時）。 */
export function csvCell(s: string): string {
  let v = s;
  if (v !== '' && '=+-@\t\r'.includes(v[0]) && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) v = `'${v}`;
  if (/[",\n\r]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function csv(header: string[], rows: string[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export const EXPORT_KINDS = ['trips', 'maintenance', 'workOrders', 'inspections'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

const WORK_ORDER_STATUS: Record<string, string> = { inProgress: '進行中', waitingParts: '待料', completed: '已完成', cancelled: '已取消' };

/** 匯出 CSV（欄位與 App 報表的 CSV 相同，表頭為繁體中文）。 */
export function exportCsv(kind: ExportKind, input: ReportInput, f: ReportFilter): string {
  const names = new Map(input.drivers.map((d) => [d.id, text(d.payload.name)]));
  const date = (apple: unknown) => {
    const ms = appleToMs(apple);
    return ms === null ? '' : localDate(ms, f.tz);
  };
  const time = (apple: unknown) => {
    const ms = appleToMs(apple);
    return ms === null ? '' : localTime(ms, f.tz);
  };
  const plateOk = (p: Record<string, unknown>) => f.plate === null || p.vehiclePlateNumber === f.plate;
  const byTime = (key: string) => (a: Record<string, unknown>, b: Record<string, unknown>) =>
    finite(a[key]) - finite(b[key]) || compareStrings(text(a.entityUUID), text(b.entityUUID));
  switch (kind) {
    case 'trips':
      return csv(
        ['車號', '日期', '出車時間', '回程時間', '起始碼錶', '結束碼錶', '里程', '起點', '到達地點', '任務說明', '駕駛人', '油種', '加油量(L)',
          '加油金額', '過路費', '停車費', '電池更換', '成本中心'],
        periodTrips(input, f).map((p) => [
          text(p.vehiclePlateNumber), date(p.startTime), time(p.startTime), p.isCompleted === true ? time(p.endTime) : '',
          csvNumber(finite(p.odometerStart)), pos(finite(p.odometerEnd)), csvNumber(tripDistanceKm(p)), text(p.origin),
          (Array.isArray(p.destinations) ? p.destinations : []).filter((d): d is string => typeof d === 'string' && d !== '').join(' → '),
          text(p.mission), driverOf(p, names), text(p.fuelType), pos(finite(p.fuelAmount)), pos(finite(p.fuelCost)), pos(finite(p.tollCost)),
          pos(finite(p.parkingCost)), p.didSwapBattery === true ? '是' : '', text(p.costCenter),
        ]),
      );
    case 'maintenance':
      return csv(
        ['日期', '車牌', '里程', '費用', '備註', '保養間隔'],
        input.maintenance.filter((p) => plateOk(p) && within(appleToMs(p.maintenanceDate), f)).sort(byTime('maintenanceDate')).map((p) => [
          date(p.maintenanceDate), text(p.vehiclePlateNumber), pos(finite(p.odometerReading)), csvNumber(finite(p.cost)), text(p.notes), pos(finite(p.intervalKm)),
        ]),
      );
    case 'workOrders':
      return csv(
        ['開立日', '標題', '車輛', '狀態', '完工日', '里程', '負責人', '工項數', '合計金額', '備註'],
        input.workOrders.filter((p) => plateOk(p) && within(appleToMs(p.openedAt), f)).sort(byTime('openedAt')).map((p) => [
          date(p.openedAt), text(p.title), text(p.vehiclePlateNumber), WORK_ORDER_STATUS[text(p.status)] ?? '待處理',
          typeof p.closedAt === 'number' ? date(p.closedAt) : '', pos(finite(p.odometer)), text(p.assignedTo),
          String(Array.isArray(p.lines) ? p.lines.length : 0), csvNumber(workOrderCostOf(p)), text(p.notes),
        ]),
      );
    case 'inspections':
      return csv(
        ['日期', '車輛', '類型', '點檢人', '里程', '結果', '缺陷數', '缺陷明細', '備註'],
        input.inspections.filter((p) => plateOk(p) && within(appleToMs(p.date), f)).sort(byTime('date')).map((p) => {
          const lines = Array.isArray(p.lines) ? p.lines : [];
          const defects = lines.filter(isDefect) as Record<string, unknown>[];
          return [
            `${date(p.date)} ${time(p.date)}`, text(p.vehiclePlateNumber), p.type === 'postTrip' ? '收車後' : '出車前', text(p.driverName),
            pos(finite(p.odometer)), p.overallResult === 'pass' ? '合格' : '不合格', String(defects.length),
            defects.map((l) => `${text(l.item)}${l.severity === 'major' ? '（嚴重）' : ''}${text(l.comment) === '' ? '' : '：' + text(l.comment)}`).join('; '),
            text(p.notes),
          ];
        }),
      );
  }
}

/** 解析資料列的內容（略過壞掉的 JSON）。 */
export function payloads(rows: { payload: string | null }[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const p = parsePayload(r.payload);
    if (p) out.push(p);
  }
  return out;
}
