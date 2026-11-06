// 網頁管理的資料查詢、受控編輯與修改歷史（1.2.0；規格 docs/protocol.md §7.2–7.7、docs/admin-management.md）。
// 這裡是純函式：篩選、排序、分頁、修改的驗證、個資遮蔽、差異；資料庫存取在 handler.ts。
// PHP 版（php/src/Admin.php）逐項對應，三種實作的結果以 conformance/admin.test.mjs 檢查。

import { ADMIN_SPEC } from './admin-spec.ts';
import type { AdminRow, HistoryRow } from './db.ts';
import type { Entity } from './types.ts';
import { APPLE_EPOCH_OFFSET, isObject } from './util.ts';

export interface FieldSpec {
  key: string;
  label: string;
  type: string;
  edit?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  maxItems?: number;
  values?: [string, string][];
  nullable?: boolean;
  required?: boolean;
  pii?: 'partial' | 'full';
  hint?: string;
}

export interface SortSpec {
  label: string;
  field?: string;
  computed?: 'distance' | 'cost';
}

export interface EntitySpec {
  label: string;
  time: string | null;
  title: string[];
  search: string[];
  sorts: Record<string, SortSpec>;
  defaultSort: string;
  defaultOrder: 'asc' | 'desc';
  statuses: Record<string, string>;
  fields: FieldSpec[];
}

export interface AdminSpec {
  version: number;
  entities: Record<Entity, EntitySpec>;
  reasons: string[];
}

export const spec = (entity: Entity): EntitySpec => ADMIN_SPEC.entities[entity];
export const fieldOf = (entity: Entity, key: string): FieldSpec | undefined => spec(entity).fields.find((f) => f.key === key);

/** 時間欄位（Apple 秒）的合理範圍：1970-01-01 到 2101-01-01。 */
const APPLE_MIN = -APPLE_EPOCH_OFFSET;
const APPLE_MAX = 3155760000;
/** 碼錶合理範圍（與 App 的 TripRules.sanityDistanceKm 相同）：超過時提醒，不擋。 */
export const SANITY_DISTANCE_KM = 1000;
export const REASON_MAX = 500;

// ───────── 字串（與 PHP 版逐位元一致：碼位比較、只轉換 ASCII 大小寫） ─────────

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const codePoints = (s: string): string[] => Array.from(s);
export const cpLength = (s: string): number => codePoints(s).length;

