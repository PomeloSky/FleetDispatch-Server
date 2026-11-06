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
  /** 以 Cookie 登入的網頁管理（1.2.0）；App 與 1.1 的網頁權杖（Authorization 標頭）是 null。 */
  web: WebSession | null;
}

/** 網頁管理的登入（docs/security-review.md §1）。 */
export interface WebSession {
  /** `session`：不記住這個瀏覽器；`remember`：記住。 */
  kind: 'session' | 'remember';
  /** 登入期限（不論是否使用，到期就要重新登入）。 */
  until: number;
  /** 非 GET 請求要放在 X-FleetDispatch-CSRF 標頭的值。 */
  csrf: string;
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
  /** 這筆資料的版本（1.2.0 起）：每次寫入（含刪除）加 1。用戶端可以在事件帶 `expectedRevision`，不一致時回傳 conflict。 */
  revision: number;
}

/** 從資料內容取出的查詢欄位。 */
export interface ScopeFields {
  driverUuid: string | null;
  driverName: string | null;
  requesterDevice: string | null;
  vehiclePlate: string | null;
}

/** `conflict`（1.2.0 起）只會回給帶了 `expectedRevision` 的事件；舊版 App 不帶，不會收到。 */
export type EventStatus = 'applied' | 'ignored' | 'rejected' | 'conflict';

export interface EventResult {
  id: string;
  status: EventStatus;
  reason?: string;
  event?: SyncEvent;
  /** 寫入後（applied）或目前（conflict）的版本（1.2.0 起）。 */
  revision?: number;
  /** conflict 時主機上目前的版本摘要。 */
  current?: { revision: number; modifiedAt: number; deleted: boolean };
  /** 這個事件之前已處理過，回傳的是第一次的結果（1.2.0 起）。 */
  duplicate?: boolean;
}

/** 寫入的來源（修改前後歷史）。 */
export type WriteSource = 'app' | 'web' | 'api' | 'cascade';

/** 部署環境提供的設定。 */
export interface ServerConfig {
  variant: 'cloudflare' | 'php' | 'docker';
  /** 第一次設定的設定碼（至少 16 字元）；沒有設定時為 null。 */
  setupToken: string | null;
  /** 第一次初始化時使用的伺服器名稱。 */
  defaultName: string;
  /** 網頁管理的網址路徑（例如 `/admin`）；`null` 表示關閉。 */
  adminPath: string | null;
  /** 修改前後歷史保留的天數（1.2.0）：0 是不自動刪除（預設）；否則至少 30 天（docs/audit-history.md §4）。 */
  historyRetentionDays: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  /** 錯誤的補充資料（1.2.0）：併入回應的 `error` 物件，例如欄位錯誤 `fields`、衝突時的 `current`。 */
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, retryAfter?: number, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}
