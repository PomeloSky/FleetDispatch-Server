// 網頁管理的資料 API（1.2.0；docs/protocol.md §7.2–7.6）相容性測試。由 api.test.mjs 在同一台主機、以已配對的管理員呼叫：
// 資料清單（搜尋、篩選、排序、分頁）、詳情與關聯、受控修改（預覽、原因、revision、驗證、關聯）、刪除的影響預覽與不可分割的連鎖刪除、
// 用車申請的核准與退回、修改前後歷史（沒有套用的事件摘要、來源、個資遮蔽）、權限。

import assert from 'node:assert/strict';

const APPLE = 978307200;

export async function adminSuite(t, h) {
  const { api, expectError, ev, send, uuid, nowApple, tokens, allChanges } = h;
  const admin = tokens.admin;
  const t0 = Math.floor(nowApple()) - 30 * 86400; // 30 天前，資料的時間都在這之後
  const at = (days, hours = 0) => t0 + days * 86400 + hours * 3600;
  const ms = (apple) => Math.round((apple + APPLE) * 1000);
  const ids = {
    v1: uuid(), v2: uuid(), dA: uuid(), dB: uuid(),
    ta: uuid(), tb: uuid(), tc: uuid(), td: uuid(),
    p1: uuid(), w1: uuid(), w2: uuid(), i1: uuid(), r1: uuid(), r2: uuid(), r3: uuid(), m1: uuid(),
  };
  const P1 = 'ADM-0001';
  const P2 = 'ADM-0002';
  const get = (path) => api('GET', path, { token: admin });
  const post = (path, body) => api('POST', path, { token: admin, body });
  const patch = (path, body) => api('PATCH', path, { token: admin, body });
  const rec = async (entity, id) => {
    const r = await get(`admin/records/${entity}/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.record;
  };

  const vehicle = (id, plate, extra = {}) => ({
    entityUUID: id, plateNumber: plate, custodian: '', vehicleType: 'car', isElectric: false, fuelType: 'gas', brand: 'Toyota',
    modelYear: 2022, vin: '', lastModifiedAt: at(0), ...extra,
  });
  const driver = (id, name) => ({
    entityUUID: id, name, licenseNumber: 'A123456789', phoneNumber: '0912-345-678', notes: '夜班', lastModifiedAt: at(0),
  });
  const trip = (id, { plate = P1, start, done = false, odo = [1000, 0], driverName = '', driverId, dest = ['新竹'], mission = '送貨', costs = [0, 0, 0] }) => ({
    entityUUID: id, startTime: start, endTime: done ? start + 3600 : start, odometerStart: odo[0], odometerEnd: done ? odo[1] : 0,
    origin: '總公司', destinations: dest, mission, fuelAmount: 0, fuelCost: costs[0], tollCost: costs[1], parkingCost: costs[2], fuelType: '',
    didSwapBattery: false, driver: driverName, isCompleted: done, lastModifiedAt: start + 10, vehiclePlateNumber: plate,
    ...(driverId ? { driverEntityUUID: driverId } : {}),
  });

  await t.test('管理：準備資料', async () => {
    const events = [
      ev('vehicle', 'create', ids.v1, vehicle(ids.v1, P1)),
      ev('vehicle', 'create', ids.v2, vehicle(ids.v2, P2, { brand: 'Ford' })),
      ev('driver', 'create', ids.dA, driver(ids.dA, '陳大文')),
      ev('driver', 'create', ids.dB, driver(ids.dB, '林小美')),
      ev('trip', 'create', ids.ta, trip(ids.ta, { start: at(1), done: true, odo: [1000, 1050], driverName: '陳大文', driverId: ids.dA, costs: [300, 40, 0] })),
      ev('trip', 'create', ids.tb, trip(ids.tb, { start: at(2), done: true, odo: [1050, 1170], driverName: '陳大文', driverId: ids.dA, dest: ['台中', '彰化'], mission: '拜訪 ACME 客戶' })),
      ev('trip', 'create', ids.tc, trip(ids.tc, { start: at(3), driverName: '林小美' })),
      ev('trip', 'create', ids.td, trip(ids.td, { plate: P2, start: at(4), done: true, odo: [5000, 5200], driverName: '林小美' })),
      ev('part', 'create', ids.p1, {
        entityUUID: ids.p1, name: '機油濾芯', partNumber: 'OF-9', category: '耗材', unit: '個', unitCost: 300, stockQuantity: 1, reorderThreshold: 2,
        supplier: '', notes: '', createdAt: at(0), lastModifiedAt: at(0),
      }),
      ev('workOrder', 'create', ids.w1, {
        entityUUID: ids.w1, title: '換機油', status: 'open', openedAt: at(1, 2), odometer: 1040, assignedTo: '技師甲', notes: '',
        lines: [{ id: uuid(), kind: 'part', detail: '機油濾芯', quantity: 1, unitCost: 300, partEntityUUID: ids.p1.toLowerCase() }],
        createdAt: at(1, 2), lastModifiedAt: at(1, 2), vehiclePlateNumber: P1,
      }),
      ev('inspection', 'create', ids.i1, {
        entityUUID: ids.i1, type: 'preTrip', date: at(1, 1), odometer: 1000, driverName: '陳大文', overallResult: 'pass', notes: '',
        lines: [], createdAt: at(1, 1), lastModifiedAt: at(1, 1), vehiclePlateNumber: P1,
      }),
      ev('maintenance', 'create', ids.m1, {
        entityUUID: ids.m1, maintenanceDate: at(5), odometerReading: 1170, intervalKm: 5000, notes: '', cost: 1500, createdAt: at(5),
        lastModifiedAt: at(5), vehiclePlateNumber: P2,
      }),
      ev('tripRequest', 'create', ids.r1, {
        entityUUID: ids.r1, requestedAt: at(6), requestedBy: '陳大文', requestedByDeviceID: uuid(), plannedStartTime: at(7), plannedEndTime: at(7, 3),
        origin: '總公司', destinations: ['台南'], mission: '拜訪客戶', vehiclePlateNumber: P2, status: 'pending', lastModifiedAt: at(6),
      }),
      ev('tripRequest', 'create', ids.r2, {
        entityUUID: ids.r2, requestedAt: at(6, 1), requestedBy: '林小美', requestedByDeviceID: uuid(), plannedStartTime: at(8), plannedEndTime: at(8, 2),
        origin: '總公司', destinations: ['高雄'], mission: '送件', vehiclePlateNumber: P1, status: 'pending', lastModifiedAt: at(6, 1),
      }),
    ];
    const results = await send(admin, ...events);
    assert.ok(results.every((r) => r.status === 'applied'), JSON.stringify(results));
  });

  await t.test('管理：資料規格（只有管理員）', async () => {
    const r = await get('admin/schema');
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 1);
    assert.equal(Object.keys(r.json.entities).length, 10);
    const odo = r.json.entities.trip.fields.find((f) => f.key === 'odometerEnd');
    assert.equal(odo.edit, true);
    assert.equal(r.json.entities.vehicle.fields.find((f) => f.key === 'plateNumber').edit, undefined, '車牌不能在網頁修改');
    assert.ok(Array.isArray(r.json.reasons));
    expectError(await api('GET', 'admin/schema', { token: tokens.driver }), 403, 'forbidden');
  });

  await t.test('管理：資料清單——篩選、排序、分頁、搜尋', async () => {
    const list = async (q) => {
      const r = await get(`admin/records?${q}`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return r.json;
    };
    let r = await list(`entity=trip&plate=${P1}`);
    assert.equal(r.total, 3);
    assert.deepEqual(r.records.map((x) => x.id), [ids.tc, ids.tb, ids.ta], '預設依出車時間新到舊');
    const first = r.records[2];
    assert.equal(first.entity, 'trip');
    assert.equal(first.revision, 1);
    assert.equal(first.deleted, false);
    assert.equal(typeof first.seq, 'number');
    assert.equal(first.updatedBy.deviceId, h.ids.admin);
    assert.equal(first.updatedBy.name, '管理員 Mac');
    assert.equal(first.payload.mission, '送貨');

    r = await list(`entity=trip&plate=${P1}&sort=distance&order=desc`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.tb, ids.ta, ids.tc], '里程大到小，出車中（沒有里程）在最後');
    r = await list(`entity=trip&plate=${P1}&sort=distance&order=asc`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.ta, ids.tb, ids.tc], '沒有值的不論升降冪都在最後');
    r = await list(`entity=trip&plate=${P1}&status=active`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.tc]);
    r = await list(`entity=trip&status=completed&driverId=${ids.dA}`);
    assert.deepEqual(r.records.map((x) => x.id).sort(), [ids.ta, ids.tb].sort());
    r = await list(`entity=trip&q=${encodeURIComponent('acme')}`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.tb], '英文字母不分大小寫');
    r = await list(`entity=trip&q=${encodeURIComponent('彰化\u3000陳大文')}`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.tb], '多個字詞都要符合（全形空白也能分開）');
    r = await list(`entity=trip&from=${ms(at(2))}&to=${ms(at(3))}`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.tb], '時間範圍：含開始、不含結束');
    r = await list(`entity=trip&plate=${P1}&limit=1&offset=1`);
    assert.equal(r.total, 3);
    assert.equal(r.limit, 1);
    assert.equal(r.offset, 1);
    assert.deepEqual(r.records.map((x) => x.id), [ids.tb]);
    r = await list(`entity=trip&sort=cost&order=desc&plate=${P1}`);
    assert.equal(r.records[0].id, ids.ta);
    r = await list('entity=part&status=low');
    assert.ok(r.records.some((x) => x.id === ids.p1), '低於安全庫存');
    r = await list(`entity=inspection&driverId=${ids.dA}`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.i1]);
    r = await list(`entity=tripRequest&driverId=${ids.dB}`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.r2]);
    r = await list('entity=vehicle&q=adm-000');
    assert.deepEqual(r.records.map((x) => x.payload.plateNumber), [P1, P2], '車輛預設依車牌');
    r = await list(`entity=trip&deviceId=${h.ids.admin}&plate=${P2}`);
    assert.deepEqual(r.records.map((x) => x.id), [ids.td], '這台裝置（這次配對）建立的資料');

    expectError(await get('admin/records'), 400, 'invalid_request');
    expectError(await get('admin/records?entity=nope'), 400, 'invalid_request');
    expectError(await get('admin/records?entity=trip&sort=nope'), 400, 'invalid_request');
    expectError(await get('admin/records?entity=trip&status=nope'), 400, 'invalid_request');
    expectError(await get('admin/records?entity=trip&order=up'), 400, 'invalid_request');
    expectError(await get(`admin/records?entity=trip&q=${'x'.repeat(101)}`), 400, 'invalid_request');
    expectError(await get('admin/records?entity=vehicle&driverId=' + ids.dA), 400, 'invalid_request');
    expectError(await get('admin/records?entity=trip&driverId=' + uuid()), 404, 'not_found');
    expectError(await api('GET', 'admin/records?entity=trip', { token: tokens.driver }), 403, 'forbidden');
  });

  await t.test('管理：詳情與關聯', async () => {
    let r = await get(`admin/records/vehicle/${ids.v1.toLowerCase()}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.record.id, ids.v1);
    const rel = r.json.related;
    assert.equal(rel.trips.total, 3);
    assert.deepEqual(rel.trips.records.map((x) => x.id), [ids.tc, ids.tb, ids.ta]);
    assert.equal(rel.workOrders.total, 1);
    assert.equal(rel.inspections.total, 1);
    assert.equal(rel.maintenance.total, 0);
    assert.equal(rel.tripRequests.total, 1);
    assert.equal(rel.tripRequests.records[0].id, ids.r2);

    r = await get(`admin/records/driver/${ids.dA}`);
    assert.equal(r.json.related.trips.total, 2);
    assert.equal(r.json.related.inspections.total, 1);
    assert.equal(r.json.related.tripRequests.total, 1);
    assert.deepEqual(r.json.related.devices, []);

    r = await get(`admin/records/trip/${ids.ta}`);
    assert.equal(r.json.related.vehicles.records[0].id, ids.v1);
    assert.equal(r.json.related.drivers.records[0].id, ids.dA);
    assert.deepEqual(r.json.related.inspections.records.map((x) => x.id), [ids.i1], '同車、出車前後 1 天內的巡檢');
    assert.deepEqual(r.json.related.workOrders.records.map((x) => x.id), [ids.w1], '同車、期間內開著的工單');
    assert.equal(r.json.location, null);

    r = await get(`admin/records/workOrder/${ids.w1}`);
    assert.deepEqual(r.json.related.parts.records.map((x) => x.id), [ids.p1]);
    r = await get(`admin/records/part/${ids.p1}`);
    assert.deepEqual(r.json.related.workOrders.records.map((x) => x.id), [ids.w1]);
    r = await get(`admin/records/inspection/${ids.i1}`);
    assert.equal(r.json.related.drivers.records[0].id, ids.dA);
    assert.deepEqual(r.json.related.trips.records.map((x) => x.id), [ids.tb, ids.ta], '同車、巡檢前後 1 天內出車的車趟');

    expectError(await get(`admin/records/trip/${uuid()}`), 404, 'not_found');
    expectError(await get('admin/records/trip/not-a-uuid'), 400, 'invalid_request');
    expectError(await get(`admin/records/nope/${uuid()}`), 400, 'invalid_request');
  });

  await t.test('管理：受控修改——預覽、原因、revision、欄位與規則的驗證', async () => {
    const before = await rec('trip', ids.ta);
    const cursor = (await allChanges(admin)).cursor;
    // 預覽：不寫入
    let r = await patch(`admin/records/trip/${ids.ta}`, { expectedRevision: 1, changes: { odometerEnd: 1080 }, dryRun: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.dryRun, true);
    assert.deepEqual(r.json.changedFields, ['odometerEnd']);
    assert.equal(r.json.before.odometerEnd, 1050);
    assert.equal(r.json.after.odometerEnd, 1080);
    assert.equal((await rec('trip', ids.ta)).revision, 1, '預覽不寫入');
    assert.equal((await allChanges(admin, cursor)).changes.length, 0);

    expectError(await patch(`admin/records/trip/${ids.ta}`, { expectedRevision: 1, changes: { odometerEnd: 1080 } }), 400, 'invalid_request');
    r = await patch(`admin/records/trip/${ids.ta}`, { expectedRevision: 0, changes: { odometerEnd: 1080 }, reason: '更正' });
    expectError(r, 409, 'revision_mismatch');
    assert.equal(r.json.error.current.revision, 1);
    const bad = async (changes, field) => {
      const x = await patch(`admin/records/trip/${ids.ta}`, { expectedRevision: 1, changes, reason: '測試' });
      expectError(x, 400, 'invalid_changes');
      assert.equal(typeof x.json.error.fields[field], 'string', JSON.stringify(x.json));
    };
    await bad({ entityUUID: uuid() }, 'entityUUID');
    await bad({ odometerEnd: 900 }, 'odometerEnd');
    await bad({ odometerEnd: -1 }, 'odometerEnd');
    await bad({ endTime: at(0) }, 'endTime');
    await bad({ isCompleted: false }, 'isCompleted');
    await bad({ mission: 123 }, 'mission');
    await bad({ fuelType: '核能' }, 'fuelType');
    await bad({ vehiclePlateNumber: 'NOPE-9999' }, 'vehiclePlateNumber');
    await bad({ driverEntityUUID: uuid() }, 'driverEntityUUID');
    await bad({ destinations: Array.from({ length: 21 }, (_, i) => `點${i}`) }, 'destinations');
    const same = await patch(`admin/records/trip/${ids.ta}`, { expectedRevision: 1, changes: { mission: '送貨' }, reason: '測試' });
    expectError(same, 400, 'invalid_changes');
    assert.equal(typeof same.json.error.fields._, 'string', '內容沒有變更');

    // 寫入：版本 +1、App 以增量同步取得、修改前後歷史（來源 web、原因）與稽核紀錄
    r = await patch(`admin/records/trip/${ids.ta}`, {
      expectedRevision: 1, changes: { odometerEnd: 1080, mission: '  送貨（改）  ', driverEntityUUID: ids.dB.toLowerCase() }, reason: '依單據修正',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.record.revision, 2);
    assert.deepEqual(r.json.changedFields, ['driver', 'driverEntityUUID', 'mission', 'odometerEnd']);
    const p = r.json.record.payload;
    assert.equal(p.odometerEnd, 1080);
    assert.equal(p.mission, '送貨（改）', '前後空白去除');
    assert.equal(p.driverEntityUUID, ids.dB);
    assert.equal(p.driver, '林小美', '駕駛人的姓名一併更新');
    assert.ok(p.lastModifiedAt > before.payload.lastModifiedAt);
    assert.equal(p.origin, '總公司', '其他欄位不變');
    const ch = (await allChanges(admin, cursor)).changes;
    assert.equal(ch.length, 1);
    assert.equal(ch[0].id, ids.ta);
    assert.equal(ch[0].revision, 2);
    assert.equal(ch[0].payload.odometerEnd, 1080);
    const hist = (await get(`admin/history?entity=trip&id=${ids.ta}`)).json.entries;
    assert.equal(hist[0].source, 'web');
    assert.equal(hist[0].outcome, 'applied');
    assert.equal(hist[0].reason, '依單據修正');
    assert.equal(hist[0].before.odometerEnd, 1050);
    assert.equal(hist[0].after.odometerEnd, 1080);
    assert.equal(hist[0].actor.deviceId, h.ids.admin);
    assert.equal(hist[0].revision, 2);
    const audit = (await get('admin/audit?limit=5')).json.entries;
    assert.ok(audit.some((a) => a.entityId === ids.ta && a.operation === 'update'));

    // 離線很久的 App 送來較舊的修改：不會蓋掉網頁的修改，歷史留下「略過」的摘要
    const old = ev('trip', 'update', ids.ta, { ...trip(ids.ta, { start: at(1), done: true, odo: [1000, 1055], driverName: '陳大文', driverId: ids.dA }) });
    const res = (await send(admin, old))[0];
    assert.equal(res.status, 'ignored');
    assert.equal((await rec('trip', ids.ta)).payload.odometerEnd, 1080);
    const skipped = (await get(`admin/history?entity=trip&id=${ids.ta}&outcome=notApplied`)).json.entries;
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].outcome, 'ignored');
    assert.equal(skipped[0].reason, 'stale');
    assert.equal(skipped[0].before.odometerEnd, 1080, '主機上的內容');
    assert.equal(skipped[0].after.odometerEnd, 1055, '送來的內容');
    assert.ok(skipped[0].changedFields.includes('odometerEnd'));
    assert.equal(skipped[0].revision, 2, '沒有寫入，版本不變');
    assert.equal((await get(`admin/history?entity=trip&id=${ids.ta}&source=web`)).json.entries.length, 1);

    // 其他種類的規則
    r = await patch(`admin/records/vehicle/${ids.v2}`, { expectedRevision: 1, changes: { fuelType: 'electric', modelYear: 2024.0 }, reason: '更正' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.record.payload.isElectric, true, '動力改為電動時 isElectric 一併更新');
    assert.equal(r.json.record.payload.modelYear, 2024);
    assert.deepEqual(r.json.changedFields, ['fuelType', 'isElectric', 'modelYear']);
    expectError(await patch(`admin/records/vehicle/${ids.v2}`, { expectedRevision: 2, changes: { modelYear: 1800 }, reason: 'x' }), 400, 'invalid_changes');
    expectError(await patch(`admin/records/vehicle/${ids.v2}`, { expectedRevision: 2, changes: { plateNumber: 'X-1' }, reason: 'x' }), 400, 'invalid_changes');
    r = await patch(`admin/records/vehicle/${ids.v2}`, { expectedRevision: 2, changes: { inspectionDueDate: at(60) }, reason: '補登' });
    assert.equal(r.json.record.payload.inspectionDueDate, at(60));
    r = await patch(`admin/records/vehicle/${ids.v2}`, { expectedRevision: 3, changes: { inspectionDueDate: null }, reason: '清除' });
    assert.equal('inspectionDueDate' in r.json.record.payload, false, '選填的日期清除後不輸出這個鍵（App 的格式）');
    const wo = await patch(`admin/records/workOrder/${ids.w1}`, { expectedRevision: 1, changes: { status: 'completed' }, reason: 'x' });
    expectError(wo, 400, 'invalid_changes');
    assert.match(wo.json.error.fields.status, /App/);
    r = await patch(`admin/records/workOrder/${ids.w1}`, { expectedRevision: 1, changes: { status: 'inProgress', assignedTo: '技師乙' }, reason: '指派' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.record.payload.status, 'inProgress');
    expectError(await patch(`admin/records/tripRequest/${ids.r1}`, { expectedRevision: 1, changes: { mission: 'x' }, reason: 'x' }), 400, 'invalid_request');
    expectError(await api('PATCH', `admin/records/trip/${ids.ta}`, { token: tokens.driver, body: { expectedRevision: 2, changes: { mission: 'x' }, reason: 'x' } }), 403, 'forbidden');
  });

  await t.test('管理：回車（出車中 → 已回車）與即時位置', async () => {
    const loc = await api('POST', 'locations', { token: admin, body: { tripUUID: ids.tc, latitude: 25.03, longitude: 121.56, timestamp: nowApple() } });
    assert.equal(loc.status, 204, JSON.stringify(loc.json));
    let d = await get(`admin/records/trip/${ids.tc}`);
    assert.equal(d.json.location.latitude, 25.03);
    expectError(await patch(`admin/records/trip/${ids.tc}`, { expectedRevision: 1, changes: { isCompleted: true, odometerEnd: 1100 }, reason: '補回車' }), 400, 'invalid_changes');
    const done = await patch(`admin/records/trip/${ids.tc}`, {
      expectedRevision: 1, changes: { isCompleted: true, endTime: at(3, 2), odometerEnd: 1250 }, reason: '補回車',
    });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.record.payload.isCompleted, true);
    d = await get(`admin/records/trip/${ids.tc}`);
    assert.equal(d.json.location, null, '回車後移除即時位置');
    const far = await patch(`admin/records/trip/${ids.tc}`, { expectedRevision: 2, changes: { odometerEnd: 2400 }, reason: '測試', dryRun: true });
    assert.equal(far.status, 200);
    assert.equal(far.json.warnings.length, 1, '超過 1,000 km 提醒但不擋');
  });

  await t.test('管理：刪除——影響預覽、進行中車趟不能刪、連鎖刪除不可分割', async () => {
    // 車輛 P1：先放一趟出車中的車趟
    const active = uuid();
    await send(admin, ev('trip', 'create', active, trip(active, { start: at(9), driverName: '陳大文' })));
    let v = await rec('vehicle', ids.v1);
    let imp = await get(`admin/records/vehicle/${ids.v1}/impact`);
    assert.equal(imp.status, 200, JSON.stringify(imp.json));
    assert.equal(imp.json.blockers[0].code, 'vehicle-has-active-trips');
    assert.deepEqual(imp.json.cascade, { trip: 4, maintenance: 0, maintenanceItem: 0, workOrder: 1, inspection: 1 });
    expectError(await post(`admin/records/vehicle/${ids.v1}/delete`, { expectedRevision: v.revision, reason: '報廢', expectedCascade: imp.json.cascade }), 409, 'vehicle_has_active_trips');
    // 回車後可以刪除
    assert.equal((await patch(`admin/records/trip/${active}`, { expectedRevision: 1, changes: { isCompleted: true, endTime: at(9, 1), odometerEnd: 1300, destinations: ['桃園'] }, reason: '回車' })).status, 200);
    imp = await get(`admin/records/vehicle/${ids.v1}/impact`);
    assert.deepEqual(imp.json.blockers, []);
    expectError(await post(`admin/records/vehicle/${ids.v1}/delete`, { expectedRevision: v.revision, expectedCascade: imp.json.cascade }), 400, 'invalid_request');
    expectError(await post(`admin/records/vehicle/${ids.v1}/delete`, { expectedRevision: v.revision, reason: '報廢' }), 400, 'invalid_request');
    const changed = await post(`admin/records/vehicle/${ids.v1}/delete`, { expectedRevision: v.revision, reason: '報廢', expectedCascade: { ...imp.json.cascade, trip: 3 } });
    expectError(changed, 409, 'impact_changed');
    assert.equal(changed.json.error.cascade.trip, 4);
    const cursor = (await allChanges(admin)).cursor;
    const del = await post(`admin/records/vehicle/${ids.v1}/delete`, { expectedRevision: v.revision, reason: '報廢', expectedCascade: imp.json.cascade });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.deepEqual(del.json.deleted, { entity: 'vehicle', id: ids.v1, revision: v.revision + 1 });
    const ch = (await allChanges(admin, cursor)).changes;
    assert.equal(ch.length, 7, '車輛＋4 趟＋1 工單＋1 巡檢');
    assert.ok(ch.every((c) => c.deleted));
    assert.equal(new Set(ch.map((c) => c.seq)).size, 7, '每筆有自己的序號');
    assert.deepEqual(ch.map((c) => c.seq), [...ch.map((c) => c.seq)].sort((a, b) => a - b));
    assert.equal(ch[0].id, ids.v1);
    const cascaded = (await get('admin/history?source=cascade&limit=10')).json.entries.filter((e) => e.seq > cursor);
    assert.equal(cascaded.length, 6);
    assert.ok(cascaded.every((e) => e.reason === 'vehicle-deleted' && e.before !== null && e.after === null));
    const own = (await get(`admin/history?entity=vehicle&id=${ids.v1}`)).json.entries[0];
    assert.equal(own.source, 'web');
    assert.equal(own.reason, '報廢');
    const tomb = await get(`admin/records/vehicle/${ids.v1}`);
    assert.equal(tomb.json.record.deleted, true);
    assert.equal(tomb.json.record.payload, null);
    expectError(await post(`admin/records/vehicle/${ids.v1}/delete`, { expectedRevision: v.revision + 1, reason: '再刪', expectedCascade: imp.json.cascade }), 404, 'not_found');
    // 用車申請不會被連鎖刪除
    assert.equal((await rec('tripRequest', ids.r2)).deleted, false);
    // 一般資料：駕駛人的影響是參考數（車趟保留姓名）
    imp = await get(`admin/records/driver/${ids.dB}/impact`);
    assert.equal(imp.json.references.trips, 1);
    assert.equal(imp.json.references.devices, 0);
    const d = await rec('part', ids.p1);
    imp = await get(`admin/records/part/${ids.p1}/impact`);
    assert.equal(imp.json.references.workOrders, 0, '工單已隨車輛刪除');
    assert.equal((await post(`admin/records/part/${ids.p1}/delete`, { expectedRevision: d.revision, reason: '停產' })).status, 200);
  });

  await t.test('管理：用車申請的核准與退回', async () => {
    const r1 = await rec('tripRequest', ids.r1);
    expectError(await post(`admin/requests/${ids.r1}/approve`, { expectedRevision: r1.revision + 1 }), 409, 'revision_mismatch');
    expectError(await post(`admin/requests/${ids.r1}/approve`, { expectedRevision: r1.revision, driverId: uuid() }), 400, 'invalid_request');
    const cursor = (await allChanges(admin)).cursor;
    const ok = await post(`admin/requests/${ids.r1}/approve`, { expectedRevision: r1.revision, driverId: ids.dA });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const req = ok.json.request.payload;
    const tr = ok.json.trip.payload;
    assert.equal(req.status, 'approved');
    assert.equal(req.approvedBy, '管理員 Mac');
    assert.equal(typeof req.approvedAt, 'number');
    assert.equal(req.resultingTripUUID, ok.json.trip.id);
    assert.equal(tr.startTime, at(7));
    assert.equal(tr.endTime, at(7, 3));
    assert.equal(tr.vehiclePlateNumber, P2);
    assert.equal(tr.odometerStart, 5200, '同車最後一趟已回車的結束里程');
    assert.equal(tr.isCompleted, false);
    assert.equal(tr.driver, '陳大文');
    assert.equal(tr.driverEntityUUID, ids.dA);
    assert.deepEqual(tr.destinations, ['台南']);
    const ch = (await allChanges(admin, cursor)).changes;
    assert.deepEqual(ch.map((c) => c.entity), ['trip', 'tripRequest'], '同一次寫入：先建立車趟、再更新申請');
    const again = await post(`admin/requests/${ids.r1}/approve`, { expectedRevision: ok.json.request.revision });
    expectError(again, 409, 'request_not_pending');

    const r2 = await rec('tripRequest', ids.r2);
    expectError(await post(`admin/requests/${ids.r2}/reject`, { expectedRevision: r2.revision }), 400, 'invalid_request');
    const no = await post(`admin/requests/${ids.r2}/reject`, { expectedRevision: r2.revision, rejectionReason: '車輛已報廢' });
    assert.equal(no.status, 200, JSON.stringify(no.json));
    assert.equal(no.json.request.payload.status, 'rejected');
    assert.equal(no.json.request.payload.rejectionReason, '車輛已報廢');
    assert.equal(no.json.trip, null);
    const hist = (await get(`admin/history?entity=tripRequest&id=${ids.r2}`)).json.entries[0];
    assert.equal(hist.source, 'web');
    assert.equal(hist.reason, '車輛已報廢');
    assert.ok(hist.changedFields.includes('status'));
    expectError(await api('POST', `admin/requests/${ids.r2}/approve`, { token: tokens.driver, body: { expectedRevision: 2 } }), 403, 'forbidden');
  });

  await t.test('管理：修改前後歷史的個資遮蔽；稽核紀錄不含駕駛人的個資', async () => {
    const d = await rec('driver', ids.dA);
    const r = await patch(`admin/records/driver/${ids.dA}`, { expectedRevision: d.revision, changes: { phoneNumber: '0987-654-321', notes: '日班' }, reason: '更新聯絡方式' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    expectError(await patch(`admin/records/driver/${ids.dA}`, { expectedRevision: d.revision + 1, changes: { name: '陳小文' }, reason: 'x' }), 400, 'invalid_changes');
    const masked = (await get(`admin/history?entity=driver&id=${ids.dA}`)).json.entries[0];
    assert.equal(masked.after.phoneNumber, '••••321');
    assert.equal(masked.before.phoneNumber, '••••678');
    assert.equal(masked.after.notes, '［已遮蔽］');
    assert.equal(masked.after.licenseNumber, '••••789');
    assert.equal(masked.after.name, '陳大文', '姓名不遮蔽');
    assert.deepEqual(masked.changedFields, ['notes', 'phoneNumber']);
    const auditBefore = (await get('admin/audit?limit=500')).json.entries.length;
    const full = (await get(`admin/history?entity=driver&id=${ids.dA}&pii=1`)).json.entries[0];
    assert.equal(full.after.phoneNumber, '0987-654-321');
    const audit = (await get('admin/audit?limit=500')).json.entries;
    assert.equal(audit.length, auditBefore + 1);
    assert.equal(audit[0].operation, 'view-pii');
    const driverAudit = audit.filter((a) => a.entity === 'driver' && a.entityId === ids.dA);
    assert.ok(driverAudit.length >= 2);
    for (const a of driverAudit.filter((x) => x.summary !== '')) {
      assert.deepEqual(Object.keys(JSON.parse(a.summary)).sort(), ['entityUUID', 'name'], '稽核摘要只有 UUID 與姓名');
      assert.doesNotMatch(a.summary, /0912|0987|A123/);
    }
    expectError(await get('admin/history?outcome=nope'), 400, 'invalid_request');
    expectError(await get('admin/history?source=nope'), 400, 'invalid_request');
  });
}

/**
 * 報表（docs/reports.md）的固定向量。App 的 test/services/reports/server_alignment_test.dart 以同一組資料（同樣的當地時間）
 * 斷言相同的數字與 CSV，兩邊的計算規則一致。時區 Asia/Taipei（UTC+8，沒有日光節約時間）。
 */
export const REPORT_VECTOR = {
  tz: 'Asia/Taipei',
  // 2026-01-01 00:00 到 2026-01-09 00:00（當地時間）
  from: Date.UTC(2025, 11, 31, 16, 0),
  to: Date.UTC(2026, 0, 8, 16, 0),
  csvTrips: '\uFEFF車號,日期,出車時間,回程時間,起始碼錶,結束碼錶,里程,起點,到達地點,任務說明,駕駛人,油種,加油量(L),加油金額,過路費,停車費,電池更換,成本中心\r\n'
    + 'RPT-A,2026-01-02,09:00,11:30,1000,1050,50,總公司,新竹,送貨,張三,,,,40,,,業務\r\n'
    + 'RPT-A,2026-01-03,22:00,02:00,1050,1170,120,總公司,台中 → 彰化,送貨,張三,汽油,30,900,,60,,\r\n'
    + "RPT-B,2026-01-05,08:00,09:00,5000,4990,0,\"A, B\",新竹,'=SUM(A1),李四,,,,,,,\r\n",
};

export async function reportSuite(t, h) {
  const { api, expectError, ev, send, uuid, tokens } = h;
  const admin = tokens.admin;
  const APPLE = 978307200;
  /** 台北時間的 Apple 秒。 */
  const tp = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm) / 1000 - APPLE;
  const ids = { a: uuid(), b: uuid(), d: uuid(), t1: uuid(), t2: uuid(), t3: uuid(), t4: uuid(), t5: uuid(), t6: uuid(), m1: uuid(), m2: uuid(), w1: uuid(), w2: uuid(), i1: uuid(), i2: uuid() };
  const V = REPORT_VECTOR;
  const vehicle = (id, plate) => ({
    entityUUID: id, plateNumber: plate, custodian: '', vehicleType: 'car', isElectric: false, fuelType: 'gas', brand: '', modelYear: 0, vin: '', lastModifiedAt: tp(2025, 12, 1),
  });
  const trip = (id, o) => ({
    entityUUID: id, startTime: o.start, endTime: o.end ?? o.start, odometerStart: o.odo[0], odometerEnd: o.odo[1], origin: o.origin ?? '總公司',
    destinations: o.dest ?? ['新竹'], mission: o.mission ?? '送貨', fuelAmount: o.fuel ?? 0, fuelCost: o.fuelCost ?? 0, tollCost: o.toll ?? 0,
    parkingCost: o.parking ?? 0, fuelType: o.fuelType ?? '', didSwapBattery: false, driver: o.driver, isCompleted: o.done ?? true,
    lastModifiedAt: o.start + 60, vehiclePlateNumber: o.plate, ...(o.costCenter ? { costCenter: o.costCenter } : {}), ...(o.driverId ? { driverEntityUUID: o.driverId } : {}),
  });
  const get = (q) => api('GET', `admin/reports/summary?from=${V.from}&to=${V.to}&tz=${encodeURIComponent(V.tz)}${q}`, { token: admin });
  const round2 = (v) => Math.floor(v * 100 + 0.5) / 100;

  await t.test('報表：準備固定向量的資料', async () => {
    const results = await send(admin,
      ev('vehicle', 'create', ids.a, vehicle(ids.a, 'RPT-A')),
      ev('vehicle', 'create', ids.b, vehicle(ids.b, 'RPT-B')),
      ev('driver', 'create', ids.d, { entityUUID: ids.d, name: '張三', licenseNumber: '', phoneNumber: '', notes: '', lastModifiedAt: tp(2025, 12, 1) }),
      ev('trip', 'create', ids.t1, trip(ids.t1, { plate: 'RPT-A', start: tp(2026, 1, 2, 9), end: tp(2026, 1, 2, 11, 30), odo: [1000, 1050], toll: 40, driver: '張三', driverId: ids.d, costCenter: '業務' })),
      // 駕駛人資料的姓名優先於車趟上的姓名（App 的規則）；跨夜
      ev('trip', 'create', ids.t2, trip(ids.t2, { plate: 'RPT-A', start: tp(2026, 1, 3, 22), end: tp(2026, 1, 4, 2), odo: [1050, 1170], fuel: 30, fuelCost: 900, parking: 60, fuelType: '汽油', driver: '舊名', driverId: ids.d, dest: ['台中', '彰化'] })),
      // 結束里程小於起始：里程算 0；公式與逗號
      ev('trip', 'create', ids.t3, trip(ids.t3, { plate: 'RPT-B', start: tp(2026, 1, 5, 8), end: tp(2026, 1, 5, 9), odo: [5000, 4990], driver: '李四', origin: 'A, B', mission: '=SUM(A1)' })),
      // 出車中：不算
      ev('trip', 'create', ids.t4, trip(ids.t4, { plate: 'RPT-A', start: tp(2026, 1, 6, 8), odo: [1170, 0], driver: '張三', driverId: ids.d, done: false })),
      // 期間開始前出車、跨入期間：不算車趟，但算稼動（1/1）
      ev('trip', 'create', ids.t5, trip(ids.t5, { plate: 'RPT-B', start: tp(2025, 12, 31, 23, 30), end: tp(2026, 1, 1, 1), odo: [4900, 4950], driver: '李四' })),
      // 剛好在期間結束時出車：不算（不含結束）
      ev('trip', 'create', ids.t6, trip(ids.t6, { plate: 'RPT-B', start: tp(2026, 1, 9), end: tp(2026, 1, 9, 1), odo: [4990, 5000], driver: '李四' })),
      ev('maintenance', 'create', ids.m1, { entityUUID: ids.m1, maintenanceDate: tp(2026, 1, 4, 10), odometerReading: 1170, intervalKm: 5000, notes: '', cost: 1500, createdAt: tp(2026, 1, 4), lastModifiedAt: tp(2026, 1, 4), vehiclePlateNumber: 'RPT-A' }),
      ev('maintenance', 'create', ids.m2, { entityUUID: ids.m2, maintenanceDate: tp(2025, 12, 20), odometerReading: 4800, intervalKm: 5000, notes: '', cost: 999, createdAt: tp(2025, 12, 20), lastModifiedAt: tp(2025, 12, 20), vehiclePlateNumber: 'RPT-B' }),
      ev('workOrder', 'create', ids.w1, {
        entityUUID: ids.w1, title: '換煞車皮', status: 'inProgress', openedAt: tp(2026, 1, 5, 10), odometer: 1170, assignedTo: '', notes: '',
        lines: [{ id: uuid(), kind: 'part', detail: '煞車皮', quantity: 2, unitCost: 300 }, { id: uuid(), kind: 'labor', detail: '工資', quantity: 1, unitCost: 150 }, { id: uuid(), kind: 'labor', detail: '檢查', unitCost: 50 }],
        createdAt: tp(2026, 1, 5, 10), lastModifiedAt: tp(2026, 1, 5, 10), vehiclePlateNumber: 'RPT-A',
      }),
      ev('workOrder', 'create', ids.w2, { entityUUID: ids.w2, title: '洗車', status: 'open', openedAt: tp(2026, 1, 7), odometer: 0, assignedTo: '', notes: '', lines: [], createdAt: tp(2026, 1, 7), lastModifiedAt: tp(2026, 1, 7), vehiclePlateNumber: 'RPT-B' }),
      ev('inspection', 'create', ids.i1, { entityUUID: ids.i1, type: 'preTrip', date: tp(2026, 1, 2, 8, 30), odometer: 1000, driverName: '張三', overallResult: 'pass', notes: '', lines: [], createdAt: tp(2026, 1, 2), lastModifiedAt: tp(2026, 1, 2), vehiclePlateNumber: 'RPT-A' }),
      ev('inspection', 'create', ids.i2, {
        entityUUID: ids.i2, type: 'postTrip', date: tp(2026, 1, 5, 7, 45), odometer: 5000, driverName: '李四', overallResult: 'fail', notes: '',
        lines: [{ id: uuid(), item: '煞車', status: 'defect', severity: 'major', comment: '異音' }, { id: uuid(), item: '燈光', status: 'ok', severity: '', comment: '' }],
        createdAt: tp(2026, 1, 5), lastModifiedAt: tp(2026, 1, 5), vehiclePlateNumber: 'RPT-B',
      }),
    );
    assert.ok(results.every((r) => r.status === 'applied'), JSON.stringify(results));
  });

  await t.test('報表：期間摘要（與 App 的報表規則相同）', async () => {
    const r = await get('');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const s = r.json;
    assert.deepEqual(s.period, { from: V.from, to: V.to, tz: V.tz, firstDay: '2026-01-01', lastDay: '2026-01-08', days: 8 });
    const x = s.totals;
    assert.deepEqual(
      [x.trips, x.distance, x.fuel, x.fuelCost, x.tollCost, x.parkingCost, x.tripCost, x.maintenanceCost, x.workOrderCost, x.totalCost, x.costPerKm],
      [3, 170, 30, 900, 40, 60, 1000, 1500, 800, 3300, 19.41],
    );
    assert.deepEqual([x.maintenanceCount, x.workOrderCount, x.inspectionCount, x.inspectionDefects], [1, 2, 2, 1]);
    // 稼動率：RPT-A 3 個車日（1/2、1/3、1/4）、RPT-B 2 個（1/1、1/5）；其他測試的車輛在這段期間沒有出車
    const fleet = s.vehicles.filter((v) => v.vehicleId !== null).length;
    assert.equal(x.utilization, round2((5 / (8 * fleet)) * 100));
    const a = s.vehicles.find((v) => v.plate === 'RPT-A');
    assert.deepEqual([a.vehicleId, a.trips, a.distance, a.tripCost, a.maintenanceCost, a.workOrderCost, a.utilization], [ids.a, 2, 170, 1000, 1500, 800, 37.5]);
    const b = s.vehicles.find((v) => v.plate === 'RPT-B');
    assert.deepEqual([b.trips, b.distance, b.tripCost, b.maintenanceCost, b.workOrderCost, b.utilization], [1, 0, 0, 0, 0, 25]);
    assert.deepEqual(s.drivers.map((d) => [d.name, d.driverId, d.trips, d.distance, d.tripCost]), [['張三', ids.d, 2, 170, 1000], ['李四', null, 1, 0, 0]].sort((p, q) => (p[0] < q[0] ? -1 : 1)));
    assert.deepEqual(s.costCenters.map((c) => [c.costCenter, c.trips, c.distance, c.tripCost]), [['', 2, 120, 960], ['業務', 1, 50, 40]]);
    assert.deepEqual(s.daily.map((d) => [d.date, d.trips, d.distance, d.tripCost]), [['2026-01-02', 1, 50, 40], ['2026-01-03', 1, 120, 960], ['2026-01-05', 1, 0, 0]]);
  });

  await t.test('報表：篩選車牌、駕駛人、成本中心', async () => {
    let x = (await get('&plate=RPT-A')).json;
    assert.deepEqual([x.totals.trips, x.totals.distance, x.totals.maintenanceCost, x.totals.workOrderCost, x.totals.inspectionCount, x.totals.utilization], [2, 170, 1500, 800, 1, 37.5]);
    assert.deepEqual(x.vehicles.map((v) => v.plate), ['RPT-A']);
    x = (await get(`&driverId=${ids.d}`)).json;
    assert.deepEqual([x.totals.trips, x.totals.distance, x.totals.tripCost], [2, 170, 1000], '依駕駛人資料的姓名（T2 車趟上寫的是舊名）');
    x = (await get(`&driver=${encodeURIComponent('李四')}`)).json;
    assert.deepEqual([x.totals.trips, x.totals.distance], [1, 0]);
    x = (await get(`&costCenter=${encodeURIComponent('業務')}`)).json;
    assert.deepEqual([x.totals.trips, x.totals.tripCost], [1, 40]);
    x = (await get('&costCenter=')).json;
    assert.deepEqual([x.totals.trips, x.totals.tripCost], [2, 960], '空字串是「未指定」的成本中心');
    expectError(await api('GET', `admin/reports/summary?from=${V.from}&to=${V.to}&tz=Mars%2FBase`, { token: admin }), 400, 'invalid_request');
    expectError(await api('GET', `admin/reports/summary?from=${V.to}&to=${V.from}`, { token: admin }), 400, 'invalid_request');
    expectError(await api('GET', 'admin/reports/summary', { token: admin }), 400, 'invalid_request');
    expectError(await api('GET', `admin/reports/summary?from=${V.from}&to=${V.from + 401 * 86400000}`, { token: admin }), 400, 'invalid_request');
    expectError(await api('GET', `admin/reports/summary?from=${V.from}&to=${V.to}&driverId=${uuid()}`, { token: admin }), 404, 'not_found');
    expectError(await api('GET', `admin/reports/summary?from=${V.from}&to=${V.to}`, { token: tokens.driver }), 403, 'forbidden');
  });

  await t.test('報表：CSV 匯出（與 App 的報表 CSV 相同的欄位與格式）', async () => {
    const res = await fetch(`${h.base}/api/v1/admin/reports/export?kind=trips&from=${V.from}&to=${V.to}&tz=${encodeURIComponent(V.tz)}`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="FleetDispatch_trips_2026-01-01_2026-01-08\.csv"; filename\*=UTF-8''FleetDispatch_trips_2026-01-01_2026-01-08\.csv$/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    assert.equal(body, V.csvTrips);

    const csvOf = async (kind, q = '') => {
      const r = await fetch(`${h.base}/api/v1/admin/reports/export?kind=${kind}&from=${V.from}&to=${V.to}&tz=${encodeURIComponent(V.tz)}${q}`, { headers: { Authorization: `Bearer ${admin}` } });
      assert.equal(r.status, 200);
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());
    };
    assert.equal(await csvOf('maintenance'), '\uFEFF日期,車牌,里程,費用,備註,保養間隔\r\n2026-01-04,RPT-A,1170,1500,,5000\r\n');
    assert.equal(await csvOf('workOrders'), '\uFEFF開立日,標題,車輛,狀態,完工日,里程,負責人,工項數,合計金額,備註\r\n'
      + '2026-01-05,換煞車皮,RPT-A,進行中,,1170,,3,800,\r\n2026-01-07,洗車,RPT-B,待處理,,,,0,0,\r\n');
    assert.equal(await csvOf('inspections'), '\uFEFF日期,車輛,類型,點檢人,里程,結果,缺陷數,缺陷明細,備註\r\n'
      + '2026-01-02 08:30,RPT-A,出車前,張三,1000,合格,0,,\r\n2026-01-05 07:45,RPT-B,收車後,李四,5000,不合格,1,煞車（嚴重）：異音,\r\n');
    assert.equal(await csvOf('trips', '&plate=RPT-B'), V.csvTrips.split('\r\n').filter((l, i) => i === 0 || l.startsWith('RPT-B')).join('\r\n') + '\r\n');
    const named = await fetch(`${h.base}/api/v1/admin/reports/export?kind=trips&from=${V.from}&to=${V.to}&tz=${encodeURIComponent(V.tz)}&plate=RPT-A`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.match(named.headers.get('content-disposition'), /filename="FleetDispatch_trips_2026-01-01_2026-01-08_RPT-A\.csv"/);
    expectError(await api('GET', `admin/reports/export?kind=nope&from=${V.from}&to=${V.to}`, { token: admin }), 400, 'invalid_request');
    expectError(await api('GET', `admin/reports/export?kind=trips&from=${V.from}&to=${V.to}`, { token: tokens.driver }), 403, 'forbidden');
  });
}