/** 依碼位比較（等同 UTF-8 位元組順序，與 PHP 的 strcmp 一致）。 */
export function compareStrings(a: string, b: string): number {
  const x = codePoints(a);
  const y = codePoints(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** 搜尋字詞：以空白（含全形空白）分開，最多 10 個。 */
const SPACE = /[ \t\n\r\f\v\u00a0\u3000]+/;
export function searchTerms(q: string | null): string[] {
  if (q === null) return [];
  return q.split(SPACE).filter((t) => t !== '').slice(0, 10).map(asciiLower);
}

// ───────── 篩選、排序、分頁 ─────────

export interface QueryParams {
  terms: string[];
  /** 時間範圍（Apple 秒）：from 含、to 不含。 */
  from: number | null;
  to: number | null;
  status: string | null;
  sort: string;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface Parsed {
  row: AdminRow;
  payload: Record<string, unknown>;
}

export function parsePayload(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 車趟的里程：已回車且兩個碼錶都是數字時是「結束 − 起始」，否則沒有。 */
export function tripDistance(p: Record<string, unknown>): number | null {
  if (p.isCompleted !== true) return null;
  const a = finite(p.odometerStart);
  const b = finite(p.odometerEnd);
  return a === null || b === null ? null : b - a;
}

/** 車趟的費用：油資、過路費、停車費（缺少的當 0）。 */
export function tripCost(p: Record<string, unknown>): number {
  return (finite(p.fuelCost) ?? 0) + (finite(p.tollCost) ?? 0) + (finite(p.parkingCost) ?? 0);
}

/** 狀態篩選的值（各種類的定義見 spec 的 statuses）。 */
export function statusOf(entity: Entity, p: Record<string, unknown>): string | null {
  switch (entity) {
    case 'trip':
      return p.isCompleted === true ? 'completed' : p.isCompleted === false ? 'active' : null;
    case 'tripRequest':
    case 'workOrder':
      return typeof p.status === 'string' ? p.status : null;
    case 'inspection':
      return typeof p.overallResult === 'string' ? p.overallResult : null;
    case 'part': {
      const stock = finite(p.stockQuantity);
      const threshold = finite(p.reorderThreshold);
      return stock !== null && threshold !== null && threshold > 0 && stock <= threshold ? 'low' : null;
    }
    default:
      return null;
  }
}

function matches(value: unknown, term: string): boolean {
  if (typeof value === 'string') return asciiLower(value).includes(term);
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && asciiLower(v).includes(term));
  return false;
}

type SortValue = number | string | null;

function sortValue(entity: Entity, s: SortSpec, p: Record<string, unknown>): SortValue {
  if (s.computed === 'distance') return tripDistance(p);
  if (s.computed === 'cost') return tripCost(p);
  const v = s.field === undefined ? null : p[s.field];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  void entity;
  return null;
}

/** 排序值的比較：數字在字串前、沒有值的一律在最後（不論升冪或降冪）；相同時依 UUID。 */
function compareRows(a: SortValue, b: SortValue, desc: boolean): number {
  const rank = (v: SortValue) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 2) return 0;
  let c: number;
  if (ra === 0) c = (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  else c = compareStrings(a as string, b as string);
  return desc ? -c : c;
}

/** 篩選、排序、分頁。回傳總筆數與這一頁。 */
export function query(entity: Entity, rows: Parsed[], q: QueryParams): { total: number; page: Parsed[] } {
  const es = spec(entity);
  const timeField = es.time;
  const filtered = rows.filter(({ payload }) => {
    if (q.terms.length > 0 && !q.terms.every((t) => es.search.some((f) => matches(payload[f], t)))) return false;
    if (q.from !== null || q.to !== null) {
      const t = timeField === null ? null : finite(payload[timeField]);
      if (t === null) return false;
      if (q.from !== null && t < q.from) return false;
      if (q.to !== null && t >= q.to) return false;
    }
    if (q.status !== null && statusOf(entity, payload) !== q.status) return false;
    return true;
  });
  const s = es.sorts[q.sort];
  const desc = q.order === 'desc';
  const keyed = filtered.map((r) => ({ r, k: sortValue(entity, s, r.payload) }));
  keyed.sort((x, y) => compareRows(x.k, y.k, desc) || compareStrings(x.r.row.id, y.r.row.id));
  return { total: keyed.length, page: keyed.slice(q.offset, q.offset + q.limit).map((x) => x.r) };
}

/** 資料列的 API 形狀。 */
export function recordJson(r: AdminRow, names: Map<string, string>) {
  return {
    entity: r.entity,
    id: r.id,
    revision: Number(r.revision),
    seq: Number(r.seq),
    modifiedAt: Number(r.modified_at),
    deleted: Number(r.deleted) === 1,
    updatedAt: Number(r.updated_at),
    updatedBy: r.updated_by ? { deviceId: r.updated_by, name: names.get(r.updated_by) ?? null } : null,
    payload: Number(r.deleted) === 1 ? null : parsePayload(r.payload),
  };
}

// ───────── 個資 ─────────

/** 歷史中駕駛人的個資遮蔽（電話、證號保留最後 3 個字；備註整段遮蔽）。 */
export function maskValue(v: string, mode: 'partial' | 'full'): string {
  if (mode === 'full') return '［已遮蔽］';
  const cp = codePoints(v);
  return cp.length <= 4 ? '••••' : '••••' + cp.slice(-3).join('');
}

export function maskPayload(entity: string, p: unknown): unknown {
  if (entity !== 'driver' || !isObject(p)) return p;
  const out: Record<string, unknown> = { ...p };
  for (const f of spec('driver').fields) {
    const v = out[f.key];
    if (f.pii && typeof v === 'string' && v !== '') out[f.key] = maskValue(v, f.pii);
  }
  return out;
}

/** 稽核紀錄的摘要：駕駛人只留 UUID 與姓名（不把證號、電話、備註寫進稽核紀錄），其他資料是內容的前 2,000 個字元。 */
export function auditSummary(entity: string, payloadText: string | null): string {
  if (payloadText === null || payloadText === '') return '';
  if (entity === 'driver') {
    const p = parsePayload(payloadText);
    if (!p) return '';
    // 姓名最多 200 個字元（稽核紀錄只為了辨認是哪一位；MySQL 的 TEXT 最多 64 KB）
    return JSON.stringify({
      entityUUID: typeof p.entityUUID === 'string' ? p.entityUUID : '',
      name: typeof p.name === 'string' ? codePoints(p.name).slice(0, 200).join('') : '',
    });
  }
  return codePoints(payloadText).slice(0, 2000).join('');
}

// ───────── 差異 ─────────

/** 修改的欄位（第一層的鍵；不含每次都會變的 lastModifiedAt）。新增時是所有欄位。 */
export function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  keys.delete('lastModifiedAt');
  return [...keys].filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])).sort(compareStrings);
}

