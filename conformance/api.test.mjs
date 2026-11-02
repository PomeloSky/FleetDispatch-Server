// FleetDispatch Server API v1 相容性測試（docs/protocol.md）。三種主機實作都必須通過。
//
// 對一台「全新、空的」主機執行（測試會建立管理員並寫入資料）：
//   FD_BASE=http://127.0.0.1:8080 FD_SETUP_TOKEN=<設定碼> node --test conformance/
// 配對嘗試次數限制的測試會讓這個 IP 在 15 分鐘內無法配對，放在最後；設 FD_SKIP_RATE_LIMIT=1 可略過。

import assert from 'node:assert/strict';
import { test } from 'node:test';

const BASE = (process.env.FD_BASE ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const SETUP = process.env.FD_SETUP_TOKEN ?? '';
const APPLE = 978307200;
const nowApple = () => Date.now() / 1000 - APPLE;

const uuid = () => crypto.randomUUID().toUpperCase();
const ids = {
  admin: uuid(), driver: uuid(), viewer: uuid(), driver2: uuid(),
  v1: uuid(), v2: uuid(), d1: uuid(), d2: uuid(),
  t1: uuid(), t2: uuid(), t3: uuid(), t4: uuid(), t5: uuid(),
  r1: uuid(), r2: uuid(), i1: uuid(), m1: uuid(), p1: uuid(),
};
const tokens = {};
let codeIds = {};

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v1/${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _text: text };
  }
  return { status: res.status, json, headers: res.headers };
}

const expectError = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.json));
  assert.equal(r.json?.error?.code, code, JSON.stringify(r.json));
  assert.equal(typeof r.json.error.message, 'string');
};

// ───────── 資料內容（App 的資料格式；主機只讀少數欄位） ─────────
const vehicle = (id, plate, t = nowApple()) => ({
  entityUUID: id, plateNumber: plate, custodian: '', vehicleType: 'car', isElectric: false, fuelType: 'gas', brand: 'Toyota',
  modelYear: 2022, vin: '', lastModifiedAt: t,
});
const driver = (id, name, t = nowApple()) => ({
  entityUUID: id, name, licenseNumber: 'L-' + name, licenseExpiryDate: 900000000, phoneNumber: '0912-000-000', notes: '備註', lastModifiedAt: t,
});
const trip = (id, { driverUuid, driverName = '', plate = 'ABC-1234', completed = false, t = nowApple() } = {}) => ({
  entityUUID: id, startTime: t - 600, endTime: t, odometerStart: 1000, odometerEnd: 0, origin: '總公司', destinations: ['新竹'], mission: '送貨',
  fuelAmount: 0, fuelCost: 0, tollCost: 0, parkingCost: 0, fuelType: '', didSwapBattery: false, driver: driverName, isCompleted: completed,
  lastModifiedAt: t, costCenter: '', vehiclePlateNumber: plate, ...(driverUuid ? { driverEntityUUID: driverUuid } : {}),
});
const request = (id, deviceId, { status = 'pending', t = nowApple(), ...extra } = {}) => ({
  entityUUID: id, requestedAt: t, requestedBy: '王小明', requestedByDeviceID: deviceId, plannedStartTime: t + 3600, plannedEndTime: t + 7200,
  origin: '總公司', destinations: ['台南'], mission: '拜訪客戶', status, lastModifiedAt: t, ...extra,
});
const inspection = (id, driverName, t = nowApple()) => ({
  entityUUID: id, driverName, vehiclePlateNumber: 'ABC-1234', status: 'pass', lastModifiedAt: t,
});
const maintenance = (id, plate, t = nowApple()) => ({ entityUUID: id, vehiclePlateNumber: plate, maintenanceDate: t, lastModifiedAt: t });

const ev = (entity, operation, entityID, payload, timestamp) => ({
  id: uuid(),
  timestamp: timestamp ?? (payload ? payload.lastModifiedAt : nowApple()),
  actor: 'conformance',
  entity,
  operation,
  entityID,
  payloadJSON: payload ? JSON.stringify(payload) : '',
});

/** 新資料：entityID 與內容的 entityUUID 相同。 */
const fresh = (entity, operation, build) => {
  const id = uuid();
  return ev(entity, operation, id, build(id));
};

