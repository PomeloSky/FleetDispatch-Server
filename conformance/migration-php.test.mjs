// 資料表遷移（1.1.0 → 1.2.0，資料表版本 1 → 3）的測試：PHP 版（SQLite；以 PHP 內建伺服器執行）。以 1.1.0 的結構建立資料庫、寫入資料，
// 再啟動目前版本的主機：
// - 升級前自動備份（VACUUM INTO）、升級後資料不變、既有資料的版本是 1、新的寫入留下修改前後歷史；
// - 再次啟動不重複遷移、不重複備份。
// 只在本機的暫存資料夾執行（不連任何正式主機）：node --test conformance/migration-php.test.mjs（需要 php 與 pdo_sqlite）
// MySQL 的遷移由 GET_LOCK 與逐項檢查保護，需在有 MySQL 的環境（CI）另外執行。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const APPLE = 978307200;
const nowApple = () => Date.now() / 1000 - APPLE;
const uuid = () => randomUUID().toUpperCase();

/** 1.1.0 的資料表（core/src/db.ts 在 1.1.0 的 SCHEMA）。 */
const SCHEMA_V1 = [
  `CREATE TABLE fd_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE fd_records (
    entity TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, modified_at REAL NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, payload TEXT,
    driver_uuid TEXT, driver_name TEXT, requester_device TEXT, vehicle_plate TEXT,
    created_by TEXT, updated_by TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (entity, id))`,
  `CREATE INDEX fd_records_seq ON fd_records (seq)`,
  `CREATE INDEX fd_records_plate ON fd_records (vehicle_plate)`,
  `CREATE TABLE fd_devices (
    device_id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
    driver_uuid TEXT, driver_name TEXT, token_hash TEXT, token_expires_at INTEGER,
    paired_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER, identity TEXT)`,
  `CREATE UNIQUE INDEX fd_devices_token ON fd_devices (token_hash)`,
  `CREATE TABLE fd_pairing_codes (
    id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, driver_uuid TEXT, driver_name TEXT,
    label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    used_at INTEGER, used_by TEXT)`,
  `CREATE TABLE fd_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
    entity TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL, summary TEXT NOT NULL)`,
  `CREATE TABLE fd_locations (
    trip_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_name TEXT NOT NULL, plate TEXT,
    latitude REAL NOT NULL, longitude REAL NOT NULL, speed REAL, course REAL, ts REAL NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE fd_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX fd_attempts_ip ON fd_attempts (ip, at)`,
];

function startServer(dir, port) {
  const config = join(dir, 'config.php');
  writeFileSync(config, `<?php\nreturn ['setup_token' => 'migration-test-setup-token', 'db' => ['dsn' => 'sqlite:${join(dir, 'fleetdispatch.sqlite')}', 'user' => '', 'password' => ''], 'server_name' => 'x', 'admin_path' => '/admin', 'trust_proxy' => 0];\n`);
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, 'php/public/index.php'], {
    env: { ...process.env, FD_PHP_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, log: () => log };
}

