// 寫入授權、讀取範圍與遮蔽（規格：docs/protocol.md §2、§5）。純函式，三種實作的行為以這裡為準。

import type { DriverBinding, Entity, Operation, Role, ScopeFields, Session, StoredRecord } from './types.ts';
import { ENTITIES, OPERATIONS } from './types.ts';
import { isObject, normalizeUuid, num, str } from './util.ts';

export const isEntity = (v: unknown): v is Entity => typeof v === 'string' && (ENTITIES as readonly string[]).includes(v);
export const isOperation = (v: unknown): v is Operation =>
  typeof v === 'string' && (OPERATIONS as readonly string[]).includes(v);

const upper = (v: unknown): string | null => {
  const s = str(v);
  return s === null || s === '' ? null : s.toUpperCase();
};

/** 從資料內容取出查詢欄位（車牌、駕駛人、申請裝置）。 */
export function scopeFields(entity: Entity, payload: Record<string, unknown>): ScopeFields {
  const out: ScopeFields = { driverUuid: null, driverName: null, requesterDevice: null, vehiclePlate: null };
  switch (entity) {
    case 'trip':
      out.driverUuid = upper(payload.driverEntityUUID);
      out.driverName = str(payload.driver);
      out.vehiclePlate = str(payload.vehiclePlateNumber);
      break;
    case 'inspection':
      out.driverName = str(payload.driverName);
      out.vehiclePlate = str(payload.vehiclePlateNumber);
      break;
    case 'tripRequest':
      out.requesterDevice = upper(payload.requestedByDeviceID);
      break;
    case 'maintenance':
    case 'maintenanceItem':
    case 'workOrder':
      out.vehiclePlate = str(payload.vehiclePlateNumber);
      break;
    case 'vehicle':
      out.vehiclePlate = str(payload.plateNumber);
      break;
    default:
      break;
  }
  return out;
}

/** 「自己的車趟」：有駕駛人 UUID 時比對綁定的 UUID，沒有時比對姓名（非空字串）。 */
export function isOwnTrip(fields: Pick<ScopeFields, 'driverUuid' | 'driverName'>, binding: DriverBinding | null): boolean {
  if (!binding) return false;
  if (fields.driverUuid) return fields.driverUuid === binding.driverUuid.toUpperCase();
  return binding.driverName !== '' && fields.driverName === binding.driverName;
}

export type Decision = { allow: true } | { allow: false; reason: string };
const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

const blank = (v: unknown): boolean => v === undefined || v === null || v === '';

function hasNoDecision(p: Record<string, unknown>): boolean {
  return (p.approvedAt === undefined || p.approvedAt === null) && blank(p.approvedBy) && blank(p.rejectionReason) && blank(p.resultingTripUUID);
}

/** 一筆事件的寫入授權。`existing` 是主機上現存的版本（含墓碑：駕駛不能藉由重新建立復活別人的資料）。 */
export function authorize(
  session: Session,
  entity: Entity,
  op: Operation,
  incoming: Record<string, unknown> | null,
  existing: StoredRecord | null,
): Decision {
  const role: Role = session.role;
  const live = existing && !existing.deleted ? existing : null;
  if (role === 'admin') return ALLOW;
  if (role === 'viewer') return deny('role');

  // 以下是駕駛。主機的寫入是「有就更新、沒有就建立」：主機上已有這筆（含墓碑，保留查詢欄位與建立裝置）時，
  // 不論事件標示 create 或 update，一律依修改的規則檢查（不能用 create 覆寫或復活別人的資料）。
  const rec = existing;
  const mine = rec !== null && rec.createdBy === session.identity;
  const named = session.binding !== null && session.binding.driverName !== '';
  switch (entity) {
    case 'trip': {
      if (op === 'delete') return deny('role');
      if (!session.binding) return !rec || mine ? ALLOW : deny('not-own-trip');
      // 已綁定：新建立的車趟也必須是自己的（不能替別的駕駛建立）。
      if (!incoming || !isOwnTrip(scopeFields('trip', incoming), session.binding)) return deny('not-own-trip');
      return !rec || isOwnTrip(rec, session.binding) ? ALLOW : deny('not-own-trip');
    }
    case 'inspection': {
      if (op === 'delete') return deny('role');
      if (!session.binding) return !rec || mine ? ALLOW : deny('not-own-inspection');
      // 綁定的姓名是空字串時不認任何巡檢（否則會「擁有」所有駕駛人姓名空白的巡檢）。
      if (!named || !incoming || str(incoming.driverName) !== session.binding.driverName) return deny('not-own-inspection');
      return !rec || rec.driverName === session.binding.driverName ? ALLOW : deny('not-own-inspection');
    }
    case 'tripRequest': {
      if (op === 'delete') return deny('only-admin-can-delete');
      if (!incoming) return deny('invalid-payload');
      const me = session.deviceId.toUpperCase();
      if (op === 'create') {
        if (rec) return deny('request-already-exists');
        if (incoming.status !== 'pending') return deny('create-must-be-pending');
        if (!hasNoDecision(incoming)) return deny('approval-fields-not-allowed');
        if (upper(incoming.requestedByDeviceID) !== me) return deny('requester-mismatch');
        return ALLOW;
      }
      if (!live || !live.payload) return deny('request-not-found');
      // 修改：必須是這次配對建立的申請（重新配對不繼承），且不能改申請人。
      if (live.createdBy !== session.identity || upper(incoming.requestedByDeviceID) !== live.requesterDevice) return deny('not-own-request');
      if (live.payload.status !== 'pending') return deny('request-not-pending');
      if (incoming.status !== 'pending' && incoming.status !== 'cancelled') return deny('status-transition-not-allowed');
      if (!hasNoDecision(incoming)) return deny('approval-fields-not-allowed');
      return ALLOW;
    }
    default:
      return deny('role');
  }
}

