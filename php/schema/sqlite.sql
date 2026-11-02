-- FleetDispatch Server（PHP 版）資料庫結構：SQLite。
-- 與 core/src/db.ts 的 SCHEMA（Docker、Cloudflare 版）完全相同。
-- 主機第一次收到 API 請求時會自動建立（CREATE TABLE IF NOT EXISTS），通常不需要手動匯入。
-- 注意：這個檔案由程式以分號切開執行，註解只能寫成整行的 -- 註解，而且註解裡不能有分號。

CREATE TABLE IF NOT EXISTS fd_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS fd_records (
    entity TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, modified_at REAL NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, payload TEXT,
    driver_uuid TEXT, driver_name TEXT, requester_device TEXT, vehicle_plate TEXT,
    created_by TEXT, updated_by TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (entity, id));

CREATE INDEX IF NOT EXISTS fd_records_seq ON fd_records (seq);

CREATE INDEX IF NOT EXISTS fd_records_plate ON fd_records (vehicle_plate);

CREATE TABLE IF NOT EXISTS fd_devices (
    device_id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
    driver_uuid TEXT, driver_name TEXT, token_hash TEXT, token_expires_at INTEGER,
    paired_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER, identity TEXT);

CREATE UNIQUE INDEX IF NOT EXISTS fd_devices_token ON fd_devices (token_hash);

CREATE TABLE IF NOT EXISTS fd_pairing_codes (
    id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, driver_uuid TEXT, driver_name TEXT,
    label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    used_at INTEGER, used_by TEXT);

CREATE TABLE IF NOT EXISTS fd_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
    entity TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL, summary TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS fd_locations (
    trip_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_name TEXT NOT NULL, plate TEXT,
    latitude REAL NOT NULL, longitude REAL NOT NULL, speed REAL, course REAL, ts REAL NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS fd_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS fd_attempts_ip ON fd_attempts (ip, at);
