// 儲存層：Cloudflare D1 與 Node 內建 SQLite 共用同一套 SQL（SQLite 方言），經由 SqlDb 介面存取。
// 寫入資料一律「序號 +1」與「條件式寫入」放在同一個 batch（交易）中，最後寫入者勝由 SQL 保證，不怕並行請求交錯。

import type { DriverBinding, Entity, Role, ScopeFields, StoredRecord, WriteSource } from './types.ts';
import { ENTITIES } from './types.ts';
import { LEGACY_WEB_TTL_MS } from './web-session.ts';

export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

/** 部署環境提供的資料庫介面。`batch` 必須是原子操作（全部成功或全部回滾）。 */
export interface SqlDb {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  batch(statements: SqlStatement[]): Promise<{ changes: number }[]>;
}

/**
 * 資料表版本：1（1.0–1.1）、2（1.2.0：每筆資料的 revision、修改前後歷史、已處理事件）、
 * 3（1.2.0：網頁管理以 Cookie 登入的期限 fd_devices.web_session、session_until）。
 */
export const SCHEMA_VERSION = 3;

/** 1.2.0 新增的資料表（新安裝與從版本 1 遷移共用；都可重複執行）。 */
export const SCHEMA_V2_TABLES: string[] = [
  // 修改前後歷史：App、網頁管理、API、連鎖刪除的每一次寫入（新增、修改、刪除）。舊紀錄不覆寫。
  `CREATE TABLE IF NOT EXISTS fd_record_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
    event_id TEXT, operation TEXT NOT NULL, source TEXT NOT NULL,
    actor_device TEXT, actor_identity TEXT, actor_name TEXT,
    before_json TEXT, after_json TEXT, changed_fields TEXT, reason TEXT,
    seq INTEGER NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'applied')`,
  `CREATE INDEX IF NOT EXISTS fd_history_entity ON fd_record_history (entity, entity_id, id)`,
  `CREATE INDEX IF NOT EXISTS fd_history_seq ON fd_record_history (seq)`,
  `CREATE INDEX IF NOT EXISTS fd_history_at ON fd_record_history (at)`,
  // 已處理的事件：同一台裝置重送同一個事件時回傳第一次的結果，不重複套用（回應遺失後重送）。
  `CREATE TABLE IF NOT EXISTS fd_processed_events (
    device_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, result_json TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (device_id, event_id))`,
  `CREATE INDEX IF NOT EXISTS fd_processed_at ON fd_processed_events (at)`,
];

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS fd_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fd_records (
    entity TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, modified_at REAL NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, payload TEXT,
    driver_uuid TEXT, driver_name TEXT, requester_device TEXT, vehicle_plate TEXT,
    created_by TEXT, updated_by TEXT, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entity, id))`,
  `CREATE INDEX IF NOT EXISTS fd_records_seq ON fd_records (seq)`,
  `CREATE INDEX IF NOT EXISTS fd_records_plate ON fd_records (vehicle_plate)`,
  `CREATE TABLE IF NOT EXISTS fd_devices (
    device_id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
    driver_uuid TEXT, driver_name TEXT, token_hash TEXT, token_expires_at INTEGER,
    paired_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER, identity TEXT,
    web_session TEXT, session_until INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fd_devices_token ON fd_devices (token_hash)`,
  `CREATE TABLE IF NOT EXISTS fd_pairing_codes (
    id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, driver_uuid TEXT, driver_name TEXT,
    label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    used_at INTEGER, used_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS fd_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
    entity TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL, summary TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fd_locations (
    trip_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_name TEXT NOT NULL, plate TEXT,
    latitude REAL NOT NULL, longitude REAL NOT NULL, speed REAL, course REAL, ts REAL NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fd_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS fd_attempts_ip ON fd_attempts (ip, at)`,
  ...SCHEMA_V2_TABLES,
];

const BUMP_SEQ: SqlStatement = { sql: `UPDATE fd_meta SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'seq'` };
const CURRENT_SEQ = `(SELECT CAST(v AS INTEGER) FROM fd_meta WHERE k = 'seq')`;
/** 多筆寫入的守衛（writeAll）：同一個 batch 一開始檢查所有前提，成立時設為 1；之後每一句都以它為條件，最後改回 0。 */
const GUARD = `(SELECT v FROM fd_meta WHERE k = 'guard') = '1'`;
const CASCADE_BASE = `(SELECT CAST(v AS INTEGER) FROM fd_meta WHERE k = 'cascadeBase')`;
const HISTORY_COLUMNS = `at, entity, entity_id, event_id, operation, source, actor_device, actor_identity, actor_name,
  before_json, after_json, changed_fields, reason, seq, revision, outcome`;

export interface DeviceRow {
  device_id: string;
  name: string;
  platform: string;
  role: Role;
  driver_uuid: string | null;
  driver_name: string | null;
  token_hash: string | null;
  token_expires_at: number | null;
  paired_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  identity: string | null;
  /** 網頁管理以 Cookie 登入（`session`、`remember`）；App 與 1.1 的網頁權杖是 NULL。 */
  web_session: string | null;
  /** 網頁登入的期限（毫秒）。 */
  session_until: number | null;
}

export interface CodeRow {
  id: string;
  code_hash: string;
  role: Role;
  driver_uuid: string | null;
  driver_name: string | null;
  label: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface AuditRow {
  id: number;
  at: number;
  device_id: string;
  device_name: string;
  entity: string;
  entity_id: string;
  operation: string;
  summary: string;
}

export interface LocationRow {
  trip_id: string;
  device_id: string;
  device_name: string;
  plate: string | null;
  latitude: number;
  longitude: number;
  speed: number | null;
  course: number | null;
  ts: number;
  updated_at: number;
}

interface RecordRow {
  entity: string;
  id: string;
  seq: number;
  modified_at: number;
  deleted: number;
  payload: string | null;
  driver_uuid: string | null;
  driver_name: string | null;
  requester_device: string | null;
  vehicle_plate: string | null;
  created_by: string | null;
  revision: number;
}

const RECORD_COLUMNS = 'entity, id, seq, modified_at, deleted, payload, driver_uuid, driver_name, requester_device, vehicle_plate, created_by, revision';

/** 管理查詢用的資料列（含最後修改的裝置與時間）。 */
export interface AdminRow {
  entity: string;
  id: string;
  seq: number;
  modified_at: number;
  deleted: number;
  payload: string | null;
  driver_uuid: string | null;
  driver_name: string | null;
  requester_device: string | null;
  vehicle_plate: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: number;
  revision: number;
}

const ADMIN_COLUMNS = `${RECORD_COLUMNS}, updated_by, updated_at`;

/** 管理查詢的範圍條件（都有索引或資料列本身的欄位；其他條件在程式中判斷）。 */
export interface AdminFilter {
  plate?: string | null;
  /** 駕駛人的車趟：有駕駛人 UUID 時比對 UUID，沒有時比對姓名（與「自己的車趟」相同）。 */
  driverOwn?: { uuid: string; name: string } | null;
  driverName?: string | null;
  createdBy?: string | null;
}

/** 前提：這筆資料的序號沒有變（`live` 為 true 時也必須不是墓碑）；`seq` 為 null 表示主機上必須沒有這筆（含墓碑）。 */
export interface Expectation {
  entity: Entity;
  id: string;
  seq: number | null;
  live?: boolean;
}

/** writeAll 的一筆寫入（網頁管理與 App 的刪除）。前提由 Expectation 保證，寫入本身不再比較時間。 */
export interface GuardedWrite {
  entity: Entity;
  id: string;
  operation: 'create' | 'update' | 'delete';
  payloadText: string | null;
  modifiedAt: number;
  fields: ScopeFields;
  actor: { identity: string; deviceId: string; name: string };
  source: WriteSource;
  eventId: string | null;
  reason: string | null;
  nextRevision: number;
  changedFields: string[] | null;
  /** 稽核紀錄的摘要；null 表示不寫稽核紀錄。 */
  auditSummary: string | null;
}

/** 刪除車輛時的連鎖刪除（集合式：子資料再多也是固定幾句，與車輛的墓碑在同一個交易）。 */
export interface CascadePlan {
  plate: string;
  entities: Entity[];
  at: number;
  actor: { identity: string; deviceId: string; name: string };
}

export interface HistoryRow {
  id: number;
  at: number;
  entity: string;
  entity_id: string;
  event_id: string | null;
  operation: string;
  source: string;
  actor_device: string | null;
  actor_identity: string | null;
  actor_name: string | null;
  before_json: string | null;
  after_json: string | null;
  changed_fields: string | null;
  reason: string | null;
  seq: number;
  revision: number;
  outcome: string;
}

/** 一次寫入（新增、修改或刪除）的內容與條件。 */
export interface WriteRequest {
  entity: Entity;
  id: string;
  operation: 'create' | 'update' | 'delete';
  /** 新的內容；刪除時為 null（改為墓碑）。 */
  payloadText: string | null;
  /** 資料的修改時間（2001 起算秒數）；刪除時是刪除的時間。 */
  modifiedAt: number;
  /** 最後寫入者勝比較用的事件時間（刪除不比較）。 */
  eventTime: number;
  fields: ScopeFields;
  actor: { identity: string; deviceId: string; name: string };
  source: WriteSource;
  eventId: string | null;
  reason: string | null;
  /** 讀取時的序號（樂觀並行控制：讀取後被別的請求改過就不寫入，呼叫端重讀、重新授權後重試）；主機上沒有這筆時為 null。 */
  expectedSeq: number | null;
  /** 寫入後的版本（讀取時的版本＋1）。 */
  nextRevision: number;
  changedFields: string[] | null;
  /** 冪等：寫入成功時，同一個交易記下這個事件的處理結果。 */
  processed: { deviceId: string; eventId: string; resultJson: string } | null;
  now: number;
}

function toRecord(r: RecordRow): StoredRecord {
  let payload: Record<string, unknown> | null = null;
  if (r.payload !== null && r.deleted === 0) {
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  return {
    entity: r.entity as Entity,
    id: r.id,
    seq: Number(r.seq),
    modifiedAt: Number(r.modified_at),
    deleted: Number(r.deleted) === 1,
    payload,
    driverUuid: r.driver_uuid,
    driverName: r.driver_name,
    requesterDevice: r.requester_device,
    vehiclePlate: r.vehicle_plate,
    createdBy: r.created_by,
    revision: Number(r.revision ?? 0),
  };
}

export class Repo {
  db: SqlDb;

  constructor(db: SqlDb) {
    this.db = db;
  }

  // ───────── 初始化與伺服器資訊 ─────────

  /** 建立資料表（已存在就略過）與伺服器 ID、名稱、序號，再把舊版本的資料表遷移到目前版本。可以重複執行。 */
  async init(defaultName: string, now: number): Promise<void> {
    // 已存在的資料庫：fd_records 沒有 revision 欄位時，CREATE INDEX 等敘述仍可執行（遷移再補欄位）
    await this.db.batch(SCHEMA.map((sql) => ({ sql })));
    await this.db.batch([
      // 新的資料庫直接是最新結構；已有的資料庫保留原本的版本，由 migrate() 逐步升級
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('schema', ?)`, params: [String(SCHEMA_VERSION)] },
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('seq', '0')` },
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('serverId', ?)`, params: [crypto.randomUUID().toUpperCase()] },
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('name', ?)`, params: [defaultName] },
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('createdAt', ?)`, params: [String(now)] },
      // 多筆寫入的守衛旗標（writeAll）：同一個交易內設為 1、結束前改回 0
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('guard', '0')` },
    ]);
    await this.migrate(now);
  }

  /** 目前資料庫的結構版本。 */
  async schemaVersion(): Promise<number> {
    const row = await this.db.first<{ v: string }>(`SELECT v FROM fd_meta WHERE k = 'schema'`);
    return row ? Number(row.v) : 0;
  }

  /**
   * 結構遷移（1.2.0 起）：依 fd_meta 的 schema 逐步升級。每一步都可以重複執行（中途失敗後重新啟動會再試），
   * 同一步的敘述在同一個交易內；完成後才更新版本。升級前請先備份（docs/migration.md）。
   */
  async migrate(now: number = Date.now()): Promise<{ from: number; to: number }> {
    const from = await this.schemaVersion();
    let v = from;
    if (v < 2) {
      const columns = new Set((await this.db.all<{ name: string }>(`PRAGMA table_info(fd_records)`)).map((c) => String(c.name)));
      const steps: SqlStatement[] = [];
      if (!columns.has('revision')) steps.push({ sql: `ALTER TABLE fd_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 0` });
      for (const sql of SCHEMA_V2_TABLES) steps.push({ sql });
      // 既有資料的版本從 1 開始（之後的寫入再加 1）
      steps.push({ sql: `UPDATE fd_records SET revision = 1 WHERE revision = 0` });
      // 1.0–1.1 的稽核摘要含駕駛人的個資（證號、電話、備註）：清除摘要，保留誰、何時、做了什麼（docs/audit-history.md）
      steps.push({ sql: `UPDATE fd_audit SET summary = '' WHERE entity = 'driver'` });
      steps.push({ sql: `UPDATE fd_meta SET v = '2' WHERE k = 'schema'` });
      await this.db.batch(steps);
      v = 2;
    }
    if (v < 3) {
      const columns = new Set((await this.db.all<{ name: string }>(`PRAGMA table_info(fd_devices)`)).map((c) => String(c.name)));
      const steps: SqlStatement[] = [];
      if (!columns.has('web_session')) steps.push({ sql: `ALTER TABLE fd_devices ADD COLUMN web_session TEXT` });
      if (!columns.has('session_until')) steps.push({ sql: `ALTER TABLE fd_devices ADD COLUMN session_until INTEGER` });
      // 1.0–1.1 的網頁管理把權杖存在瀏覽器：不再延長，最多再用 30 天（期間內開啟網頁管理會自動換成 Cookie）
      steps.push({
        sql: `UPDATE fd_devices SET token_expires_at = ? WHERE platform = 'web' AND web_session IS NULL AND revoked_at IS NULL AND token_expires_at > ?`,
        params: [now + LEGACY_WEB_TTL_MS, now + LEGACY_WEB_TTL_MS],
      });
      steps.push({ sql: `UPDATE fd_meta SET v = '3' WHERE k = 'schema'` });
      await this.db.batch(steps);
      v = 3;
    }
    return { from, to: v };
  }

  async meta(): Promise<{ serverId: string; name: string }> {
    const rows = await this.db.all<{ k: string; v: string }>(`SELECT k, v FROM fd_meta WHERE k IN ('serverId', 'name')`);
    const map = new Map(rows.map((r) => [r.k, r.v]));
    return { serverId: map.get('serverId') ?? '', name: map.get('name') ?? '' };
  }

  async setName(name: string): Promise<void> {
    await this.db.run(`UPDATE fd_meta SET v = ? WHERE k = 'name'`, [name]);
  }

  async currentSeq(): Promise<number> {
    const row = await this.db.first<{ v: string }>(`SELECT v FROM fd_meta WHERE k = 'seq'`);
    return row ? Number(row.v) : 0;
  }

  // ───────── 裝置 ─────────

  /**
   * 可以使用的管理員（沒有解除配對、權杖還沒過期）的數量。是 0 時設定碼有效：第一次設定，或所有管理員的登入都已失效
   * （例如只用網頁管理、超過期限沒有使用）時可以用設定碼重新建立管理員（docs/security-review.md §2）。
   */
  async countActiveAdmins(now: number): Promise<number> {
    const row = await this.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM fd_devices WHERE ${Repo.USABLE_ADMIN}`, [now]);
    return row ? Number(row.n) : 0;
  }

  async deviceByTokenHash(hash: string): Promise<DeviceRow | null> {
    return this.db.first<DeviceRow>(`SELECT * FROM fd_devices WHERE token_hash = ? AND revoked_at IS NULL`, [hash]);
  }

  async deviceById(id: string): Promise<DeviceRow | null> {
    return this.db.first<DeviceRow>(`SELECT * FROM fd_devices WHERE device_id = ?`, [id]);
  }

  async listDevices(): Promise<DeviceRow[]> {
    return this.db.all<DeviceRow>(`SELECT * FROM fd_devices ORDER BY paired_at`);
  }

  async touchDevice(id: string, now: number, expiresAt: number): Promise<void> {
    await this.db.run(`UPDATE fd_devices SET last_seen_at = ?, token_expires_at = ? WHERE device_id = ?`, [now, expiresAt, id]);
  }

  /**
   * 配對：先以條件式更新用掉配對碼（若有），再建立或覆寫裝置。每次配對都產生新的主機端身分（identity），
   * 以同一個 deviceId 重新配對不會繼承之前建立的資料的擁有權。配對碼已被用掉時回傳 false、不建立裝置。
   * 以設定碼配對（codeHash 是 null）時，同一句 SQL 確認沒有可以使用的管理員：同時送出的兩個設定碼請求只有一個成功。
   * `web`：網頁管理以 Cookie 登入（1.2.0）的種類與期限。
   */
  async pairDevice(
    device: {
      id: string; name: string; platform: string; role: Role; binding: DriverBinding | null; tokenHash: string; expiresAt: number;
      web?: { kind: string; until: number } | null;
    },
    now: number,
    codeHash: string | null,
  ): Promise<boolean> {
    const values = [
      device.id, device.name, device.platform, device.role, device.binding?.driverUuid ?? null, device.binding?.driverName ?? null,
      device.tokenHash, device.expiresAt, now, now, crypto.randomUUID().toUpperCase(), device.web?.kind ?? null, device.web?.until ?? null,
    ];
    const columns = `(device_id, name, platform, role, driver_uuid, driver_name, token_hash, token_expires_at, paired_at, last_seen_at, revoked_at, identity,
              web_session, session_until)`;
    const conflict = `ON CONFLICT (device_id) DO UPDATE SET name = excluded.name, platform = excluded.platform, role = excluded.role,
              driver_uuid = excluded.driver_uuid, driver_name = excluded.driver_name, token_hash = excluded.token_hash,
              token_expires_at = excluded.token_expires_at, paired_at = excluded.paired_at, last_seen_at = excluded.last_seen_at, revoked_at = NULL,
              identity = excluded.identity, web_session = excluded.web_session, session_until = excluded.session_until`;
    if (codeHash === null) {
      const r = await this.db.run(
        `INSERT INTO fd_devices ${columns}
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM fd_devices WHERE ${Repo.USABLE_ADMIN})
            ${conflict}`,
        [...values, now],
      );
      return r.changes > 0;
    }
    const upsert: SqlStatement = {
      sql: `INSERT INTO fd_devices ${columns}
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
            ${conflict}`,
      params: values,
    };
    const consumed = await this.db.run(
      `UPDATE fd_pairing_codes SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      [now, device.id, codeHash, now],
    );
    if (consumed.changes === 0) return false;
    await this.db.batch([upsert]);
    return true;
  }

  /** 可以使用的管理員（參數：現在的時間）。 */
  private static readonly USABLE_ADMIN = `role = 'admin' AND revoked_at IS NULL AND token_hash IS NOT NULL AND token_expires_at > ?`;
  /**
   * 其他可以使用的管理員（不含 [id]）存在（參數：現在的時間、id）。寫在同一句 SQL 的條件中，
   * 兩位管理員同時互相降級或解除配對時不會一個都不剩。
   */
  private static readonly OTHER_ADMIN = `(SELECT COUNT(*) FROM fd_devices WHERE ${Repo.USABLE_ADMIN} AND device_id != ?) > 0`;

  /** 解除配對；沒有其他可以使用的管理員時不解除管理員（回傳 false）。 */
  async revokeDevice(id: string, now: number): Promise<boolean> {
    const r = await this.db.run(
      `UPDATE fd_devices SET revoked_at = ?, token_hash = NULL WHERE device_id = ? AND revoked_at IS NULL AND (role != 'admin' OR ${Repo.OTHER_ADMIN})`,
      [now, id, now, id],
    );
    return r.changes > 0;
  }

  /** 改角色或綁定；把管理員改成非管理員、而沒有其他可以使用的管理員時不寫入（回傳 false）。 */
  async updateDevice(id: string, role: Role, binding: DriverBinding | null, now: number): Promise<boolean> {
    const r = await this.db.run(
      `UPDATE fd_devices SET role = ?, driver_uuid = ?, driver_name = ? WHERE device_id = ?
         AND (? = 'admin' OR role != 'admin' OR revoked_at IS NOT NULL OR ${Repo.OTHER_ADMIN})`,
      [role, binding?.driverUuid ?? null, binding?.driverName ?? null, id, role, now, id],
    );
    return r.changes > 0;
  }

  /**
   * 1.1 的網頁權杖換成 Cookie 登入（POST /web/upgrade）：以舊權杖為條件換新權杖與期限，同時送出的兩個請求只有一個成功。
   */
  async upgradeWebSession(id: string, oldHash: string, s: { tokenHash: string; kind: string; until: number; expiresAt: number }, now: number): Promise<boolean> {
    const r = await this.db.run(
      `UPDATE fd_devices SET token_hash = ?, token_expires_at = ?, web_session = ?, session_until = ?, last_seen_at = ?
         WHERE device_id = ? AND token_hash = ? AND revoked_at IS NULL AND web_session IS NULL AND token_expires_at > ?`,
      [s.tokenHash, s.expiresAt, s.kind, s.until, now, id, oldHash, now],
    );
    return r.changes > 0;
  }

  // ───────── 配對嘗試次數 ─────────

  async recordFailure(ip: string, now: number): Promise<void> {
    await this.db.batch([
      { sql: `DELETE FROM fd_attempts WHERE at < ?`, params: [now - 24 * 3600 * 1000] },
      { sql: `INSERT INTO fd_attempts (ip, at) VALUES (?, ?)`, params: [ip, now] },
    ]);
  }

  async failures(ip: string, since: number): Promise<{ count: number; oldest: number | null }> {
    const row = await this.db.first<{ n: number; oldest: number | null }>(
      `SELECT COUNT(*) AS n, MIN(at) AS oldest FROM fd_attempts WHERE ip = ? AND at > ?`,
      [ip, since],
    );
    return { count: row ? Number(row.n) : 0, oldest: row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest) };
  }

  // ───────── 配對碼 ─────────

  async createCode(row: Omit<CodeRow, 'used_at'>): Promise<void> {
    await this.db.run(
      `INSERT INTO fd_pairing_codes (id, code_hash, role, driver_uuid, driver_name, label, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.code_hash, row.role, row.driver_uuid, row.driver_name, row.label, row.created_by, row.created_at, row.expires_at],
    );
  }

  async findUsableCode(hash: string, now: number): Promise<CodeRow | null> {
    return this.db.first<CodeRow>(`SELECT * FROM fd_pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`, [hash, now]);
  }

  async listCodes(now: number): Promise<CodeRow[]> {
    return this.db.all<CodeRow>(`SELECT * FROM fd_pairing_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at`, [now]);
  }

  async deleteCode(id: string): Promise<number> {
    return (await this.db.run(`DELETE FROM fd_pairing_codes WHERE id = ?`, [id])).changes;
  }

  // ───────── 資料 ─────────

  async getRecord(entity: Entity, id: string): Promise<StoredRecord | null> {
    const row = await this.db.first<RecordRow>(`SELECT ${RECORD_COLUMNS} FROM fd_records WHERE entity = ? AND id = ?`, [entity, id]);
    return row ? toRecord(row) : null;
  }

  /**
   * 寫入一筆資料（新增、修改或刪除），與修改前後歷史、已處理事件放在同一個交易（batch）：
   * - 新增／修改：主機上沒有，或事件時間嚴格大於現存的修改時間（墓碑是刪除的時間）才寫入；
   * - 刪除：主機上是有效資料時改為墓碑；
   * - 樂觀並行控制：讀取之後被別的請求改過（序號不同）就不寫入，呼叫端重讀、重新授權後重試——授權與寫入看到同一個版本；
   * - 每次寫入版本（revision）加 1；歷史記下修改前（交易內讀取）與修改後的內容、來源、身分與原因。
   * 回傳是否寫入。
   */
  async writeRecord(w: WriteRequest): Promise<boolean> {
    const changed = w.changedFields === null ? null : JSON.stringify(w.changedFields);
    const history: SqlStatement = {
      sql: `INSERT INTO fd_record_history (at, entity, entity_id, event_id, operation, source, actor_device, actor_identity, actor_name,
              before_json, after_json, changed_fields, reason, seq, revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT payload FROM fd_records WHERE entity = ? AND id = ? AND deleted = 0), ?, ?, ?, ${CURRENT_SEQ}, ?)`,
      params: [
        w.now, w.entity, w.id, w.eventId, w.operation, w.source, w.actor.deviceId, w.actor.identity, w.actor.name,
        w.entity, w.id, w.payloadText, changed, w.reason, w.nextRevision,
      ],
    };
    const write: SqlStatement =
      w.payloadText === null
        ? {
            sql: `UPDATE fd_records SET deleted = 1, payload = NULL, seq = ${CURRENT_SEQ}, modified_at = ?, updated_by = ?, updated_at = ?,
                    revision = revision + 1
                  WHERE entity = ? AND id = ? AND deleted = 0 AND seq = ?`,
            params: [w.modifiedAt, w.actor.deviceId, w.now, w.entity, w.id, w.expectedSeq ?? -1],
          }
        : {
            sql: `INSERT INTO fd_records (entity, id, seq, modified_at, deleted, payload, driver_uuid, driver_name, requester_device, vehicle_plate,
                    created_by, updated_by, updated_at, revision)
                  VALUES (?, ?, ${CURRENT_SEQ}, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                  ON CONFLICT (entity, id) DO UPDATE SET seq = excluded.seq, modified_at = excluded.modified_at,
                    payload = excluded.payload, driver_uuid = excluded.driver_uuid, driver_name = excluded.driver_name,
                    requester_device = excluded.requester_device, vehicle_plate = excluded.vehicle_plate,
                    created_by = CASE WHEN fd_records.deleted = 1 THEN excluded.created_by ELSE fd_records.created_by END,
                    deleted = 0, updated_by = excluded.updated_by, updated_at = excluded.updated_at, revision = fd_records.revision + 1
                  WHERE ? > fd_records.modified_at AND fd_records.seq = ?`,
            params: [
              w.entity, w.id, w.modifiedAt, w.payloadText, w.fields.driverUuid, w.fields.driverName, w.fields.requesterDevice, w.fields.vehiclePlate,
              w.actor.identity, w.actor.deviceId, w.now, w.eventTime, w.expectedSeq ?? -1,
            ],
          };
    const written = `EXISTS (SELECT 1 FROM fd_records WHERE entity = ? AND id = ? AND seq = ${CURRENT_SEQ})`;
    const statements: SqlStatement[] = [
      BUMP_SEQ,
      history,
      write,
      // 沒有寫入時不留歷史
      { sql: `DELETE FROM fd_record_history WHERE seq = ${CURRENT_SEQ} AND NOT ${written}`, params: [w.entity, w.id] },
    ];
    if (w.processed) {
      statements.push({
        sql: `INSERT OR IGNORE INTO fd_processed_events (device_id, event_id, status, reason, result_json, at)
              SELECT ?, ?, 'applied', NULL, ?, ? WHERE ${written}`,
        params: [w.processed.deviceId, w.processed.eventId, w.processed.resultJson, w.now, w.entity, w.id],
      });
    }
    const results = await this.db.batch(statements);
    return results[2].changes > 0;
  }

  /**
   * 多筆不可分割的寫入（網頁管理的修改、核准、刪除與 App 的刪除）：同一個 batch（交易）先檢查所有前提——資料讀取後沒有被改過、
   * 新資料不存在、額外條件（例如車輛沒有進行中的車趟）——成立時才依序寫入每一筆（序號＋1、修改前後歷史、資料、稽核紀錄），
   * 再做連鎖刪除、冪等紀錄與其他附帶的敘述；任何前提不成立時整批都不寫。回傳是否寫入（false：呼叫端重讀後重試或回報衝突）。
   */
  async writeAll(plan: {
    expect: Expectation[];
    conditions?: SqlStatement[];
    writes: GuardedWrite[];
    cascade?: CascadePlan | null;
    processed?: { deviceId: string; eventId: string; resultJson: string } | null;
    extra?: SqlStatement[];
    now: number;
  }): Promise<boolean> {
    const conds: string[] = [];
    const condParams: unknown[] = [];
    for (const e of plan.expect) {
      if (e.seq === null) {
        conds.push(`NOT EXISTS (SELECT 1 FROM fd_records WHERE entity = ? AND id = ?)`);
        condParams.push(e.entity, e.id);
      } else {
        conds.push(`EXISTS (SELECT 1 FROM fd_records WHERE entity = ? AND id = ? AND seq = ?${e.live ? ' AND deleted = 0' : ''})`);
        condParams.push(e.entity, e.id, e.seq);
      }
    }
    for (const c of plan.conditions ?? []) {
      conds.push(`(${c.sql})`);
      condParams.push(...(c.params ?? []));
    }
    const statements: SqlStatement[] = [
      { sql: `UPDATE fd_meta SET v = '0' WHERE k = 'guard'` },
      { sql: `UPDATE fd_meta SET v = '1' WHERE k = 'guard'${conds.length ? ' AND ' + conds.join(' AND ') : ''}`, params: condParams },
    ];
    for (const w of plan.writes) {
      statements.push({ sql: `${BUMP_SEQ.sql} AND ${GUARD}` });
      statements.push({
        sql: `INSERT INTO fd_record_history (${HISTORY_COLUMNS})
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT payload FROM fd_records WHERE entity = ? AND id = ? AND deleted = 0), ?, ?, ?, ${CURRENT_SEQ}, ?, 'applied'
              WHERE ${GUARD}`,
        params: [
          plan.now, w.entity, w.id, w.eventId, w.operation, w.source, w.actor.deviceId, w.actor.identity, w.actor.name,
          w.entity, w.id, w.payloadText, w.changedFields === null ? null : JSON.stringify(w.changedFields), w.reason, w.nextRevision,
        ],
      });
      if (w.payloadText === null) {
        statements.push({
          sql: `UPDATE fd_records SET deleted = 1, payload = NULL, seq = ${CURRENT_SEQ}, modified_at = ?, updated_by = ?, updated_at = ?,
                  revision = revision + 1
                WHERE entity = ? AND id = ? AND deleted = 0 AND ${GUARD}`,
          params: [w.modifiedAt, w.actor.deviceId, plan.now, w.entity, w.id],
        });
      } else {
        statements.push({
          sql: `INSERT INTO fd_records (entity, id, seq, modified_at, deleted, payload, driver_uuid, driver_name, requester_device, vehicle_plate,
                  created_by, updated_by, updated_at, revision)
                SELECT ?, ?, ${CURRENT_SEQ}, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1 WHERE ${GUARD}
                ON CONFLICT (entity, id) DO UPDATE SET seq = excluded.seq, modified_at = excluded.modified_at,
                  payload = excluded.payload, driver_uuid = excluded.driver_uuid, driver_name = excluded.driver_name,
                  requester_device = excluded.requester_device, vehicle_plate = excluded.vehicle_plate,
                  created_by = CASE WHEN fd_records.deleted = 1 THEN excluded.created_by ELSE fd_records.created_by END,
                  deleted = 0, updated_by = excluded.updated_by, updated_at = excluded.updated_at, revision = fd_records.revision + 1`,
          params: [
            w.entity, w.id, w.modifiedAt, w.payloadText, w.fields.driverUuid, w.fields.driverName, w.fields.requesterDevice, w.fields.vehiclePlate,
            w.actor.identity, w.actor.deviceId, plan.now,
          ],
        });
      }
      if (w.auditSummary !== null) {
        statements.push({
          sql: `INSERT INTO fd_audit (at, device_id, device_name, entity, entity_id, operation, summary) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD}`,
          params: [plan.now, w.actor.deviceId, w.actor.name, w.entity, w.id, w.operation, w.auditSummary],
        });
      }
    }
    if (plan.cascade) statements.push(...Repo.cascadeStatements(plan.cascade, plan.now));
    if (plan.processed) {
      statements.push({
        sql: `INSERT OR IGNORE INTO fd_processed_events (device_id, event_id, status, reason, result_json, at)
              SELECT ?, ?, 'applied', NULL, ?, ? WHERE ${GUARD}`,
        params: [plan.processed.deviceId, plan.processed.eventId, plan.processed.resultJson, plan.now],
      });
    }
    for (const x of plan.extra ?? []) statements.push({ sql: `${x.sql} AND ${GUARD}`, params: x.params });
    statements.push({ sql: `UPDATE fd_meta SET v = '0' WHERE k = 'guard'` });
    const results = await this.db.batch(statements);
    return results[1].changes > 0;
  }

  /**
   * 連鎖刪除的敘述（在 writeAll 的守衛下）：同車牌的子資料依「種類、UUID」排序，各自取得連續的新序號，
   * 先寫修改前後歷史（修改前是現在的內容），再改為墓碑、更新序號、寫稽核紀錄、移除即時位置。
   */
  private static cascadeStatements(c: CascadePlan, now: number): SqlStatement[] {
    const marks = c.entities.map(() => '?').join(', ');
    const scope = `vehicle_plate = ? AND deleted = 0 AND entity IN (${marks})`;
    const scopeParams = [c.plate, ...c.entities];
    const fresh = `seq > ${CASCADE_BASE}`;
    return [
      { sql: `INSERT OR REPLACE INTO fd_meta (k, v) SELECT 'cascadeBase', v FROM fd_meta WHERE k = 'seq' AND ${GUARD}` },
      {
        sql: `INSERT INTO fd_record_history (${HISTORY_COLUMNS})
              SELECT ?, entity, id, NULL, 'delete', 'cascade', ?, ?, ?, payload, NULL, NULL, 'vehicle-deleted',
                ${CASCADE_BASE} + ROW_NUMBER() OVER (ORDER BY entity, id), revision + 1, 'applied'
              FROM fd_records WHERE ${scope} AND ${GUARD}`,
        params: [now, c.actor.deviceId, c.actor.identity, c.actor.name, ...scopeParams],
      },
      {
        sql: `UPDATE fd_records SET deleted = 1, payload = NULL, modified_at = ?, updated_by = ?, updated_at = ?, revision = revision + 1,
                seq = (SELECT h.seq FROM fd_record_history h WHERE h.entity = fd_records.entity AND h.entity_id = fd_records.id
                       AND h.source = 'cascade' AND h.${fresh})
              WHERE ${scope} AND ${GUARD}`,
        params: [c.at, c.actor.deviceId, now, ...scopeParams],
      },
      {
        sql: `UPDATE fd_meta SET v = CAST((SELECT MAX(seq) FROM fd_records) AS TEXT)
              WHERE k = 'seq' AND (SELECT MAX(seq) FROM fd_records) > CAST(v AS INTEGER) AND ${GUARD}`,
      },
      {
        sql: `INSERT INTO fd_audit (at, device_id, device_name, entity, entity_id, operation, summary)
              SELECT ?, ?, ?, entity, entity_id, 'delete', '' FROM fd_record_history WHERE source = 'cascade' AND ${fresh} AND ${GUARD} ORDER BY seq`,
        params: [now, c.actor.deviceId, c.actor.name],
      },
      {
        sql: `DELETE FROM fd_locations WHERE trip_id IN (SELECT entity_id FROM fd_record_history WHERE entity = 'trip' AND source = 'cascade' AND ${fresh})
              AND ${GUARD}`,
      },
    ];
  }

  /**
   * 沒有套用的事件（拒絕、衝突、略過）留下摘要（1.2.0）：主機上目前的內容、送來的內容、差異的欄位、原因。
   * 不改資料、不取新的序號；與冪等紀錄在同一個交易。
   */
  async recordOutcome(o: {
    at: number;
    entity: Entity;
    id: string;
    eventId: string | null;
    operation: string;
    actor: { identity: string; deviceId: string; name: string };
    beforeText: string | null;
    attemptedText: string | null;
    changedFields: string[] | null;
    reason: string | null;
    revision: number;
    outcome: 'rejected' | 'conflict' | 'ignored';
    processed: { deviceId: string; eventId: string; status: string; reason: string | null; resultJson: string } | null;
  }): Promise<void> {
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO fd_record_history (${HISTORY_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'app', ?, ?, ?, ?, ?, ?, ?, ${CURRENT_SEQ}, ?, ?)`,
        params: [
          o.at, o.entity, o.id, o.eventId, o.operation, o.actor.deviceId, o.actor.identity, o.actor.name, o.beforeText, o.attemptedText,
          o.changedFields === null ? null : JSON.stringify(o.changedFields), o.reason, o.revision, o.outcome,
        ],
      },
    ];
    if (o.processed) {
      statements.push({
        sql: `INSERT OR IGNORE INTO fd_processed_events (device_id, event_id, status, reason, result_json, at) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [o.processed.deviceId, o.processed.eventId, o.processed.status, o.processed.reason, o.processed.resultJson, o.at],
      });
    }
    await this.db.batch(statements);
  }

  // ───────── 管理查詢（1.2.0） ─────────

  /** 某一種類的有效資料（管理查詢用；其他篩選、排序與分頁在程式中處理，三種實作一致）。 */
  async adminRows(entity: Entity, f: AdminFilter): Promise<AdminRow[]> {
    const where = ['entity = ?', 'deleted = 0'];
    const params: unknown[] = [entity];
    if (f.plate) {
      where.push('vehicle_plate = ?');
      params.push(f.plate);
    }
    if (f.driverOwn) {
      where.push('(driver_uuid = ? OR (driver_uuid IS NULL AND driver_name = ? AND driver_name != \'\'))');
      params.push(f.driverOwn.uuid, f.driverOwn.name);
    }
    if (f.driverName) {
      where.push('driver_name = ?');
      params.push(f.driverName);
    }
    if (f.createdBy) {
      where.push('created_by = ?');
      params.push(f.createdBy);
    }
    return this.db.all<AdminRow>(`SELECT ${ADMIN_COLUMNS} FROM fd_records WHERE ${where.join(' AND ')} ORDER BY id`, params);
  }

  /** 一筆資料（含墓碑），管理查詢用。 */
  async adminRow(entity: Entity, id: string): Promise<AdminRow | null> {
    return this.db.first<AdminRow>(`SELECT ${ADMIN_COLUMNS} FROM fd_records WHERE entity = ? AND id = ?`, [entity, id]);
  }

  /** 車牌相同的子資料數（刪除車輛的影響預覽）。 */
  async childCounts(plate: string, entities: Entity[]): Promise<Record<string, number>> {
    const marks = entities.map(() => '?').join(', ');
    const rows = await this.db.all<{ entity: string; n: number }>(
      `SELECT entity, COUNT(*) AS n FROM fd_records WHERE vehicle_plate = ? AND deleted = 0 AND entity IN (${marks}) GROUP BY entity`,
      [plate, ...entities],
    );
    const out: Record<string, number> = {};
    for (const e of entities) out[e] = 0;
    for (const r of rows) out[r.entity] = Number(r.n);
    return out;
  }

  /** 綁定這位駕駛人的裝置（還沒解除配對的）。 */
  async devicesBoundTo(driverUuid: string): Promise<DeviceRow[]> {
    return this.db.all<DeviceRow>(`SELECT * FROM fd_devices WHERE driver_uuid = ? AND revoked_at IS NULL ORDER BY paired_at`, [driverUuid]);
  }

  async locationOf(tripId: string): Promise<LocationRow | null> {
    return this.db.first<LocationRow>(`SELECT * FROM fd_locations WHERE trip_id = ?`, [tripId]);
  }

  // ───────── 已處理的事件（冪等） ─────────

  async processedResult(deviceId: string, eventId: string): Promise<string | null> {
    const row = await this.db.first<{ result_json: string | null }>(
      `SELECT result_json FROM fd_processed_events WHERE device_id = ? AND event_id = ?`,
      [deviceId, eventId],
    );
    return row?.result_json ?? null;
  }

  /** 記下沒有寫入資料的結果（拒絕、略過、衝突）；同一個事件已有結果時保留第一次的。 */
  async recordProcessed(deviceId: string, eventId: string, status: string, reason: string | null, resultJson: string, now: number): Promise<void> {
    await this.db.run(
      `INSERT OR IGNORE INTO fd_processed_events (device_id, event_id, status, reason, result_json, at) VALUES (?, ?, ?, ?, ?, ?)`,
      [deviceId, eventId, status, reason, resultJson, now],
    );
  }

  /** 清除過舊的已處理事件（重送通常在幾分鐘內；保留 30 天）。 */
  async purgeProcessed(before: number): Promise<void> {
    await this.db.run(`DELETE FROM fd_processed_events WHERE at < ?`, [before]);
  }

  // ───────── 修改前後歷史 ─────────

  async listHistory(filter: {
    entity: Entity | null;
    id: string | null;
    before: number | null;
    limit: number;
    outcome?: 'applied' | 'notApplied' | null;
    source?: string | null;
  }): Promise<HistoryRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.outcome === 'applied') where.push(`outcome = 'applied'`);
    if (filter.outcome === 'notApplied') where.push(`outcome != 'applied'`);
    if (filter.source) {
      where.push('source = ?');
      params.push(filter.source);
    }
    if (filter.entity) {
      where.push('entity = ?');
      params.push(filter.entity);
    }
    if (filter.id) {
      where.push('entity_id = ?');
      params.push(filter.id);
    }
    if (filter.before !== null) {
      where.push('id < ?');
      params.push(filter.before);
    }
    params.push(filter.limit);
    return this.db.all<HistoryRow>(
      `SELECT * FROM fd_record_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      params,
    );
  }

  // ───────── 業務規則 ─────────

  /** 這個車牌還沒回車的車趟數（有進行中車趟的車輛不能刪除）。 */
  async activeTripsOfPlate(plate: string): Promise<number> {
    const row = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM fd_records WHERE entity = 'trip' AND deleted = 0 AND vehicle_plate = ? AND json_extract(payload, '$.isCompleted') = 0`,
      [plate],
    );
    return row ? Number(row.n) : 0;
  }

  /** writeAll 的前提：這個車牌沒有進行中的車趟（與 activeTripsOfPlate 相同的條件，在寫入的交易中再確認一次）。 */
  static noActiveTrips(plate: string): SqlStatement {
    return {
      sql: `NOT EXISTS (SELECT 1 FROM fd_records WHERE entity = 'trip' AND deleted = 0 AND vehicle_plate = ? AND json_extract(payload, '$.isCompleted') = 0)`,
      params: [plate],
    };
  }

  /** writeAll 的前提：連鎖刪除的筆數與預覽時相同（網頁管理的刪除：管理員看到的影響範圍就是實際刪除的範圍）。 */
  static childCountIs(plate: string, entities: Entity[], count: number): SqlStatement {
    const marks = entities.map(() => '?').join(', ');
    return {
      sql: `(SELECT COUNT(*) FROM fd_records WHERE vehicle_plate = ? AND deleted = 0 AND entity IN (${marks})) = ?`,
      params: [plate, ...entities, count],
    };
  }

  async allLive(): Promise<StoredRecord[]> {
    const rows = await this.db.all<RecordRow>(`SELECT ${RECORD_COLUMNS} FROM fd_records WHERE deleted = 0 ORDER BY entity, id`);
    return rows.filter((r) => (ENTITIES as readonly string[]).includes(r.entity)).map(toRecord);
  }

  async changesSince(seq: number, limit: number): Promise<StoredRecord[]> {
    const rows = await this.db.all<RecordRow>(`SELECT ${RECORD_COLUMNS} FROM fd_records WHERE seq > ? ORDER BY seq LIMIT ?`, [seq, limit]);
    return rows.map(toRecord);
  }

  // ───────── 稽核紀錄 ─────────

  async addAudit(row: Omit<AuditRow, 'id'>): Promise<void> {
    await this.db.run(
      `INSERT INTO fd_audit (at, device_id, device_name, entity, entity_id, operation, summary) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.at, row.device_id, row.device_name, row.entity, row.entity_id, row.operation, row.summary],
    );
  }

  async listAudit(before: number | null, limit: number): Promise<AuditRow[]> {
    if (before === null) return this.db.all<AuditRow>(`SELECT * FROM fd_audit ORDER BY id DESC LIMIT ?`, [limit]);
    return this.db.all<AuditRow>(`SELECT * FROM fd_audit WHERE id < ? ORDER BY id DESC LIMIT ?`, [before, limit]);
  }

  // ───────── 即時位置 ─────────

  async upsertLocation(row: LocationRow): Promise<void> {
    await this.db.run(
      `INSERT INTO fd_locations (trip_id, device_id, device_name, plate, latitude, longitude, speed, course, ts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (trip_id) DO UPDATE SET device_id = excluded.device_id, device_name = excluded.device_name, plate = excluded.plate,
         latitude = excluded.latitude, longitude = excluded.longitude, speed = excluded.speed, course = excluded.course,
         ts = excluded.ts, updated_at = excluded.updated_at`,
      [row.trip_id, row.device_id, row.device_name, row.plate, row.latitude, row.longitude, row.speed, row.course, row.ts, row.updated_at],
    );
  }

  async deleteLocation(tripId: string): Promise<void> {
    await this.db.run(`DELETE FROM fd_locations WHERE trip_id = ?`, [tripId]);
  }

  async listLocations(freshAfter: number): Promise<LocationRow[]> {
    await this.db.run(`DELETE FROM fd_locations WHERE updated_at < ?`, [freshAfter]);
    return this.db.all<LocationRow>(`SELECT * FROM fd_locations ORDER BY updated_at DESC`);
  }
}