async function send(token, ...events) {
  const r = await api('POST', 'events', { token, body: { events } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.results.length, events.length);
  r.json.results.forEach((res, i) => assert.equal(res.id, events[i].id));
  assert.equal(typeof r.json.cursor, 'number');
  return r.json.results;
}

const statuses = (results) => results.map((r) => (r.status === 'rejected' ? `rejected:${r.reason}` : r.status));

async function snapshot(token) {
  const r = await api('GET', 'snapshot', { token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

async function allChanges(token, since = 0, limit = 1000) {
  const out = [];
  let cursor = since;
  for (;;) {
    const r = await api('GET', `changes?since=${cursor}&limit=${limit}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    out.push(...r.json.changes);
    assert.ok(r.json.cursor >= cursor);
    cursor = r.json.cursor;
    if (!r.json.hasMore) return { changes: out, cursor };
  }
}

test('FleetDispatch Server API v1', async (t) => {
  assert.ok(SETUP.length >= 16, '請設定 FD_SETUP_TOKEN（主機部署時的設定碼）');

  await t.test('info：產品、版本、需要第一次設定', async () => {
    const r = await api('GET', 'info');
    assert.equal(r.status, 200);
    assert.equal(r.json.product, 'FleetDispatch Server');
    assert.equal(r.json.apiVersion, 1);
    assert.match(r.json.serverVersion, /^\d+\.\d+\.\d+/);
    assert.ok(['cloudflare', 'php', 'docker'].includes(r.json.variant));
    assert.match(r.json.serverId, /^[0-9A-F-]{36}$/);
    assert.equal(r.json.setupRequired, true, '請對全新、空的主機執行');
    assert.equal(r.json.setupConfigured, true);
    assert.ok(Math.abs(r.json.time - Date.now()) < 120000);
    assert.equal(r.json.limits.maxEventsPerRequest, 500);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });

  await t.test('錯誤格式：404、405、401', async () => {
    expectError(await api('GET', 'nope'), 404, 'not_found');
    expectError(await api('GET', 'pair'), 405, 'method_not_allowed');
    expectError(await api('GET', 'session'), 401, 'unauthorized');
    expectError(await api('GET', 'session', { token: 'x'.repeat(43) }), 401, 'unauthorized');
    expectError(await api('POST', 'pair', { raw: '{bad json' }), 400, 'invalid_request');
    expectError(await api('POST', 'pair', { body: { code: SETUP, deviceId: 'not-a-uuid', deviceName: 'X' } }), 400, 'invalid_request');
  });

  await t.test('第一次設定：設定碼錯誤 → invalid_code；正確 → 管理員；之後設定碼失效', async () => {
    expectError(await api('POST', 'pair', { body: { code: 'wrong-setup-token-xxxx', deviceId: ids.admin, deviceName: '管理員 Mac', platform: 'macos' } }), 401, 'invalid_code');
    const r = await api('POST', 'pair', { body: { code: SETUP, deviceId: ids.admin.toLowerCase(), deviceName: '管理員 Mac', platform: 'macos' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.role, 'admin');
    assert.equal(r.json.deviceId, ids.admin);
    assert.equal(r.json.driverBinding, null);
    assert.match(r.json.token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(r.json.tokenExpiresAt > Date.now() + 80 * 86400000);
    assert.equal(typeof r.json.server.id, 'string');
    tokens.admin = r.json.token;
    assert.equal((await api('GET', 'info')).json.setupRequired, false);
    expectError(await api('POST', 'pair', { body: { code: SETUP, deviceId: uuid(), deviceName: '另一台' } }), 401, 'invalid_code');
  });

  await t.test('session', async () => {
    const r = await api('GET', 'session', { token: tokens.admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.deviceId, ids.admin);
    assert.equal(r.json.deviceName, '管理員 Mac');
    assert.equal(r.json.role, 'admin');
    assert.equal(r.json.driverBinding, null);
    assert.ok(r.json.server.time > 0);
  });

  await t.test('配對碼：建立、列出、配對（忽略大小寫與連字號）、單次有效', async () => {
    const mk = async (body) => {
      const r = await api('POST', 'admin/pairing-codes', { token: tokens.admin, body });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.match(r.json.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
      assert.ok(r.json.expiresAt > Date.now());
      return r.json;
    };
    expectError(await api('POST', 'admin/pairing-codes', { token: tokens.admin, body: { role: 'owner' } }), 400, 'invalid_request');
    expectError(await api('POST', 'admin/pairing-codes', { token: tokens.admin, body: { role: 'viewer', ttlMinutes: 1 } }), 400, 'invalid_request');
    expectError(
      await api('POST', 'admin/pairing-codes', { token: tokens.admin, body: { role: 'driver', driverBinding: { driverUuid: ids.d1, driverName: '  ' } } }),
      400,
      'invalid_request',
    );
    const dc = await mk({ role: 'driver', driverBinding: { driverUuid: ids.d1.toLowerCase(), driverName: '王小明' }, label: '王小明的手機' });
    assert.deepEqual(dc.driverBinding, { driverUuid: ids.d1, driverName: '王小明' });
    const vc = await mk({ role: 'viewer', driverBinding: { driverUuid: ids.d1, driverName: '王小明' } });
    assert.equal(vc.driverBinding, null, '只有駕駛能綁定');
    const d2c = await mk({ role: 'driver', ttlMinutes: 60 });
    const spare = await mk({ role: 'viewer' });
    codeIds = { spare: spare.id };

    const list = await api('GET', 'admin/pairing-codes', { token: tokens.admin });
    assert.equal(list.status, 200);
    assert.equal(list.json.codes.length, 4);
    assert.ok(list.json.codes.every((c) => !('code' in c)), '配對碼本身不能再取得');

    const pd = await api('POST', 'pair', { body: { code: dc.code.replace('-', '').toLowerCase(), deviceId: ids.driver, deviceName: '王小明的 iPhone', platform: 'ios' } });
    assert.equal(pd.status, 200, JSON.stringify(pd.json));
    assert.equal(pd.json.role, 'driver');
    assert.deepEqual(pd.json.driverBinding, { driverUuid: ids.d1, driverName: '王小明' });
    tokens.driver = pd.json.token;

    expectError(await api('POST', 'pair', { body: { code: dc.code, deviceId: uuid(), deviceName: '重用' } }), 401, 'invalid_code');

    const pv = await api('POST', 'pair', { body: { code: ` ${vc.code} `, deviceId: ids.viewer, deviceName: '檢視者 iPad', platform: 'ipados' } });
    assert.equal(pv.status, 200, JSON.stringify(pv.json));
    assert.equal(pv.json.role, 'viewer');
    tokens.viewer = pv.json.token;

    const p2 = await api('POST', 'pair', { body: { code: d2c.code, deviceId: ids.driver2, deviceName: '未綁定的駕駛', platform: 'android' } });
    assert.equal(p2.status, 200);
    assert.equal(p2.json.driverBinding, null);
    tokens.driver2 = p2.json.token;

    // 同一台裝置仍有有效權杖：device_conflict（不消耗配對碼）。
    expectError(await api('POST', 'pair', { body: { code: spare.code, deviceId: ids.driver, deviceName: '又配一次' } }), 409, 'device_conflict');
    assert.equal((await api('GET', 'admin/pairing-codes', { token: tokens.admin })).json.codes.length, 1);
  });

  await t.test('權限：非管理員不能用管理端點', async () => {
    expectError(await api('GET', 'admin/devices', { token: tokens.driver }), 403, 'forbidden');
    expectError(await api('POST', 'admin/pairing-codes', { token: tokens.viewer, body: { role: 'admin' } }), 403, 'forbidden');
  });

  await t.test('事件：管理員建立資料；格式錯誤被拒絕', async () => {
    const results = await send(
      tokens.admin,
      ev('vehicle', 'create', ids.v1, vehicle(ids.v1, 'ABC-1234')),
      ev('driver', 'create', ids.d1, driver(ids.d1, '王小明')),
      ev('driver', 'create', ids.d2, driver(ids.d2, '陳小華')),
      ev('trip', 'create', ids.t1, trip(ids.t1, { driverUuid: ids.d1, driverName: '王小明' })),
      ev('trip', 'create', ids.t2, trip(ids.t2, { driverUuid: ids.d2, driverName: '陳小華' })),
      ev('trip', 'create', ids.t3.toLowerCase(), trip(ids.t3, { driverName: '王小明' })),
      ev('part', 'create', ids.p1, { entityUUID: ids.p1, name: '機油', lastModifiedAt: nowApple() }),
      { ...fresh('trip', 'create', (id) => trip(id)), entityID: uuid() },
      { ...ev('trip', 'create', uuid(), null), payloadJSON: '[1,2]' },
      { ...ev('truck', 'create', uuid(), null), payloadJSON: '{}' },
      { ...ev('trip', 'update', uuid(), trip(uuid())), entityID: 'bad' },
    );
    assert.deepEqual(statuses(results), [
      'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied',
      'rejected:invalid-payload', 'rejected:invalid-payload', 'rejected:invalid-payload', 'rejected:invalid-payload',
    ]);
  });

  await t.test('最後寫入者勝：較舊的被忽略、較新的寫入；刪除不存在的被忽略', async () => {
    const old = trip(ids.t1, { driverUuid: ids.d1, driverName: '王小明', t: nowApple() - 3600 });
    old.mission = '舊的';
    const newer = trip(ids.t1, { driverUuid: ids.d1, driverName: '王小明', t: nowApple() });
    newer.mission = '新的';
    assert.deepEqual(statuses(await send(tokens.admin, ev('trip', 'update', ids.t1, old), ev('trip', 'update', ids.t1, newer))), ['ignored', 'applied']);
    assert.deepEqual(statuses(await send(tokens.admin, ev('trip', 'update', ids.t1, newer))), ['ignored'], '相同時間不覆寫');
    assert.deepEqual(statuses(await send(tokens.admin, ev('part', 'delete', uuid(), null))), ['ignored']);
    const s = await snapshot(tokens.admin);
    assert.equal(s.snapshot.trips.find((x) => x.entityUUID === ids.t1).mission, '新的');
  });

  await t.test('時間校正：未來的時間壓回主機時間並回送', async () => {
    const future = trip(ids.t1, { driverUuid: ids.d1, driverName: '王小明', t: nowApple() + 7200 });
    const [res] = await send(tokens.admin, ev('trip', 'update', ids.t1, future));
    assert.equal(res.status, 'applied');
    assert.ok(res.event, '需要回送校正後的事件');
    assert.ok(res.event.timestamp <= nowApple() + 5);
    const payload = JSON.parse(res.event.payloadJSON);
    assert.ok(payload.lastModifiedAt <= nowApple() + 5);
    assert.equal(payload.entityUUID, ids.t1);
    assert.equal(payload.mission, '送貨');
  });

  await t.test('快照：十個陣列、authoritative；管理員看到完整個資', async () => {
    const s = await snapshot(tokens.admin);
    for (const k of ['trips', 'vehicles', 'drivers', 'tripRequests', 'maintenanceRecords', 'maintenanceItems', 'presets', 'parts', 'workOrders', 'inspections']) {
      assert.ok(Array.isArray(s.snapshot[k]), k);
    }
    assert.equal(s.snapshot.authoritative, true);
    assert.equal(s.snapshot.trips.length, 3);
    assert.equal(s.snapshot.vehicles.length, 1);
    assert.equal(s.snapshot.parts.length, 1);
    const d1 = s.snapshot.drivers.find((d) => d.entityUUID === ids.d1);
    assert.equal(d1.phoneNumber, '0912-000-000');
    assert.equal(d1.licenseExpiryDate, 900000000);
    assert.equal(s.session.role, 'admin');
    assert.equal(typeof s.cursor, 'number');
  });

  await t.test('檢視者：看到全部車趟、駕駛人個資被遮蔽、不能寫入', async () => {
    const s = await snapshot(tokens.viewer);
    assert.equal(s.snapshot.trips.length, 3);
    for (const d of s.snapshot.drivers) {
      assert.equal(d.phoneNumber, '');
      assert.equal(d.licenseNumber, '');
      assert.equal(d.notes, '');
      assert.equal('licenseExpiryDate' in d, false);
      assert.ok(d.name.length > 0);
    }
    assert.deepEqual(statuses(await send(tokens.viewer, fresh('trip', 'create', (id) => trip(id)))), ['rejected:role']);
  });

  await t.test('駕駛（已綁定）：只看到自己的車趟；可以建立與修改自己的；不能改別人的、改派、刪除、管理資料', async () => {
    let s = await snapshot(tokens.driver);
    assert.deepEqual(s.snapshot.trips.map((x) => x.entityUUID).sort(), [ids.t1, ids.t3].sort(), 'UUID 相同或沒有 UUID 時姓名相同');
    const d1 = s.snapshot.drivers.find((d) => d.entityUUID === ids.d1);
    const d2 = s.snapshot.drivers.find((d) => d.entityUUID === ids.d2);
    assert.equal(d1.phoneNumber, '0912-000-000', '綁定的駕駛人完整');
    assert.equal(d2.phoneNumber, '', '其他駕駛人遮蔽');
    assert.equal(s.snapshot.vehicles.length, 1);
    assert.equal(s.session.role, 'driver');
    assert.deepEqual(s.session.driverBinding, { driverUuid: ids.d1, driverName: '王小明' });

    const reassigned = trip(ids.t1, { driverUuid: ids.d2, driverName: '陳小華' });
    const othersTrip = trip(ids.t2, { driverUuid: ids.d2, driverName: '陳小華' });
    const takeOver = trip(ids.t2, { driverUuid: ids.d1, driverName: '王小明' });
    const results = await send(
      tokens.driver,
      ev('trip', 'create', ids.t4, trip(ids.t4, { driverUuid: ids.d1, driverName: '王小明' })),
      ev('trip', 'update', ids.t3, trip(ids.t3, { driverName: '王小明' })),
      ev('trip', 'update', ids.t2, othersTrip),
      ev('trip', 'update', ids.t2, takeOver),
      ev('trip', 'update', ids.t1, reassigned),
      ev('trip', 'create', ids.t2, { ...takeOver, lastModifiedAt: nowApple() + 1 }),
      fresh('trip', 'create', (id) => trip(id, { driverUuid: ids.d2, driverName: '陳小華' })),
      ev('trip', 'delete', ids.t1, null),
      fresh('vehicle', 'create', (id) => vehicle(id, 'DRV-0001')),
      ev('part', 'update', ids.p1, { entityUUID: ids.p1, name: '改名', lastModifiedAt: nowApple() }),
    );
    assert.deepEqual(statuses(results), [
      'applied', 'applied', 'rejected:not-own-trip', 'rejected:not-own-trip', 'rejected:not-own-trip', 'rejected:not-own-trip',
      'rejected:not-own-trip', 'rejected:role', 'rejected:role', 'rejected:role',
    ], '標示 create 也不能覆寫主機上已有的別人的車趟；已綁定時不能替別人建立');
    s = await snapshot(tokens.driver);
    assert.deepEqual(s.snapshot.trips.map((x) => x.entityUUID).sort(), [ids.t1, ids.t3, ids.t4].sort());
  });

  await t.test('駕駛（未綁定）：可以建立車趟、只能修改自己建立的；收不到任何車趟', async () => {
    const s = await snapshot(tokens.driver2);
    assert.equal(s.snapshot.trips.length, 0);
    const own = uuid();
    ids.own2 = own;
    ids.r3 = uuid();
    const results = await send(
      tokens.driver2,
      // 時間都在過去且先後分明（不依賴主機的時間校正，避免同一毫秒內處理時兩者時間相同）。
      ev('trip', 'create', own, trip(own, { driverName: '路人', t: nowApple() - 10 })),
      ev('trip', 'update', own, { ...trip(own, { driverName: '路人', t: nowApple() - 5 }), mission: '改自己的' }),
      ev('trip', 'update', ids.t1, { ...trip(ids.t1, { driverUuid: ids.d1, driverName: '王小明' }), mission: '偷改', lastModifiedAt: nowApple() + 2 }),
      ev('trip', 'create', ids.t1, { ...trip(ids.t1, { driverUuid: ids.d1, driverName: '王小明' }), mission: '偷改', lastModifiedAt: nowApple() + 3 }),
    );
    assert.deepEqual(statuses(results), ['applied', 'applied', 'rejected:not-own-trip', 'rejected:not-own-trip']);
    assert.equal((await snapshot(tokens.driver2)).snapshot.trips.length, 0);
    assert.deepEqual(statuses(await send(tokens.driver2, ev('tripRequest', 'create', ids.r3, request(ids.r3, ids.driver2)))), ['applied']);
    assert.deepEqual((await snapshot(tokens.driver2)).snapshot.tripRequests.map((r) => r.entityUUID), [ids.r3]);
  });

  await t.test('用車申請：駕駛只能送自己的待核准申請、只能取消；管理員核准後不能再改', async () => {
    // 建立時間放在過去：之後管理員核准（時間被主機校正為現在）一定比它新。
    const mine = request(ids.r2, ids.driver.toLowerCase(), { t: nowApple() - 60 });
    const results = await send(
      tokens.driver,
      ev('tripRequest', 'create', ids.r1, request(ids.r1, ids.viewer)),
      fresh('tripRequest', 'create', (id) => request(id, ids.driver, { status: 'approved' })),
      fresh('tripRequest', 'create', (id) => request(id, ids.driver, { approvedBy: '自己' })),
      ev('tripRequest', 'create', ids.r2, mine),
      ev('tripRequest', 'create', ids.r2, { ...mine, lastModifiedAt: nowApple() + 1 }),
    );
    assert.deepEqual(statuses(results), [
      'rejected:requester-mismatch', 'rejected:create-must-be-pending', 'rejected:approval-fields-not-allowed', 'applied', 'rejected:request-already-exists',
    ]);
    const approveSelf = request(ids.r2, ids.driver, { status: 'approved', t: nowApple() + 2 });
    assert.deepEqual(statuses(await send(tokens.driver, ev('tripRequest', 'update', ids.r2, approveSelf))), ['rejected:status-transition-not-allowed']);
    const approved = request(ids.r2, ids.driver, { status: 'approved', approvedBy: '管理員', approvedAt: nowApple(), resultingTripUUID: ids.t4, t: nowApple() + 3 });
    assert.deepEqual(statuses(await send(tokens.admin, ev('tripRequest', 'update', ids.r2, approved))), ['applied']);
    const cancel = request(ids.r2, ids.driver, { status: 'cancelled', t: nowApple() + 4 });
    assert.deepEqual(statuses(await send(tokens.driver, ev('tripRequest', 'update', ids.r2, cancel))), ['rejected:request-not-pending']);
    assert.deepEqual(statuses(await send(tokens.driver, ev('tripRequest', 'delete', ids.r2, null))), ['rejected:only-admin-can-delete']);
    const s = await snapshot(tokens.driver);
    assert.deepEqual(s.snapshot.tripRequests.map((r) => r.entityUUID), [ids.r2]);
    assert.equal((await snapshot(tokens.viewer)).snapshot.tripRequests.length, 2);
  });

  await t.test('巡檢：綁定的駕駛只能送自己的，不能把別人的巡檢改成自己的', async () => {
    const others = uuid();
    assert.deepEqual(statuses(await send(tokens.admin, ev('inspection', 'create', others, inspection(others, '陳小華')))), ['applied']);
    const results = await send(
      tokens.driver,
      ev('inspection', 'create', ids.i1, inspection(ids.i1, '王小明')),
      fresh('inspection', 'create', (id) => inspection(id, '陳小華')),
      ev('inspection', 'update', others, inspection(others, '王小明', nowApple() + 1)),
      ev('inspection', 'create', others, inspection(others, '王小明', nowApple() + 2)),
    );
    assert.deepEqual(statuses(results), ['applied', 'rejected:not-own-inspection', 'rejected:not-own-inspection', 'rejected:not-own-inspection']);
    assert.equal((await snapshot(tokens.driver)).snapshot.inspections.length, 1);
    const unbound = await send(tokens.driver2, ev('inspection', 'update', ids.i1, inspection(ids.i1, '路人', nowApple() + 3)));
    assert.deepEqual(statuses(unbound), ['rejected:not-own-inspection'], '未綁定的駕駛不能改別人建立的巡檢');
  });

  await t.test('增量：依序號、分頁、範圍過濾；墓碑依保留的欄位過濾', async () => {
    const all = await allChanges(tokens.admin, 0, 2);
    const seqs = all.changes.map((c) => c.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(all.changes.map((c) => `${c.entity}/${c.id}`)).size, all.changes.length, '同一筆只出現最新的狀態');
    const t1 = all.changes.find((c) => c.id === ids.t1);
    assert.equal(t1.entity, 'trip');
    assert.equal(t1.deleted, false);
    assert.equal(typeof t1.modifiedAt, 'number');
    assert.equal(t1.payload.entityUUID, ids.t1);

    const empty = await api('GET', `changes?since=${all.cursor}`, { token: tokens.admin });
    assert.deepEqual(empty.json.changes, []);
    assert.equal(empty.json.cursor, all.cursor);
    assert.equal(empty.json.hasMore, false);
    assert.equal((await api('GET', `changes?since=${all.cursor + 1000}`, { token: tokens.admin })).json.cursor, all.cursor);
    expectError(await api('GET', 'changes?since=-1', { token: tokens.admin }), 400, 'invalid_request');

    const mine = await allChanges(tokens.driver);
    assert.ok(!mine.changes.some((c) => c.id === ids.t2), '駕駛收不到別人的車趟');
    assert.equal(mine.changes.find((c) => c.id === ids.d2).payload.phoneNumber, '');

    assert.deepEqual(statuses(await send(tokens.admin, ev('trip', 'delete', ids.t3, null), ev('trip', 'delete', ids.t2, null))), ['applied', 'applied']);
    const after = await allChanges(tokens.driver, mine.cursor);
    const t3 = after.changes.find((c) => c.id === ids.t3);
    assert.equal(t3.deleted, true);
    assert.equal(t3.payload, null);
    assert.ok(!after.changes.some((c) => c.id === ids.t2), '範圍外的墓碑也不送');
    const s = await snapshot(tokens.admin);
    assert.ok(!s.snapshot.trips.some((x) => x.entityUUID === ids.t3), '快照不含墓碑');
    assert.deepEqual(statuses(await send(tokens.admin, ev('trip', 'delete', ids.t3, null))), ['ignored']);

    // 墓碑：比刪除舊的修改不會讓資料復活；不是自己的資料不能藉由重新建立復活。
    const stale = trip(ids.t3, { driverName: '王小明', t: nowApple() - 3600 });
    assert.deepEqual(statuses(await send(tokens.driver, ev('trip', 'update', ids.t3, stale))), ['ignored'], '比刪除舊');
    const revive2 = trip(ids.t2, { driverUuid: ids.d2, driverName: '陳小華', t: nowApple() + 10 });
    assert.deepEqual(statuses(await send(tokens.driver2, ev('trip', 'create', ids.t2, revive2))), ['rejected:not-own-trip'], '未綁定的駕駛不能復活別人建立的');
    assert.deepEqual(statuses(await send(tokens.driver, ev('trip', 'create', ids.t2, revive2))), ['rejected:not-own-trip'], '已綁定的駕駛不能復活別人的');
    assert.ok(!(await snapshot(tokens.admin)).snapshot.trips.some((x) => x.entityUUID === ids.t2));
  });

  await t.test('刪除車輛：同車牌的車趟、保養一併刪除', async () => {
    assert.deepEqual(
      statuses(await send(
        tokens.admin,
        ev('vehicle', 'create', ids.v2, vehicle(ids.v2, 'XYZ-9876')),
        ev('trip', 'create', ids.t5, trip(ids.t5, { plate: 'XYZ-9876', driverUuid: ids.d1, driverName: '王小明' })),
        ev('maintenance', 'create', ids.m1, maintenance(ids.m1, 'XYZ-9876')),
      )),
      ['applied', 'applied', 'applied'],
    );
    const before = (await snapshot(tokens.admin)).cursor;
    assert.deepEqual(statuses(await send(tokens.admin, ev('vehicle', 'delete', ids.v2, null))), ['applied']);
    const ch = await allChanges(tokens.admin, before);
    const deleted = ch.changes.filter((c) => c.deleted).map((c) => `${c.entity}/${c.id}`).sort();
    assert.deepEqual(deleted, [`maintenance/${ids.m1}`, `trip/${ids.t5}`, `vehicle/${ids.v2}`].sort());
    const s = await snapshot(tokens.admin);
    assert.ok(!s.snapshot.trips.some((x) => x.entityUUID === ids.t5));
    assert.equal(s.snapshot.maintenanceRecords.length, 0);
    assert.equal(s.snapshot.vehicles.length, 1);
  });

  await t.test('即時位置：駕駛回報自己進行中的車趟；完成後移除', async () => {
    const loc = { tripUUID: ids.t4, latitude: 25.03, longitude: 121.56, timestamp: nowApple(), speed: 12.5, course: -1 };
    assert.equal((await api('POST', 'locations', { token: tokens.driver, body: loc })).status, 204);
    expectError(await api('POST', 'locations', { token: tokens.driver, body: { ...loc, tripUUID: ids.t2 } }), 403, 'forbidden');
    expectError(await api('POST', 'locations', { token: tokens.viewer, body: loc }), 403, 'forbidden');
    expectError(await api('POST', 'locations', { token: tokens.driver, body: { ...loc, latitude: 200 } }), 400, 'invalid_request');
    const seen = await api('GET', 'locations', { token: tokens.viewer });
    assert.equal(seen.status, 200);
    assert.equal(seen.json.locations.length, 1);
    const l = seen.json.locations[0];
    assert.equal(l.tripUUID, ids.t4);
    assert.equal(l.deviceId, ids.driver);
    assert.equal(l.plateNumber, 'ABC-1234');
    assert.equal(l.speed, 12.5);
    assert.equal(l.course, null);
    assert.equal(l.stale, false);
    assert.equal((await api('GET', 'locations', { token: tokens.driver2 })).json.locations.length, 0);
    const done = trip(ids.t4, { driverUuid: ids.d1, driverName: '王小明', completed: true, t: nowApple() + 1 });
    assert.deepEqual(statuses(await send(tokens.driver, ev('trip', 'update', ids.t4, done))), ['applied']);
    assert.equal((await api('GET', 'locations', { token: tokens.admin })).json.locations.length, 0);
  });

  await t.test('裝置管理：改角色與綁定、解除配對立即失效、最後一位管理員受保護', async () => {
    const list = await api('GET', 'admin/devices', { token: tokens.admin });
    assert.equal(list.status, 200);
    assert.equal(list.json.devices.length, 4);
    const dv = list.json.devices.find((d) => d.deviceId === ids.viewer);
    assert.equal(dv.role, 'viewer');
    assert.equal(dv.platform, 'ipados');
    assert.equal(dv.revokedAt, null);

    const p = await api('PATCH', `admin/devices/${ids.viewer}`, { token: tokens.admin, body: { role: 'driver', driverBinding: { driverUuid: ids.d2, driverName: '陳小華' } } });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal(p.json.role, 'driver');
    assert.deepEqual(p.json.driverBinding, { driverUuid: ids.d2, driverName: '陳小華' });
    const sess = await api('GET', 'session', { token: tokens.viewer });
    assert.equal(sess.json.role, 'driver', '角色改變立即生效');
    const back = await api('PATCH', `admin/devices/${ids.viewer}`, { token: tokens.admin, body: { role: 'viewer' } });
    assert.equal(back.json.driverBinding, null, '不是駕駛時清除綁定');
    expectError(await api('PATCH', `admin/devices/${ids.viewer}`, { token: tokens.admin, body: { role: 'boss' } }), 400, 'invalid_request');
    expectError(await api('PATCH', `admin/devices/${uuid()}`, { token: tokens.admin, body: { role: 'viewer' } }), 404, 'not_found');

    expectError(await api('PATCH', `admin/devices/${ids.admin}`, { token: tokens.admin, body: { role: 'viewer' } }), 409, 'last_admin');
    expectError(await api('DELETE', `admin/devices/${ids.admin}`, { token: tokens.admin }), 409, 'last_admin');
    expectError(await api('POST', 'unpair', { token: tokens.admin }), 409, 'last_admin');

    assert.equal((await api('DELETE', `admin/devices/${ids.driver2}`, { token: tokens.admin })).status, 204);
    expectError(await api('GET', 'session', { token: tokens.driver2 }), 401, 'unauthorized');
    const revoked = (await api('GET', 'admin/devices', { token: tokens.admin })).json.devices.find((d) => d.deviceId === ids.driver2);
    assert.ok(revoked.revokedAt > 0);
    assert.equal(revoked.tokenExpiresAt, null);
  });

  await t.test('重新配對：以同一個裝置 ID 重新配對，不繼承之前建立的車趟與用車申請', async () => {
    // driver2 已在上一個測試被解除配對。
    const code = await api('POST', 'admin/pairing-codes', { token: tokens.admin, body: { role: 'driver' } });
    const p = await api('POST', 'pair', { body: { code: code.json.code, deviceId: ids.driver2, deviceName: '冒用的裝置', platform: 'android' } });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    const token = p.json.token;
    const edit = { ...trip(ids.own2, { driverName: '路人' }), mission: '冒用', lastModifiedAt: nowApple() + 20 };
    assert.deepEqual(statuses(await send(token, ev('trip', 'update', ids.own2, edit))), ['rejected:not-own-trip']);
    const s = await snapshot(token);
    assert.equal(s.snapshot.tripRequests.length, 0, '看不到之前配對建立的申請');
    const cancel = request(ids.r3, ids.driver2, { status: 'cancelled', t: nowApple() + 21 });
    assert.deepEqual(statuses(await send(token, ev('tripRequest', 'update', ids.r3, cancel))), ['rejected:not-own-request']);
    assert.equal((await api('DELETE', `admin/devices/${ids.driver2}`, { token: tokens.admin })).status, 204);
  });

  await t.test('配對碼刪除、伺服器改名', async () => {
    assert.equal((await api('DELETE', `admin/pairing-codes/${codeIds.spare}`, { token: tokens.admin })).status, 204);
    expectError(await api('DELETE', `admin/pairing-codes/${codeIds.spare}`, { token: tokens.admin }), 404, 'not_found');
    assert.equal((await api('GET', 'admin/pairing-codes', { token: tokens.admin })).json.codes.length, 0);
    const r = await api('PATCH', 'admin/server', { token: tokens.admin, body: { name: '優良運輸' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, '優良運輸');
    assert.equal((await api('GET', 'info')).json.name, '優良運輸');
    expectError(await api('PATCH', 'admin/server', { token: tokens.admin, body: { name: '' } }), 400, 'invalid_request');
  });

  await t.test('稽核紀錄：新的在前、分頁', async () => {
    const r = await api('GET', 'admin/audit?limit=3', { token: tokens.admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.entries.length, 3);
    const ids_ = r.json.entries.map((e) => e.id);
    assert.deepEqual(ids_, [...ids_].sort((a, b) => b - a));
    assert.equal(typeof r.json.next, 'number');
    const e = r.json.entries[0];
    assert.ok(['create', 'update', 'delete'].includes(e.operation));
    assert.equal(typeof e.deviceName, 'string');
    const next = await api('GET', `admin/audit?limit=3&before=${r.json.next}`, { token: tokens.admin });
    assert.ok(next.json.entries.every((x) => x.id < r.json.next));
    const vehicleDelete = (await api('GET', 'admin/audit?limit=500', { token: tokens.admin })).json.entries.find((x) => x.entity === 'vehicle' && x.operation === 'delete');
    assert.equal(vehicleDelete.entityId, ids.v2);
    assert.equal(vehicleDelete.summary, '');
  });

  await t.test('限制：事件太多、裝置自行解除配對', async () => {
    const many = Array.from({ length: 501 }, () => ev('part', 'create', uuid(), null));
    expectError(await api('POST', 'events', { token: tokens.admin, body: { events: many } }), 400, 'invalid_request');
    expectError(await api('POST', 'events', { token: tokens.admin, body: { nope: [] } }), 400, 'invalid_request');
    assert.equal((await api('POST', 'unpair', { token: tokens.viewer })).status, 204);
    expectError(await api('GET', 'session', { token: tokens.viewer }), 401, 'unauthorized');
  });

  await t.test('配對嘗試次數限制：15 分鐘內失敗 10 次後回 429', { skip: process.env.FD_SKIP_RATE_LIMIT === '1' }, async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await api('POST', 'pair', { body: { code: 'ZZZZ-ZZZZ', deviceId: uuid(), deviceName: '猜測' } });
      if (last.status === 429) break;
      expectError(last, 401, 'invalid_code');
    }
    expectError(last, 429, 'rate_limited');
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });
});
