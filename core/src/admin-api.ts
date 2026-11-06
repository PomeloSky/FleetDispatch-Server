// 網頁管理的資料端點（1.2.0；規格 docs/protocol.md §7.2–7.6）。只有管理員；所有修改經過受控的檢查後，
// 以 Repo.writeAll 在同一個交易寫入資料、修改前後歷史與稽核紀錄，App 以原本的同步（GET /changes）取得。

import {
  applyChanges, auditSummary, changedFields, cleanReason, cpLength, parsePayload, query, recordJson, searchTerms, spec, tripFromRequest,
} from './admin.ts';
import type { Parsed, QueryParams } from './admin.ts';
import { ADMIN_SPEC } from './admin-spec.ts';
import type { AdminFilter, AdminRow, DeviceRow, Expectation, GuardedWrite, Repo } from './db.ts';
import type { ExportKind, ReportFilter, ReportInput } from './reports.ts';
import { EXPORT_KINDS, exportCsv, localDate, payloads, summary, validTimeZone } from './reports.ts';
import { Repo as RepoClass } from './db.ts';
import { scopeFields } from './rules.ts';
import type { Entity, Session } from './types.ts';
import { ApiError, ENTITIES, VEHICLE_CHILDREN } from './types.ts';
import { APPLE_EPOCH_OFFSET, badRequest, intParam, isObject, msToApple, normalizeUuid, nowMs } from './util.ts';

/** 單筆內容上限（與事件相同）。 */
const MAX_PAYLOAD = 1024 * 1024;
/** 詳情頁每種關聯資料最多列出的筆數（另回傳總數）。 */
const RELATED_LIMIT = 20;
/** 依時間對應的關聯（巡檢、工單與車趟）：前後 1 天。 */
const DAY = 86400;

const isEntity = (v: unknown): v is Entity => typeof v === 'string' && (ENTITIES as readonly string[]).includes(v);

function entityParam(raw: string | null): Entity {
  if (!isEntity(raw)) throw badRequest('entity 不正確');
  return raw;
}

