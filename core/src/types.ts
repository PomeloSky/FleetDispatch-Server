// FleetDispatch Server API v1 的共用型別（規格：docs/protocol.md）。
// 只用可被 Node 直接去除的 TypeScript 語法（沒有 enum、namespace、參數屬性），Docker 版可直接執行 .ts。

export const ENTITIES = [
  'trip',
  'vehicle',
  'driver',
  'maintenance',
  'maintenanceItem',
  'preset',
  'tripRequest',
  'part',
  'workOrder',
  'inspection',
] as const;
export type Entity = (typeof ENTITIES)[number];

export const ROLES = ['admin', 'driver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const OPERATIONS = ['create', 'update', 'delete'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** 快照中各種類的陣列名稱（與 App 的 FullSyncSnapshot 相同）。 */
export const SNAPSHOT_KEYS: Record<Entity, string> = {
  trip: 'trips',
  vehicle: 'vehicles',
  driver: 'drivers',
  maintenance: 'maintenanceRecords',
  maintenanceItem: 'maintenanceItems',
  preset: 'presets',
  tripRequest: 'tripRequests',
  part: 'parts',
  workOrder: 'workOrders',
  inspection: 'inspections',
};

/** 刪除車輛時一併刪除的種類（依車牌）。 */
export const VEHICLE_CHILDREN: Entity[] = ['trip', 'maintenance', 'maintenanceItem', 'workOrder', 'inspection'];

export interface DriverBinding {
  driverUuid: string;
  driverName: string;
}

/** 已驗證的請求者。 */
export interface Session {
  deviceId: string;
  /** 主機在每次配對時產生的身分。擁有權（建立的車趟、巡檢、用車申請）以它為準：
   * 用戶端的 deviceId 由用戶端自己提供，權杖失效或解除配對後以同一個 deviceId 重新配對，不會繼承之前的擁有權。 */
  identity: string;
  deviceName: string;
  role: Role;
  binding: DriverBinding | null;
  tokenExpiresAt: number;
}

/** App 的同步事件（區網同步相同的形狀）。 */
export interface SyncEvent {
  id: string;
  timestamp: number;
  actor: string;
  entity: string;
  operation: string;
  entityID: string;
  payloadJSON: string;
}

/** 主機上的一筆資料（含墓碑）。 */
export interface StoredRecord {
  entity: Entity;
  id: string;
  seq: number;
  modifiedAt: number;
  deleted: boolean;
  payload: Record<string, unknown> | null;
  driverUuid: string | null;
  driverName: string | null;
  requesterDevice: string | null;
  vehiclePlate: string | null;
  /** 建立這筆資料的配對身分（Session.identity）：未綁定駕駛人的駕駛只能修改自己建立的車趟與巡檢，駕駛只看得到自己建立的用車申請。 */
  createdBy: string | null;
}

/** 從資料內容取出的查詢欄位。 */
export interface ScopeFields {
  driverUuid: string | null;
  driverName: string | null;
  requesterDevice: string | null;
  vehiclePlate: string | null;
}

export type EventStatus = 'applied' | 'ignored' | 'rejected';

export interface EventResult {
  id: string;
  status: EventStatus;
  reason?: string;
  event?: SyncEvent;
}

/** 部署環境提供的設定。 */
export interface ServerConfig {
  variant: 'cloudflare' | 'php' | 'docker';
  /** 第一次設定的設定碼（至少 16 字元）；沒有設定時為 null。 */
  setupToken: string | null;
  /** 第一次初始化時使用的伺服器名稱。 */
  defaultName: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