/** 修改前後歷史的一筆（API 回傳）。`pii` 為 false 時遮蔽駕駛人的個資。 */
export function historyJson(r: HistoryRow, pii: boolean) {
  const before = parsePayload(r.before_json);
  const after = parsePayload(r.after_json);
  let changed: unknown = null;
  if (r.changed_fields !== null) {
    try {
      changed = JSON.parse(r.changed_fields);
    } catch {
      changed = null;
    }
  }
  return {
    id: Number(r.id),
    at: Number(r.at),
    entity: r.entity,
    entityId: r.entity_id,
    eventId: r.event_id,
    operation: r.operation,
    source: r.source,
    outcome: r.outcome ?? 'applied',
    actor: { deviceId: r.actor_device, identity: r.actor_identity, name: r.actor_name },
    before: pii ? before : maskPayload(r.entity, before),
    after: pii ? after : maskPayload(r.entity, after),
    changedFields: Array.isArray(changed) ? changed : null,
    reason: r.reason,
    seq: Number(r.seq),
    revision: Number(r.revision),
  };
}

// ───────── 受控編輯 ─────────

export interface EditResult {
  after: Record<string, unknown>;
  errors: Record<string, string>;
  warnings: string[];
  /** 需要在資料庫確認的關聯（車牌、駕駛人）。 */
  plate: string | null;
  driverId: string | null;
}

/** 修改原因：1–500 個字（去除前後空白）。 */
export function cleanReason(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t !== '' && cpLength(t) <= REASON_MAX ? t : null;
}

function checkValue(f: FieldSpec, raw: unknown, current: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  switch (f.type) {
    case 'text':
    case 'multiline': {
      if (typeof raw !== 'string') return bad('必須是文字');
      const v = raw.trim();
      if (f.max !== undefined && cpLength(v) > f.max) return bad(`最多 ${f.max} 個字`);
      if (f.required && v === '') return bad('不能空白');
      return { ok: true, value: v };
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return bad('必須是數字');
      if (f.min !== undefined && raw < f.min) return bad(`不能小於 ${f.min}`);
      if (f.max !== undefined && raw > f.max) return bad(`不能大於 ${f.max}`);
      return { ok: true, value: raw };
    }
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return bad('必須是整數');
      if (f.min !== undefined && raw < f.min) return bad(`不能小於 ${f.min}`);
      if (f.max !== undefined && raw > f.max) return bad(`不能大於 ${f.max}`);
      return { ok: true, value: raw };
    }
    case 'bool':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : bad('必須是 true 或 false');
    case 'time':
    case 'date': {
      if (raw === null && f.nullable) return { ok: true, value: null };
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return bad('必須是時間');
      if (raw < APPLE_MIN || raw > APPLE_MAX) return bad('時間超出範圍');
      return { ok: true, value: raw };
    }
    case 'list': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) return bad('必須是文字清單');
      const v = (raw as string[]).map((x) => x.trim()).filter((x) => x !== '');
      if (f.maxItems !== undefined && v.length > f.maxItems) return bad(`最多 ${f.maxItems} 項`);
      if (f.max !== undefined && v.some((x) => cpLength(x) > f.max!)) return bad(`每一項最多 ${f.max} 個字`);
      return { ok: true, value: v };
    }
    case 'enum': {
      if (typeof raw !== 'string') return bad('不是可用的選項');
      // 舊資料可能有清單以外的值：維持原值可以，改成清單以外的值不行
      if (!(f.values ?? []).some(([v]) => v === raw) && raw !== current) return bad('不是可用的選項');
      return { ok: true, value: raw };
    }
    case 'plate': {
      if (typeof raw !== 'string' || raw.trim() === '') return bad('請選擇車輛');
      return { ok: true, value: raw.trim() };
    }
    case 'driverRef': {
      if (typeof raw !== 'string' || !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(raw)) return bad('請選擇駕駛人');
      return { ok: true, value: raw.toUpperCase() };
    }
    default:
      return bad('這個欄位不能在網頁修改');
  }
}

/**
 * 套用網頁的修改：只接受規格中可編輯的欄位，檢查型別、範圍與各種類的規則，保留其他欄位（含 App 新版本才有的欄位）與順序；
 * `lastModifiedAt` 改為 [modifiedAt]。關聯（車牌、駕駛人）由呼叫端查資料庫確認。
 */