/** 讀取範圍：這筆資料（或墓碑）能不能給這台裝置。 */
export function visible(session: Session, rec: Pick<StoredRecord, 'entity' | 'driverUuid' | 'driverName' | 'createdBy'>): boolean {
  if (session.role !== 'driver') return true;
  switch (rec.entity) {
    case 'trip':
      return isOwnTrip(rec, session.binding);
    case 'tripRequest':
      // 駕駛只看得到這次配對建立的申請（以主機端身分判斷，不以用戶端自報的裝置 ID）。
      return rec.createdBy === session.identity;
    case 'inspection':
      return session.binding !== null && session.binding.driverName !== '' && rec.driverName === session.binding.driverName;
    default:
      return true;
  }
}

/** 駕駛人的個資遮蔽：證號、電話、備註改為空字串，移除證照到期日。 */
export function redactDriver(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload, licenseNumber: '', phoneNumber: '', notes: '' };
  delete out.licenseExpiryDate;
  return out;
}

/** 給這台裝置的內容（必要時遮蔽駕駛人）。 */
export function outgoingPayload(session: Session, entity: Entity, id: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (entity !== 'driver' || session.role === 'admin') return payload;
  if (session.role === 'driver' && session.binding && session.binding.driverUuid.toUpperCase() === id) return payload;
  return redactDriver(payload);
}

/** 解析並檢查一筆事件；不合法時回傳原因。 */
export function validateEvent(raw: unknown):
  | { ok: true; id: string; entity: Entity; op: Operation; entityId: string; timestamp: number; payload: Record<string, unknown> | null; payloadText: string }
  | { ok: false; id: string; reason: string } {
  const id = isObject(raw) && typeof raw.id === 'string' ? raw.id : '';
  if (!isObject(raw)) return { ok: false, id, reason: 'invalid-payload' };
  const entity = raw.entity;
  const op = raw.operation;
  const entityId = normalizeUuid(raw.entityID);
  const timestamp = num(raw.timestamp);
  if (!isEntity(entity) || !isOperation(op) || entityId === null || timestamp === null) return { ok: false, id, reason: 'invalid-payload' };
  const payloadText = typeof raw.payloadJSON === 'string' ? raw.payloadJSON : '';
  if (op === 'delete') return { ok: true, id, entity, op, entityId, timestamp, payload: null, payloadText: '' };
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { ok: false, id, reason: 'invalid-payload' };
  }
  if (!isObject(payload)) return { ok: false, id, reason: 'invalid-payload' };
  if (normalizeUuid(payload.entityUUID) !== entityId) return { ok: false, id, reason: 'invalid-payload' };
  if (num(payload.lastModifiedAt) === null) return { ok: false, id, reason: 'invalid-payload' };
  return { ok: true, id, entity, op, entityId, timestamp, payload, payloadText };
}

/** 綁定的駕駛人：`{driverUuid, driverName}`；`null` 表示清除；格式錯誤回傳 undefined。 */
export function parseBinding(v: unknown): DriverBinding | null | undefined {
  if (v === null) return null;
  if (!isObject(v)) return undefined;
  const id = normalizeUuid(v.driverUuid);
  const name = typeof v.driverName === 'string' ? v.driverName.trim() : null;
  if (id === null || name === null || name.length === 0 || name.length > 200) return undefined;
  return { driverUuid: id, driverName: name };
}