function revisionParam(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw badRequest('expectedRevision 必須是非負整數');
  return v;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 依規格的預設排序取前幾筆（關聯資料）。 */
function relatedOf(entity: Entity, rows: Parsed[], names: Map<string, string>) {
  const es = spec(entity);
  const page = query(entity, rows, {
    terms: [], from: null, to: null, status: null, sort: es.defaultSort, order: es.defaultOrder, limit: RELATED_LIMIT, offset: 0,
  });
  return { entity, total: page.total, records: page.page.map((p) => recordJson(p.row, names)) };
}

function deviceBrief(d: DeviceRow) {
  return {
    deviceId: d.device_id,
    name: d.name,
    platform: d.platform,
    role: d.role,
    lastSeenAt: d.last_seen_at === null ? null : Number(d.last_seen_at),
    revokedAt: d.revoked_at === null ? null : Number(d.revoked_at),
  };
}

export class AdminApi {
  repo: Repo;
  session: Session;

  constructor(repo: Repo, session: Session) {
    this.repo = repo;
    this.session = session;
  }

  private get actor() {
    return { identity: this.session.identity, deviceId: this.session.deviceId, name: this.session.deviceName };
  }

  schema() {
    return ADMIN_SPEC;
  }

  private async names(): Promise<Map<string, string>> {
    return new Map((await this.repo.listDevices()).map((d) => [d.device_id, d.name]));
  }

  private async parsed(entity: Entity, f: AdminFilter): Promise<Parsed[]> {
    const out: Parsed[] = [];
    for (const row of await this.repo.adminRows(entity, f)) {
      const payload = parsePayload(row.payload);
      if (payload) out.push({ row, payload });
    }
    return out;
  }

  private async liveRow(entity: Entity, rawId: string): Promise<{ row: AdminRow; payload: Record<string, unknown> }> {
    const id = normalizeUuid(rawId);
    if (!id) throw badRequest('id 必須是 UUID');
    const row = await this.repo.adminRow(entity, id);
    const payload = row && Number(row.deleted) === 0 ? parsePayload(row.payload) : null;
    if (!row || !payload) throw new ApiError(404, 'not_found', '找不到這筆資料（可能已被刪除）');
    return { row, payload };
  }

  private async driverById(id: string): Promise<{ uuid: string; name: string } | null> {
    const row = await this.repo.adminRow('driver', id);
    const p = row && Number(row.deleted) === 0 ? parsePayload(row.payload) : null;
    return p ? { uuid: id, name: typeof p.name === 'string' ? p.name : '' } : null;
  }

  /** 這個車牌的有效車輛（車牌逐字相同）。 */
  private async vehicleByPlate(plate: string): Promise<Parsed | null> {
    const rows = await this.parsed('vehicle', { plate });
    return rows.find((r) => r.payload.plateNumber === plate) ?? null;
  }

  private conflict(row: AdminRow, names: Map<string, string>): never {
    throw new ApiError(409, 'revision_mismatch', '這筆資料已被其他裝置修改，請重新載入後再修改', undefined, { current: recordJson(row, names) });
  }

  // ───────── 查詢 ─────────

  async list(url: URL) {
    const entity = entityParam(url.searchParams.get('entity'));
    const es = spec(entity);
    const p = url.searchParams;
    const q = p.get('q');
    if (q !== null && cpLength(q) > 100) throw badRequest('q 最多 100 個字');
    const status = p.get('status');
    if (status !== null && status !== '' && !Object.prototype.hasOwnProperty.call(es.statuses, status)) throw badRequest('status 不正確');
    const sort = p.get('sort') || es.defaultSort;
    if (!Object.prototype.hasOwnProperty.call(es.sorts, sort)) throw badRequest('sort 不正確');
    const orderRaw = p.get('order');
    if (orderRaw !== null && orderRaw !== '' && orderRaw !== 'asc' && orderRaw !== 'desc') throw badRequest('order 必須是 asc 或 desc');
    const timeParam = (key: string): number | null => {
      const raw = p.get(key);
      if (raw === null || raw === '') return null;
      return intParam(url, key, 0, 0, Number.MAX_SAFE_INTEGER) / 1000 - APPLE_EPOCH_OFFSET;
    };
    const params: QueryParams = {
      terms: searchTerms(q),
      from: timeParam('from'),
      to: timeParam('to'),
      status: status === null || status === '' ? null : status,
      sort,
      order: (orderRaw === 'asc' || orderRaw === 'desc' ? orderRaw : es.defaultOrder),
      limit: intParam(url, 'limit', 50, 1, 200),
      offset: intParam(url, 'offset', 0, 0, 1000000),
    };

    const filter: AdminFilter = {};
    const plate = p.get('plate');
    if (plate !== null && plate !== '') filter.plate = plate;
    let requester: string | null = null;
    const driverRaw = p.get('driverId');
    if (driverRaw !== null && driverRaw !== '') {
      const id = normalizeUuid(driverRaw);
      if (!id) throw badRequest('driverId 必須是 UUID');
      const d = await this.driverById(id);
      if (!d) throw new ApiError(404, 'not_found', '找不到這位駕駛人');
      if (entity === 'trip') filter.driverOwn = d;
      else if (entity === 'inspection') filter.driverName = d.name === '' ? '\u0000' : d.name;
      else if (entity === 'tripRequest') requester = d.name;
      else throw badRequest('driverId 只能用於車趟、巡檢與用車申請');
    }
    const deviceRaw = p.get('deviceId');
    if (deviceRaw !== null && deviceRaw !== '') {
      const id = normalizeUuid(deviceRaw);
      if (!id) throw badRequest('deviceId 必須是 UUID');
      const d = await this.repo.deviceById(id);
      if (!d) throw new ApiError(404, 'not_found', '找不到這台裝置');
      filter.createdBy = d.identity ?? '\u0000';
    }
    let rows = await this.parsed(entity, filter);
    if (filter.plate) rows = rows.filter((r) => r.row.vehicle_plate === filter.plate);
    if (requester !== null) rows = rows.filter((r) => requester !== '' && r.payload.requestedBy === requester);
    const result = query(entity, rows, params);
    const names = await this.names();
    return {
      entity,
      total: result.total,
      offset: params.offset,
      limit: params.limit,
      records: result.page.map((r) => recordJson(r.row, names)),
    };
  }

  async detail(entityRaw: string, rawId: string) {
    const entity = entityParam(entityRaw);
    const id = normalizeUuid(rawId);
    if (!id) throw badRequest('id 必須是 UUID');
    const row = await this.repo.adminRow(entity, id);
    if (!row) throw new ApiError(404, 'not_found', '找不到這筆資料');
    const names = await this.names();
    const record = recordJson(row, names);
    const payload = record.payload;
    const related: Record<string, unknown> = {};
    let location: unknown = null;
    if (payload) {
      await this.related(entity, id, payload, names, related);
      if (entity === 'trip') {
        const l = await this.repo.locationOf(id);
        if (l) {
          location = {
            latitude: Number(l.latitude), longitude: Number(l.longitude), speed: l.speed === null ? null : Number(l.speed),
            course: l.course === null ? null : Number(l.course), timestamp: Number(l.ts), deviceName: l.device_name,
            stale: nowMs() - Number(l.updated_at) > 300 * 1000,
          };
        }
      }
    }
    return { record, related, location };
  }

  /** 詳情頁的關聯資料（規則見 docs/admin-management.md「關聯」）。 */
  private async related(entity: Entity, id: string, p: Record<string, unknown>, names: Map<string, string>, out: Record<string, unknown>) {
    const plateOf = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    const byPlate = async (e: Entity, plate: string) => (await this.parsed(e, { plate })).filter((r) => r.row.vehicle_plate === plate);
    const nowApple = msToApple(nowMs());
    switch (entity) {
      case 'vehicle': {
        const plate = plateOf(p.plateNumber);
        if (!plate) break;
        out.trips = relatedOf('trip', await byPlate('trip', plate), names);
        out.maintenance = relatedOf('maintenance', await byPlate('maintenance', plate), names);
        out.maintenanceItems = relatedOf('maintenanceItem', await byPlate('maintenanceItem', plate), names);
        out.workOrders = relatedOf('workOrder', await byPlate('workOrder', plate), names);
        out.inspections = relatedOf('inspection', await byPlate('inspection', plate), names);
        out.tripRequests = relatedOf('tripRequest', (await this.parsed('tripRequest', {})).filter((r) => r.payload.vehiclePlateNumber === plate), names);
        break;
      }
      case 'driver': {
        const name = typeof p.name === 'string' ? p.name : '';
        out.trips = relatedOf('trip', await this.parsed('trip', { driverOwn: { uuid: id, name } }), names);
        out.inspections = relatedOf('inspection', name === '' ? [] : await this.parsed('inspection', { driverName: name }), names);
        out.tripRequests = relatedOf('tripRequest', name === '' ? [] : (await this.parsed('tripRequest', {})).filter((r) => r.payload.requestedBy === name), names);
        out.devices = (await this.repo.devicesBoundTo(id)).map(deviceBrief);
        break;
      }
      case 'trip': {
        const plate = plateOf(p.vehiclePlateNumber);
        const start = finite(p.startTime);
        const end = p.isCompleted === true ? finite(p.endTime) : nowApple;
        if (plate) {
          const v = await this.vehicleByPlate(plate);
          out.vehicles = relatedOf('vehicle', v ? [v] : [], names);
          if (start !== null && end !== null) {
            const lo = start - DAY;
            const hi = Math.max(start, end) + DAY;
            out.inspections = relatedOf('inspection', (await byPlate('inspection', plate)).filter((r) => {
              const t = finite(r.payload.date);
              return t !== null && t >= lo && t <= hi;
            }), names);
            out.workOrders = relatedOf('workOrder', (await byPlate('workOrder', plate)).filter((r) => {
              const opened = finite(r.payload.openedAt);
              const closed = finite(r.payload.closedAt);
              return opened !== null && opened <= hi && (closed === null || closed >= lo);
            }), names);
          }
        }
        const driverId = typeof p.driverEntityUUID === 'string' ? normalizeUuid(p.driverEntityUUID) : null;
        const drivers: Parsed[] = [];
        if (driverId) {
          const row = await this.repo.adminRow('driver', driverId);
          const dp = row && Number(row.deleted) === 0 ? parsePayload(row.payload) : null;
          if (row && dp) drivers.push({ row, payload: dp });
        } else if (typeof p.driver === 'string' && p.driver !== '') {
          drivers.push(...(await this.parsed('driver', {})).filter((r) => r.payload.name === p.driver));
        }
        out.drivers = relatedOf('driver', drivers, names);
        out.tripRequests = relatedOf('tripRequest', (await this.parsed('tripRequest', {})).filter((r) =>
          typeof r.payload.resultingTripUUID === 'string' && r.payload.resultingTripUUID.toUpperCase() === id), names);
        break;
      }
      case 'tripRequest': {
        const tripId = typeof p.resultingTripUUID === 'string' ? normalizeUuid(p.resultingTripUUID) : null;
        const trips: Parsed[] = [];
        if (tripId) {
          const row = await this.repo.adminRow('trip', tripId);
          const tp = row && Number(row.deleted) === 0 ? parsePayload(row.payload) : null;
          if (row && tp) trips.push({ row, payload: tp });
        }
        out.trips = relatedOf('trip', trips, names);
        const plate = plateOf(p.vehiclePlateNumber);
        const v = plate ? await this.vehicleByPlate(plate) : null;
        out.vehicles = relatedOf('vehicle', v ? [v] : [], names);
        const deviceId = typeof p.requestedByDeviceID === 'string' ? normalizeUuid(p.requestedByDeviceID) : null;
        const d = deviceId ? await this.repo.deviceById(deviceId) : null;
        out.devices = d ? [deviceBrief(d)] : [];
        break;
      }
      case 'workOrder': {
        const plate = plateOf(p.vehiclePlateNumber);
        const v = plate ? await this.vehicleByPlate(plate) : null;
        out.vehicles = relatedOf('vehicle', v ? [v] : [], names);
        const ids = new Set<string>();
        for (const l of Array.isArray(p.lines) ? p.lines : []) {
          if (isObject(l) && typeof l.partEntityUUID === 'string') ids.add(l.partEntityUUID.toUpperCase());
        }
        out.parts = relatedOf('part', (await this.parsed('part', {})).filter((r) => ids.has(r.row.id)), names);
        break;
      }
      case 'part': {
        out.workOrders = relatedOf('workOrder', (await this.parsed('workOrder', {})).filter((r) =>
          (Array.isArray(r.payload.lines) ? r.payload.lines : []).some((l) =>
            isObject(l) && typeof l.partEntityUUID === 'string' && l.partEntityUUID.toUpperCase() === id)), names);
        break;
      }
      case 'inspection': {
        const plate = plateOf(p.vehiclePlateNumber);
        const v = plate ? await this.vehicleByPlate(plate) : null;
        out.vehicles = relatedOf('vehicle', v ? [v] : [], names);
        const name = typeof p.driverName === 'string' ? p.driverName : '';
        out.drivers = relatedOf('driver', name === '' ? [] : (await this.parsed('driver', {})).filter((r) => r.payload.name === name), names);
        const date = finite(p.date);
        out.trips = relatedOf('trip', plate && date !== null ? (await byPlate('trip', plate)).filter((r) => {
          const t = finite(r.payload.startTime);
          return t !== null && t >= date - DAY && t <= date + DAY;
        }) : [], names);
        break;
      }
      case 'maintenance':
      case 'maintenanceItem': {
        const plate = plateOf(p.vehiclePlateNumber);
        const v = plate ? await this.vehicleByPlate(plate) : null;
        out.vehicles = relatedOf('vehicle', v ? [v] : [], names);
        break;
      }
      default:
        break;
    }
  }

  // ───────── 受控編輯 ─────────

  async edit(entityRaw: string, rawId: string, body: Record<string, unknown>) {
    const entity = entityParam(entityRaw);
    if (entity === 'tripRequest') throw badRequest('用車申請請用核准或退回');
    const expected = revisionParam(body.expectedRevision);
    const dryRun = body.dryRun === true;
    const reason = cleanReason(body.reason);
    if (!dryRun && reason === null) throw badRequest('reason（修改原因）必須是 1–500 個字');
    const names = await this.names();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { row, payload } = await this.liveRow(entity, rawId);
      if (Number(row.revision) !== expected) this.conflict(row, names);
      const modifiedAt = Math.max(msToApple(nowMs()), Number(row.modified_at) + 0.001);
      const r = applyChanges(entity, payload, body.changes, modifiedAt);
      if (Object.keys(r.errors).length === 0 && r.plate !== null) {
        if (!(await this.vehicleByPlate(r.plate))) r.errors.vehiclePlateNumber = '找不到這個車牌的車輛';
      }
      if (Object.keys(r.errors).length === 0 && r.driverId !== null) {
        const d = await this.driverById(r.driverId);
        if (!d) r.errors.driverEntityUUID = '找不到這位駕駛人';
        else r.after.driver = d.name;
      }
      if (Object.keys(r.errors).length > 0) {
        throw new ApiError(400, 'invalid_changes', '修改的內容不正確', undefined, { fields: r.errors });
      }
      const changed = changedFields(payload, r.after);
      if (dryRun) {
        return { dryRun: true, revision: Number(row.revision), before: payload, after: r.after, changedFields: changed, warnings: r.warnings };
      }
      const payloadText = JSON.stringify(r.after);
      if (payloadText.length > MAX_PAYLOAD) throw new ApiError(413, 'payload_too_large', '內容超過 1 MB');
      const completed = entity === 'trip' && r.after.isCompleted === true && payload.isCompleted !== true;
      const ok = await this.repo.writeAll({
        expect: [{ entity, id: row.id, seq: Number(row.seq), live: true }],
        writes: [{
          entity, id: row.id, operation: 'update', payloadText, modifiedAt, fields: scopeFields(entity, r.after), actor: this.actor,
          source: 'web', eventId: null, reason, nextRevision: Number(row.revision) + 1, changedFields: changed,
          auditSummary: auditSummary(entity, payloadText),
        }],
        extra: completed ? [{ sql: 'DELETE FROM fd_locations WHERE trip_id = ?', params: [row.id] }] : [],
        now: nowMs(),
      });
      if (!ok) continue;
      const fresh = await this.repo.adminRow(entity, row.id);
      return { record: recordJson(fresh!, names), changedFields: changed, warnings: r.warnings };
    }
    const { row } = await this.liveRow(entity, rawId);
    this.conflict(row, names);
  }

  // ───────── 刪除 ─────────

  async impact(entityRaw: string, rawId: string) {
    const entity = entityParam(entityRaw);
    const { row, payload } = await this.liveRow(entity, rawId);
    const blockers: { code: string; message: string; count: number }[] = [];
    let cascade: Record<string, number> = {};
    const references: Record<string, number> = {};
    if (entity === 'vehicle') {
      const plate = typeof payload.plateNumber === 'string' && payload.plateNumber !== '' ? payload.plateNumber : null;
      if (plate && row.vehicle_plate === plate) {
        cascade = await this.repo.childCounts(plate, VEHICLE_CHILDREN);
        const active = await this.repo.activeTripsOfPlate(plate);
        if (active > 0) blockers.push({ code: 'vehicle-has-active-trips', message: '這台車還有出車中的車趟，請先回車', count: active });
      }
    } else if (entity === 'driver') {
      const name = typeof payload.name === 'string' ? payload.name : '';
      references.trips = (await this.repo.adminRows('trip', { driverOwn: { uuid: row.id, name } })).length;
      references.devices = (await this.repo.devicesBoundTo(row.id)).length;
    } else if (entity === 'part') {
      references.workOrders = (await this.parsed('workOrder', {})).filter((r) =>
        (Array.isArray(r.payload.lines) ? r.payload.lines : []).some((l) =>
          isObject(l) && typeof l.partEntityUUID === 'string' && l.partEntityUUID.toUpperCase() === row.id)).length;
    }
    return { entity, id: row.id, revision: Number(row.revision), blockers, cascade, references };
  }

  async remove(entityRaw: string, rawId: string, body: Record<string, unknown>) {
    const entity = entityParam(entityRaw);
    const expected = revisionParam(body.expectedRevision);
    const reason = cleanReason(body.reason);
    if (reason === null) throw badRequest('reason（刪除原因）必須是 1–500 個字');
    const names = await this.names();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { row, payload } = await this.liveRow(entity, rawId);
      if (Number(row.revision) !== expected) this.conflict(row, names);
      const now = nowMs();
      const at = Math.max(msToApple(now), Number(row.modified_at) + 0.001);
      const conditions = [];
      let cascade = null;
      let counts: Record<string, number> = {};
      if (entity === 'vehicle') {
        const plate = typeof payload.plateNumber === 'string' && payload.plateNumber !== '' && row.vehicle_plate === payload.plateNumber
          ? payload.plateNumber : null;
        if (plate) {
          const active = await this.repo.activeTripsOfPlate(plate);
          if (active > 0) throw new ApiError(409, 'vehicle_has_active_trips', '這台車還有出車中的車趟，請先回車再刪除');
          counts = await this.repo.childCounts(plate, VEHICLE_CHILDREN);
          const expectedCascade = body.expectedCascade;
          if (!isObject(expectedCascade)) throw badRequest('請先預覽刪除的影響範圍（expectedCascade）');
          const same = VEHICLE_CHILDREN.every((e) => expectedCascade[e] === counts[e]);
          if (!same) {
            throw new ApiError(409, 'impact_changed', '刪除的影響範圍已經改變，請重新預覽', undefined, { cascade: counts });
          }
          const total = VEHICLE_CHILDREN.reduce((n, e) => n + counts[e], 0);
          conditions.push(RepoClass.noActiveTrips(plate), RepoClass.childCountIs(plate, VEHICLE_CHILDREN, total));
          cascade = { plate, entities: VEHICLE_CHILDREN, at, actor: this.actor };
        }
      }
      const ok = await this.repo.writeAll({
        expect: [{ entity, id: row.id, seq: Number(row.seq), live: true }],
        conditions,
        writes: [{
          entity, id: row.id, operation: 'delete', payloadText: null, modifiedAt: at, fields: scopeFields(entity, payload), actor: this.actor,
          source: 'web', eventId: null, reason, nextRevision: Number(row.revision) + 1, changedFields: null, auditSummary: '',
        }],
        cascade,
        extra: entity === 'trip' ? [{ sql: 'DELETE FROM fd_locations WHERE trip_id = ?', params: [row.id] }] : [],
        now,
      });
      if (!ok) continue;
      return { deleted: { entity, id: row.id, revision: Number(row.revision) + 1 }, cascade: counts };
    }
    throw new ApiError(503, 'busy', '主機忙碌，請稍後再試', 1);
  }

  // ───────── 報表（docs/reports.md） ─────────

  /** 報表的篩選條件：期間（毫秒，含 from、不含 to，最多 400 天）、時區、車牌、駕駛（driverId 或姓名）、成本中心。 */
  private async reportFilter(url: URL): Promise<ReportFilter> {
    const p = url.searchParams;
    if (!p.get('from') || !p.get('to')) throw badRequest('需要 from 與 to（1970 起算的毫秒）');
    const from = intParam(url, 'from', 0, 0, Number.MAX_SAFE_INTEGER);
    const to = intParam(url, 'to', 0, 0, Number.MAX_SAFE_INTEGER);
    if (to <= from) throw badRequest('to 必須晚於 from');
    if (to - from > 400 * 86400 * 1000) throw badRequest('期間最多 400 天');
    const tz = p.get('tz') || 'UTC';
    if (!validTimeZone(tz)) throw badRequest('tz 必須是時區名稱（例如 Asia/Taipei）');
    const plate = p.get('plate');
    let driver = p.get('driver');
    const driverRaw = p.get('driverId');
    if (driverRaw !== null && driverRaw !== '') {
      const id = normalizeUuid(driverRaw);
      if (!id) throw badRequest('driverId 必須是 UUID');
      const d = await this.driverById(id);
      if (!d) throw new ApiError(404, 'not_found', '找不到這位駕駛人');
      driver = d.name;
    }
    return {
      from, to, tz,
      plate: plate === null || plate === '' ? null : plate,
      driver: driver === null || driver === '' ? null : driver,
      costCenter: p.get('costCenter'),
    };
  }

  private async reportInput(): Promise<ReportInput> {
    const rows = async (e: Entity) => payloads(await this.repo.adminRows(e, {}));
    const drivers: ReportInput['drivers'] = [];
    for (const r of await this.repo.adminRows('driver', {})) {
      const payload = parsePayload(r.payload);
      if (payload) drivers.push({ id: r.id, payload });
    }
    return {
      trips: await rows('trip'), vehicles: await rows('vehicle'), drivers, maintenance: await rows('maintenance'),
      workOrders: await rows('workOrder'), inspections: await rows('inspection'), now: nowMs(),
    };
  }

  async reportSummary(url: URL) {
    const f = await this.reportFilter(url);
    return summary(await this.reportInput(), f);
  }

  /** CSV 匯出：`{ filename, body }`（呼叫端以 text/csv 回應）。 */
  async reportExport(url: URL): Promise<{ filename: string; body: string }> {
    const kind = url.searchParams.get('kind');
    if (!(EXPORT_KINDS as readonly (string | null)[]).includes(kind)) throw badRequest('kind 必須是 trips、maintenance、workOrders 或 inspections');
    const f = await this.reportFilter(url);
    const body = exportCsv(kind as ExportKind, await this.reportInput(), f);
    const last = localDate(f.to - 1, f.tz);
    const filename = `FleetDispatch_${kind}_${localDate(f.from, f.tz)}_${last}${f.plate ? '_' + f.plate : ''}.csv`;
    return { filename, body };
  }

  // ───────── 用車申請的簽核 ─────────

  async decide(rawId: string, action: 'approve' | 'reject', body: Record<string, unknown>) {
    const expected = revisionParam(body.expectedRevision);
    const names = await this.names();
    let rejection: string | null = null;
    let note: string | null = null;
    if (action === 'reject') {
      rejection = cleanReason(body.rejectionReason);
      if (rejection === null) throw badRequest('rejectionReason（退回原因）必須是 1–500 個字');
    } else if (body.note !== undefined && body.note !== null && body.note !== '') {
      note = cleanReason(body.note);
      if (note === null) throw badRequest('note 最多 500 個字');
    }
    let driver: { uuid: string; name: string } | null = null;
    if (action === 'approve' && body.driverId !== undefined && body.driverId !== null && body.driverId !== '') {
      const id = normalizeUuid(body.driverId);
      if (!id) throw badRequest('driverId 必須是 UUID');
      driver = await this.driverById(id);
      if (!driver) throw badRequest('找不到這位駕駛人');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const { row, payload } = await this.liveRow('tripRequest', rawId);
      if (Number(row.revision) !== expected) this.conflict(row, names);
      if (payload.status !== 'pending') throw new ApiError(409, 'request_not_pending', '這筆申請已經處理過了');
      const now = nowMs();
      const at = Math.max(msToApple(now), Number(row.modified_at) + 0.001);
      const approver = this.session.deviceName;
      const updated: Record<string, unknown> = { ...payload, status: action === 'approve' ? 'approved' : 'rejected', approvedAt: at, approvedBy: approver };
      if (rejection !== null) updated.rejectionReason = rejection;
      const writes: GuardedWrite[] = [];
      const expect: Expectation[] = [{ entity: 'tripRequest', id: row.id, seq: Number(row.seq), live: true }];
      let tripId: string | null = null;
      if (action === 'approve') {
        const plateRaw = typeof payload.vehiclePlateNumber === 'string' && payload.vehiclePlateNumber !== '' ? payload.vehiclePlateNumber : null;
        const vehicle = plateRaw ? await this.vehicleByPlate(plateRaw) : null;
        const plate = vehicle ? plateRaw : null;
        let odometerStart = 0;
        if (plate) {
          let best: number | null = null;
          for (const t of await this.parsed('trip', { plate })) {
            if (t.row.vehicle_plate !== plate || t.payload.isCompleted !== true) continue;
            const end = finite(t.payload.endTime);
            const odo = finite(t.payload.odometerEnd);
            if (end !== null && odo !== null && (best === null || end > best)) {
              best = end;
              odometerStart = odo;
            }
          }
        }
        tripId = crypto.randomUUID().toUpperCase();
        updated.resultingTripUUID = tripId;
        const trip = tripFromRequest(payload, tripId, plate, odometerStart, driver, at);
        const tripText = JSON.stringify(trip);
        expect.push({ entity: 'trip', id: tripId, seq: null, live: false });
        writes.push({
          entity: 'trip', id: tripId, operation: 'create', payloadText: tripText, modifiedAt: at, fields: scopeFields('trip', trip),
          actor: this.actor, source: 'web', eventId: null, reason: note ?? '核准用車申請', nextRevision: 1,
          changedFields: changedFields(null, trip), auditSummary: auditSummary('trip', tripText),
        });
      }
      updated.lastModifiedAt = at;
      const text = JSON.stringify(updated);
      writes.push({
        entity: 'tripRequest', id: row.id, operation: 'update', payloadText: text, modifiedAt: at,
        fields: scopeFields('tripRequest', updated), actor: this.actor, source: 'web', eventId: null,
        reason: action === 'approve' ? note ?? '核准用車申請' : rejection, nextRevision: Number(row.revision) + 1,
        changedFields: changedFields(payload, updated), auditSummary: auditSummary('tripRequest', text),
      });
      const ok = await this.repo.writeAll({ expect, writes, now });
      if (!ok) continue;
      const request = recordJson((await this.repo.adminRow('tripRequest', row.id))!, names);
      const trip = tripId ? recordJson((await this.repo.adminRow('trip', tripId))!, names) : null;
      return { request, trip };
    }
    const { row } = await this.liveRow('tripRequest', rawId);
    this.conflict(row, names);
  }
}