export function applyChanges(entity: Entity, before: Record<string, unknown>, changes: unknown, modifiedAt: number): EditResult {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  const after: Record<string, unknown> = { ...before };
  const out: EditResult = { after, errors, warnings, plate: null, driverId: null };
  if (!isObject(changes) || Object.keys(changes).length === 0) {
    errors._ = '沒有要修改的欄位';
    return out;
  }
  for (const [key, raw] of Object.entries(changes)) {
    const f = fieldOf(entity, key);
    if (!f || !f.edit) {
      errors[key] = '這個欄位不能在網頁修改';
      continue;
    }
    const r = checkValue(f, raw, before[key]);
    if (!r.ok) {
      errors[key] = r.error;
      continue;
    }
    if (r.value === null) delete after[key];
    else after[key] = r.value;
    if (f.type === 'plate') out.plate = r.value as string;
    if (f.type === 'driverRef') out.driverId = r.value as string;
  }
  if (Object.keys(errors).length > 0) return out;

  const has = (k: string) => Object.prototype.hasOwnProperty.call(changes, k);
  switch (entity) {
    case 'trip': {
      const wasDone = before.isCompleted === true;
      const done = after.isCompleted === true;
      if (wasDone && !done) errors.isCompleted = '已回車的車趟不能改回出車中';
      if (!done && (has('endTime') || has('odometerEnd'))) {
        errors[has('endTime') ? 'endTime' : 'odometerEnd'] = '出車中的車趟沒有回車資料；要回車請一併把狀態改為已回車';
      }
      if (!wasDone && done) {
        if (!has('endTime')) errors.endTime = '回車需要回車時間';
        if (!has('odometerEnd')) errors.odometerEnd = '回車需要結束里程';
        const dest = after.destinations;
        if (!Array.isArray(dest) || dest.length === 0) errors.destinations = '回車需要至少一個目的地';
      }
      if (Object.keys(errors).length > 0) break;
      if (done) {
        const start = finite(after.startTime);
        const end = finite(after.endTime);
        if ((has('startTime') || has('endTime') || !wasDone) && start !== null && end !== null && end < start) {
          errors.endTime = '回車時間不能早於出車時間';
        }
        const a = finite(after.odometerStart);
        const b = finite(after.odometerEnd);
        if (has('odometerStart') || has('odometerEnd') || !wasDone) {
          if (b !== null && !wasDone && b <= 0) errors.odometerEnd = '結束里程必須大於 0';
          else if (a !== null && b !== null && b < a) errors.odometerEnd = '結束里程不能小於起始里程';
          else if (a !== null && b !== null && b - a > SANITY_DISTANCE_KM) {
            warnings.push(`本次行駛 ${Math.round((b - a) * 10) / 10} km，超過 ${SANITY_DISTANCE_KM} km，請確認碼錶數字無誤`);
          }
        }
      }
      break;
    }
    case 'vehicle': {
      if (has('modelYear')) {
        const y = after.modelYear as number;
        if (y !== 0 && (y < 1900 || y > 2100)) errors.modelYear = '年份必須是 1900–2100（0 表示未設定）';
      }
      if (has('fuelType')) after.isElectric = after.fuelType === 'electric';
      break;
    }
    case 'workOrder': {
      if (has('status') && after.status === 'completed' && before.status !== 'completed') {
        errors.status = '完工請在 App 操作（會扣零件庫存並寫保養紀錄）';
      }
      break;
    }
    default:
      break;
  }
  if (Object.keys(errors).length > 0) return out;
  after.lastModifiedAt = modifiedAt;
  if (changedFields(before, after).length === 0) errors._ = '內容沒有變更';
  return out;
}

/** 核准用車申請時建立的車趟（與 App 的 FleetStore.approveRequest 相同的欄位）。 */
export function tripFromRequest(
  request: Record<string, unknown>,
  tripId: string,
  plate: string | null,
  odometerStart: number,
  driver: { uuid: string; name: string } | null,
  now: number,
): Record<string, unknown> {
  const trip: Record<string, unknown> = {
    entityUUID: tripId,
    startTime: request.plannedStartTime,
    endTime: request.plannedEndTime,
    odometerStart,
    odometerEnd: 0,
    origin: typeof request.origin === 'string' ? request.origin : '',
    destinations: Array.isArray(request.destinations) ? request.destinations.filter((x) => typeof x === 'string') : [],
    mission: typeof request.mission === 'string' ? request.mission : '',
    fuelAmount: 0,
    fuelCost: 0,
    tollCost: 0,
    parkingCost: 0,
    fuelType: '',
    didSwapBattery: false,
    driver: typeof request.requestedBy === 'string' ? request.requestedBy : '',
    isCompleted: false,
    lastModifiedAt: now,
  };
  if (plate !== null) trip.vehiclePlateNumber = plate;
  if (driver !== null) trip.driverEntityUUID = driver.uuid;
  return trip;
}
