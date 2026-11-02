// 儲存層：Cloudflare D1 與 Node 內建 SQLite 共用同一套 SQL（SQLite 方言），經由 SqlDb 介面存取。
// 寫入資料一律「序號 +1」與「條件式寫入」放在同一個 batch（交易）中，最後寫入者勝由 SQL 保證，不怕並行請求交錯。

import type { DriverBinding, Entity, Role, ScopeFields, StoredRecord } from './types.ts';
import { ENTITIES } from './types.ts';

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

export const SCHEMA_VERSION = 1;

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS fd_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fd_records (
    entity TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, modified_at REAL NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, payload TEXT,
    driver_uuid TEXT, driver_name TEXT, requester_device TEXT, vehicle_plate TEXT,
    created_by TEXT, updated_by TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (entity, id))`,
  `CREATE INDEX IF NOT EXISTS fd_records_seq ON fd_records (seq)`,
  `CREATE INDEX IF NOT EXISTS fd_records_plate ON fd_records (vehicle_plate)`,
  `CREATE TABLE IF NOT EXISTS fd_devices (
    device_id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
    driver_uuid TEXT, driver_name TEXT, token_hash TEXT, token_expires_at INTEGER,
    paired_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER, identity TEXT)`,
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
];

const BUMP_SEQ: SqlStatement = { sql: `UPDATE fd_meta SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'seq'` };
const CURRENT_SEQ = `(SELECT CAST(v AS INTEGER) FROM fd_meta WHERE k = 'seq')`;

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
}

const RECORD_COLUMNS = 'entity, id, seq, modified_at, deleted, payload, driver_uuid, driver_name, requester_device, vehicle_plate, created_by';

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
  };
}

export class Repo {
  db: SqlDb;

  constructor(db: SqlDb) {
    this.db = db;
  }

  // ───────── 初始化與伺服器資訊 ─────────

  /** 建立資料表（已存在就略過）與伺服器 ID、名稱、序號。 */
  async init(defaultName: string, now: number): Promise<void> {
    await this.db.batch(SCHEMA.map((sql) => ({ sql })));
    await this.db.batch([
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('schema', ?)`, params: [String(SCHEMA_VERSION)] },
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('seq', '0')` },
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('serverId', ?)`, params: [crypto.randomUUID().toUpperCase()] },
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('name', ?)`, params: [defaultName] },
      { sql: `INSERT OR IGNORE INTO fd_meta (k, v) VALUES ('createdAt', ?)`, params: [String(now)] },
    ]);
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

  async countActiveAdmins(): Promise<number> {
    const row = await this.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM fd_devices WHERE role = 'admin' AND revoked_at IS NULL`);
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

  /** 配對：先以條件式更新用掉配對碼（若有），再建立或覆寫裝置。每次配對都產生新的主機端身分（identity），
   * 以同一個 deviceId 重新配對不會繼承之前建立的資料的擁有權。配對碼已被用掉時回傳 false、不建立裝置。 */
  async pairDevice(
    device: { id: string; name: string; platform: string; role: Role; binding: DriverBinding | null; tokenHash: string; expiresAt: number },
    now: number,
    codeHash: string | null,
  ): Promise<boolean> {
    const upsert: SqlStatement = {
      sql: `INSERT INTO fd_devices (device_id, name, platform, role, driver_uuid, driver_name, token_hash, token_expires_at, paired_at, last_seen_at, revoked_at, identity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
            ON CONFLICT (device_id) DO UPDATE SET name = excluded.name, platform = excluded.platform, role = excluded.role,
              driver_uuid = excluded.driver_uuid, driver_name = excluded.driver_name, token_hash = excluded.token_hash,
              token_expires_at = excluded.token_expires_at, paired_at = excluded.paired_at, last_seen_at = excluded.last_seen_at, revoked_at = NULL,
              identity = excluded.identity`,
      params: [
        device.id, device.name, device.platform, device.role, device.binding?.driverUuid ?? null, device.binding?.driverName ?? null,
        device.tokenHash, device.expiresAt, now, now, crypto.randomUUID().toUpperCase(),
      ],
    };
    if (codeHash === null) {
      await this.db.batch([upsert]);
      return true;
    }
    const consumed = await this.db.run(
      `UPDATE fd_pairing_codes SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      [now, device.id, codeHash, now],
    );
    if (consumed.changes === 0) return false;
    await this.db.batch([upsert]);
    return true;
  }

  async revokeDevice(id: string, now: number): Promise<void> {
    await this.db.run(`UPDATE fd_devices SET revoked_at = ?, token_hash = NULL WHERE device_id = ? AND revoked_at IS NULL`, [now, id]);
  }

  async updateDevice(id: string, role: Role, binding: DriverBinding | null): Promise<void> {
    await this.db.run(`UPDATE fd_devices SET role = ?, driver_uuid = ?, driver_name = ? WHERE device_id = ?`, [
      role, binding?.driverUuid ?? null, binding?.driverName ?? null, id,
    ]);
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

  /** 建立或修改：主機上沒有，或事件時間嚴格大於現存的修改時間（墓碑是刪除的時間）才寫入。回傳是否寫入。 */
  async upsertRecord(
    entity: Entity,
    id: string,
    payloadText: string,
    modifiedAt: number,
    eventTime: number,
    fields: ScopeFields,
    actor: { identity: string; deviceId: string },
    now: number,
  ): Promise<boolean> {
    const results = await this.db.batch([
      BUMP_SEQ,
      {
        sql: `INSERT INTO fd_records (entity, id, seq, modified_at, deleted, payload, driver_uuid, driver_name, requester_device, vehicle_plate, created_by, updated_by, updated_at)
              VALUES (?, ?, ${CURRENT_SEQ}, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (entity, id) DO UPDATE SET seq = excluded.seq, modified_at = excluded.modified_at,
                payload = excluded.payload, driver_uuid = excluded.driver_uuid, driver_name = excluded.driver_name,
                requester_device = excluded.requester_device, vehicle_plate = excluded.vehicle_plate,
                created_by = CASE WHEN fd_records.deleted = 1 THEN excluded.created_by ELSE fd_records.created_by END,
                deleted = 0, updated_by = excluded.updated_by, updated_at = excluded.updated_at
              WHERE ? > fd_records.modified_at`,
        params: [
          entity, id, modifiedAt, payloadText, fields.driverUuid, fields.driverName, fields.requesterDevice, fields.vehiclePlate,
          actor.identity, actor.deviceId, now, eventTime,
        ],
      },
    ]);
    return results[1].changes > 0;
  }

  /** 改為墓碑（保留查詢欄位）。回傳是否刪除（原本就不存在或已是墓碑時為 false）。 */
  async tombstone(entity: Entity, id: string, at: number, deviceId: string, now: number): Promise<boolean> {
    const results = await this.db.batch([
      BUMP_SEQ,
      {
        sql: `UPDATE fd_records SET deleted = 1, payload = NULL, seq = ${CURRENT_SEQ}, modified_at = ?, updated_by = ?, updated_at = ?
              WHERE entity = ? AND id = ? AND deleted = 0`,
        params: [at, deviceId, now, entity, id],
      },
    ]);
    return results[1].changes > 0;
  }

  /** 車牌相同的子資料（刪除車輛時連鎖刪除）。 */
  async liveChildrenOfPlate(plate: string, entities: Entity[]): Promise<{ entity: Entity; id: string; payload: string | null }[]> {
    const marks = entities.map(() => '?').join(', ');
    return this.db.all<{ entity: Entity; id: string; payload: string | null }>(
      `SELECT entity, id, payload FROM fd_records WHERE vehicle_plate = ? AND deleted = 0 AND entity IN (${marks})`,
      [plate, ...entities],
    );
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