async function waitReady(base) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/v1/info`);
      if (r.ok) return r.json();
    } catch {
      // 還在啟動
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('主機沒有啟動');
}

const stop = (child) => new Promise((resolve) => {
  child.once('exit', resolve);
  child.kill('SIGTERM');
});

test('1.1.0 的資料庫升級到 1.2.0：先備份、資料不變、版本從 1 開始；再次啟動不重複', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-migration-'));
  try {
    const token = 'migration-test-admin-token-0123456789';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const admin = uuid(), vehicleId = uuid(), tripId = uuid();
    const t = nowApple();
    const vehicle = { entityUUID: vehicleId, plateNumber: 'MIG-0001', custodian: '', vehicleType: 'car', isElectric: false, fuelType: 'gas', brand: 'Toyota', modelYear: 2020, vin: '', lastModifiedAt: t };
    const trip = {
      entityUUID: tripId, startTime: t - 600, endTime: t, odometerStart: 100, odometerEnd: 150, origin: '總公司', destinations: ['新竹'], mission: '送貨',
      fuelAmount: 0, fuelCost: 0, tollCost: 0, parkingCost: 0, fuelType: '', didSwapBattery: false, driver: '王小明', isCompleted: true,
      lastModifiedAt: t, costCenter: '', vehiclePlateNumber: 'MIG-0001',
    };

    // 1.1.0 的資料庫
    const old = new DatabaseSync(join(dir, 'fleetdispatch.sqlite'));
    for (const sql of SCHEMA_V1) old.exec(sql);
    const now = Date.now();
    const meta = old.prepare('INSERT INTO fd_meta (k, v) VALUES (?, ?)');
    for (const [k, v] of [['schema', '1'], ['seq', '2'], ['serverId', uuid()], ['name', '舊主機'], ['createdAt', String(now)]]) meta.run(k, v);
    old.prepare(`INSERT INTO fd_devices (device_id, name, platform, role, token_hash, token_expires_at, paired_at, last_seen_at, identity)
                 VALUES (?, '管理員的 iPad', 'ipados', 'admin', ?, ?, ?, ?, ?)`).run(admin, tokenHash, now + 86400000, now, now, uuid());
    // 1.1 的網頁管理（權杖存在瀏覽器）與一般的 App：升級後網頁權杖最多再用 30 天，App 不變
    const legacyWeb = uuid(), phone = uuid();
    const far = now + 80 * 86400000;
    const device = old.prepare(`INSERT INTO fd_devices (device_id, name, platform, role, token_hash, token_expires_at, paired_at, last_seen_at, identity)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    device.run(legacyWeb, '網頁管理（Chrome）', 'web', 'admin', 'a'.repeat(64), far, now, now, uuid());
    device.run(phone, '駕駛的手機', 'ios', 'driver', 'b'.repeat(64), far, now, now, uuid());
    const rec = old.prepare(`INSERT INTO fd_records (entity, id, seq, modified_at, deleted, payload, vehicle_plate, driver_name, created_by, updated_by, updated_at)
                             VALUES (?, ?, ?, ?, 0, ?, 'MIG-0001', ?, 'X', ?, ?)`);
    rec.run('vehicle', vehicleId, 1, t, JSON.stringify(vehicle), null, admin, now);
    rec.run('trip', tripId, 2, t, JSON.stringify(trip), '王小明', admin, now);
    // 1.1.0 的稽核摘要是內容的前 2,000 字：駕駛人的摘要含證號、電話（升級時清除）
    const audit = old.prepare(`INSERT INTO fd_audit (at, device_id, device_name, entity, entity_id, operation, summary) VALUES (?, ?, '管理員的 iPad', ?, ?, ?, ?)`);
    audit.run(now, admin, 'driver', uuid(), 'create', JSON.stringify({ name: '王小明', licenseNumber: 'A123456789', phoneNumber: '0912-345-678' }));
    audit.run(now, admin, 'vehicle', vehicleId, 'create', JSON.stringify(vehicle));
    old.close();

    const port = 19300 + Math.floor(Math.random() * 400);
    const base = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${token}` };

    let srv = startServer(dir, port);
    const info = await waitReady(base);
    assert.equal(info.schemaVersion, 3);
    assert.equal(info.name, '舊主機');
    // PHP 的訊息寫到 error_log（內建伺服器輸出到 stderr）
    for (let i = 0; i < 20 && !/升級前的備份/.test(srv.log()); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(srv.log(), /升級前的備份/);
    const backups = readdirSync(dir).filter((f) => f.startsWith('fleetdispatch.sqlite.before-v3-') && f.endsWith('.bak'));
    assert.equal(backups.length, 1, '升級前自動備份');
    const copy = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
    assert.equal(copy.prepare(`SELECT v FROM fd_meta WHERE k = 'schema'`).get().v, '1', '備份是升級前的內容');
    copy.close();
    const after = new DatabaseSync(join(dir, 'fleetdispatch.sqlite'), { readOnly: true });
    const web = after.prepare(`SELECT token_expires_at, web_session, session_until FROM fd_devices WHERE device_id = ?`).get(legacyWeb);
    assert.ok(Number(web.token_expires_at) <= Date.now() + 30 * 86400000 && Number(web.token_expires_at) > now + 29 * 86400000, '1.1 的網頁權杖最多再用 30 天');
    assert.equal(web.web_session, null);
    assert.equal(web.session_until, null);
    assert.equal(Number(after.prepare(`SELECT token_expires_at FROM fd_devices WHERE device_id = ?`).get(phone).token_expires_at), far, 'App 的權杖不變');
    after.close();

    const snap = await (await fetch(`${base}/api/v1/snapshot`, { headers: auth })).json();
    assert.deepEqual(snap.snapshot.vehicles, [vehicle]);
    assert.deepEqual(snap.snapshot.trips, [trip]);
    assert.equal(snap.revisions[`vehicle:${vehicleId}`], 1, '既有資料的版本是 1');
    assert.equal(snap.cursor, 2);
    const auditRows = (await (await fetch(`${base}/api/v1/admin/audit`, { headers: auth })).json()).entries;
    assert.equal(auditRows.find((a) => a.entity === 'driver').summary, '', '駕駛人的個資從稽核摘要清除');
    assert.deepEqual(JSON.parse(auditRows.find((a) => a.entity === 'vehicle').summary), vehicle, '其他摘要不變');

    // 新的寫入：版本 2、留下修改前後歷史
    const edited = { ...vehicle, custodian: '總務', lastModifiedAt: t + 5 };
    const event = { id: uuid(), timestamp: t + 5, actor: 'test', entity: 'vehicle', operation: 'update', entityID: vehicleId, payloadJSON: JSON.stringify(edited) };
    const res = await (await fetch(`${base}/api/v1/events`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [event] }) })).json();
    assert.equal(res.results[0].status, 'applied');
    assert.equal(res.results[0].revision, 2);
    const hist = await (await fetch(`${base}/api/v1/admin/history?entity=vehicle&id=${vehicleId}`, { headers: auth })).json();
    assert.equal(hist.entries.length, 1);
    assert.deepEqual(hist.entries[0].before, vehicle);
    assert.deepEqual(hist.entries[0].changedFields, ['custodian']);
    await stop(srv.child);

    // 再次啟動：不重複遷移、不重複備份
    srv = startServer(dir, port);
    assert.equal((await waitReady(base)).schemaVersion, 3);
    assert.doesNotMatch(srv.log(), /升級前的備份/);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.bak')).length, 1);
    const again = await (await fetch(`${base}/api/v1/snapshot`, { headers: auth })).json();
    assert.equal(again.snapshot.vehicles[0].custodian, '總務');
    await stop(srv.child);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
