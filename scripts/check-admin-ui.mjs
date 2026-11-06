// 網頁管理（1.2.0）的瀏覽器實測（選用）：登入、13 個區塊、清單的篩選與排序、詳情與關聯、受控修改（預覽差異 → 原因 → 儲存）、
// 欄位錯誤、回車、用車申請的核准、刪除的影響預覽、駕駛人個資的遮蔽、報表與 CSV、手機寬度、主控台沒有錯誤。
//
// 只對本機新建、空的主機執行（會建立第一位管理員並寫入資料；不要對正式主機執行）。Playwright 不在 package.json 中（維持低依賴），
// 需要時另外安裝：
//   npm i --no-save playwright && npx playwright install chromium
//   FD_DATA_DIR=<暫存資料夾> FD_HOST=127.0.0.1 FD_PORT=18090 FD_SETUP_TOKEN=<16 字元以上> node docker/src/server.ts &
//   node scripts/check-admin-ui.mjs http://127.0.0.1:18090 <設定碼> [截圖資料夾]
import { mkdirSync } from 'node:fs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('找不到 playwright：請先執行 npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const [BASE, SETUP, SHOTS = 'admin-ui-shots'] = process.argv.slice(2);
if (!BASE || !SETUP) {
  console.error('用法：node scripts/check-admin-ui.mjs <主機網址> <設定碼> [截圖資料夾]');
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });
const APPLE = 978307200;
const nowApple = () => Date.now() / 1000 - APPLE;
const uuid = () => crypto.randomUUID().toUpperCase();
const problems = [];
const log = (...a) => console.log(...a);
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
  log(ok ? '  ✓' : '  ✗', msg);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await ctx.newPage();
const consoleErrors = [];
// 預期中的 API 錯誤（測試故意送出的錯誤里程）瀏覽器也會記成「Failed to load resource」；只記其他錯誤
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('dialog', (d) => d.accept());
page.on('response', async (r) => {
  if (r.status() >= 400 && r.url().includes('/api/v1/')) {
    let body = '';
    try { body = await r.text(); } catch { /* */ }
    console.log('  HTTP', r.status(), r.url().replace(BASE, ''), body.slice(0, 160));
  }
});

// 登入（第一位管理員，用設定碼）
await page.goto(`${BASE}/admin`);
await page.getByLabel('設定碼').fill(SETUP);
await page.getByRole('button', { name: '建立第一位管理員' }).click();
await page.waitForSelector('nav.side');
check(await page.locator('nav.side a').count() === 13, '側欄有 13 個管理區塊');
const token = await page.evaluate(() => JSON.parse(localStorage.getItem('fd.admin.session')).token);

// 以 API 建立資料（同一個管理員）
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}/api/v1/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? null : r.json();
};
const ev = (entity, entityID, payload) => ({ id: uuid(), timestamp: payload.lastModifiedAt, actor: 'ui-test', entity, operation: 'create', entityID, payloadJSON: JSON.stringify(payload) });
const t = nowApple();
const ids = { v1: uuid(), v2: uuid(), d1: uuid(), t1: uuid(), t2: uuid(), r1: uuid(), w1: uuid(), i1: uuid() };
const res = await api('POST', 'events', { events: [
  ev('vehicle', ids.v1, { entityUUID: ids.v1, plateNumber: 'UI-0001', custodian: '總務', vehicleType: 'car', isElectric: false, fuelType: 'gas', brand: 'Toyota', modelYear: 2022, vin: '', inspectionDueDate: t + 10 * 86400, lastModifiedAt: t - 3600 }),
  ev('vehicle', ids.v2, { entityUUID: ids.v2, plateNumber: 'UI-0002', custodian: '', vehicleType: 'motorcycle', isElectric: true, fuelType: 'electric', brand: 'Gogoro', modelYear: 2024, vin: '', lastModifiedAt: t - 3600 }),
  ev('driver', ids.d1, { entityUUID: ids.d1, name: '王小明', licenseNumber: 'A123456789', phoneNumber: '0912-345-678', notes: '夜班', lastModifiedAt: t - 3600 }),
  ev('trip', ids.t1, { entityUUID: ids.t1, startTime: t - 7200, endTime: t - 3600, odometerStart: 1000, odometerEnd: 1042.5, origin: '總公司', destinations: ['新竹', '竹北'], mission: '送樣品', fuelAmount: 20, fuelCost: 600, tollCost: 40, parkingCost: 30, fuelType: '汽油', didSwapBattery: false, driver: '王小明', isCompleted: true, lastModifiedAt: t - 3000, vehiclePlateNumber: 'UI-0001', driverEntityUUID: ids.d1, costCenter: '業務' }),
  ev('trip', ids.t2, { entityUUID: ids.t2, startTime: t - 1800, endTime: t - 1800, odometerStart: 1042.5, odometerEnd: 0, origin: '總公司', destinations: [], mission: '收件', fuelAmount: 0, fuelCost: 0, tollCost: 0, parkingCost: 0, fuelType: '', didSwapBattery: false, driver: '王小明', isCompleted: false, lastModifiedAt: t - 1800, vehiclePlateNumber: 'UI-0001', driverEntityUUID: ids.d1 }),
  ev('tripRequest', ids.r1, { entityUUID: ids.r1, requestedAt: t - 600, requestedBy: '王小明', requestedByDeviceID: uuid(), plannedStartTime: t + 3600, plannedEndTime: t + 7200, origin: '總公司', destinations: ['台中'], mission: '拜訪客戶', vehiclePlateNumber: 'UI-0002', status: 'pending', lastModifiedAt: t - 600 }),
  ev('workOrder', ids.w1, { entityUUID: ids.w1, title: '換機油', status: 'open', openedAt: t - 5000, odometer: 1000, assignedTo: '技師甲', notes: '', lines: [{ id: uuid(), kind: 'labor', detail: '工資', quantity: 1, unitCost: 500 }], createdAt: t - 5000, lastModifiedAt: t - 5000, vehiclePlateNumber: 'UI-0001' }),
  ev('inspection', ids.i1, { entityUUID: ids.i1, type: 'preTrip', date: t - 7300, odometer: 1000, driverName: '王小明', overallResult: 'fail', notes: '', lines: [{ id: uuid(), item: '煞車', status: 'defect', severity: 'major', comment: '異音' }], createdAt: t - 7300, lastModifiedAt: t - 7300, vehiclePlateNumber: 'UI-0001' }),
] });
check(res.results.every((r) => r.status === 'applied'), '建立測試資料');

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
async function go(hash) {
  // 每次重新載入頁面（同一個網址只換 # 時瀏覽器不會重新載入）
  await page.goto('about:blank');
  await page.goto(`${BASE}/admin${hash}`);
  await page.waitForSelector('#panel section.card, #panel .banner', { timeout: 15000 });
  await page.waitForTimeout(200);
}

log('總覽');
await go('#overview');
check(await page.getByText('待簽核的用車申請').isVisible(), '總覽：待簽核的用車申請');
check(await page.waitForFunction(() => document.getElementById('pending-badge')?.textContent === '1', null, { timeout: 5000 }).then(() => true, () => false), '側欄的待簽核徽章是 1');
await shot('01-overview');

log('車趟清單：篩選、排序');
await go('#trips');
check(await page.locator('#panel tbody tr').count() === 2, '車趟清單 2 筆');
await page.locator('#f-status').selectOption('active');
await page.getByRole('button', { name: '套用' }).click();
await page.waitForTimeout(500);
check(await page.locator('#panel tbody tr').count() === 1, '篩選出車中 → 1 筆');
check(page.url().includes('status=active'), '篩選條件寫進網址');
await page.goto(`${BASE}/admin#trips`);
await page.waitForTimeout(500);
await page.locator('th button.sort', { hasText: '里程' }).click();
await page.waitForTimeout(500);
check(page.url().includes('sort=distance'), '點欄位標題排序');
await shot('02-trips');

log('車趟詳情：關聯、位置、歷史');
await go(`#r/trip/${ids.t1}`);
check(await page.getByRole('heading', { level: 1 }).textContent().then((s) => s.includes('UI-0001')), '詳情標題');
check(await page.getByText('同車、出車前 1 天到回車後 1 天的巡檢').isVisible(), '關聯：巡檢（依時間對應）');
await shot('03-trip-detail');

log('修改：預覽差異 → 原因 → 儲存');
await page.getByRole('button', { name: '修改' }).click();
await page.locator('#edit-odometerEnd').fill('1050');
await page.locator('#edit-mission').fill('送樣品（更正）');
await page.getByRole('button', { name: '預覽變更' }).click();
await page.waitForSelector('table.diff');
check(await page.locator('table.diff tbody tr').count() === 2, '差異表 2 個欄位');
await shot('04-edit-preview');
await page.getByRole('button', { name: '更正輸入錯誤' }).click();
await page.getByRole('button', { name: '確認儲存' }).click();
await page.waitForSelector('dialog', { state: 'detached' });
await page.waitForTimeout(800);
check(await page.getByText('版本 2').first().isVisible(), '儲存後版本 2');
const hist = await page.locator('.timeline li').first().textContent();
check(hist.includes('網頁管理') && hist.includes('更正輸入錯誤'), '歷史：來源網頁管理、原因');
await page.locator('.timeline li').first().getByRole('button', { name: '查看差異' }).click();
check(await page.locator('.timeline li').first().locator('table.diff tbody tr').count() >= 2, '歷史的差異');
check(await page.locator('#cmp-a').count() === 1, '版本比較');
await shot('05-history');

log('欄位驗證錯誤（伺服器檢查）');
await page.getByRole('button', { name: '修改' }).click();
await page.locator('#edit-odometerEnd').fill('900');
await page.getByRole('button', { name: '預覽變更' }).click();
await page.waitForSelector('#edit-odometerEnd-err:not(:empty)');
check((await page.locator('#edit-odometerEnd-err').textContent()).includes('不能小於起始里程'), '結束里程小於起始時顯示在欄位下');
await page.getByRole('button', { name: '取消' }).click();

log('回車（出車中 → 已回車）');
await go(`#r/trip/${ids.t2}`);
await page.getByRole('button', { name: '回車' }).click();
await page.locator('#edit-odometerEnd').fill('1080');
await page.locator('#edit-destinations').fill('桃園');
await page.getByRole('button', { name: '預覽變更' }).click();
await page.waitForSelector('table.diff');
await page.locator('#edit-reason').fill('補登回車');
await page.getByRole('button', { name: '確認儲存' }).click();
await page.waitForSelector('dialog', { state: 'detached' });
await page.waitForTimeout(800);
check(await page.locator('.detailhead .chip', { hasText: '已回車' }).isVisible(), '回車後狀態已回車');

log('用車申請：核准');
await go(`#r/tripRequest/${ids.r1}`);
await page.getByRole('button', { name: '核准' }).click();
await page.getByRole('button', { name: '核准並建立車趟' }).click();
await page.waitForURL(/#r\/trip\//);
await page.waitForTimeout(800);
check(await page.getByRole('heading', { level: 1 }).textContent().then((s) => s.includes('UI-0002')), '核准後開啟新車趟');
await go('#overview');
check(await page.waitForFunction(() => document.getElementById('pending-badge')?.hidden === true, null, { timeout: 5000 }).then(() => true, () => false), '待簽核徽章消失');

log('刪除車輛：影響預覽');
await go(`#r/vehicle/${ids.v1}`);
await page.getByRole('button', { name: '刪除' }).click();
await page.waitForSelector('dialog');
const dlg = await page.locator('dialog').textContent();
check(dlg.includes('車趟 2 筆') && dlg.includes('工單 1 筆') && dlg.includes('巡檢 1 筆'), '影響預覽列出連鎖刪除');
await shot('06-delete-preview');
await page.locator('#del-confirm').fill('UI-0001');
await page.locator('#del-reason').fill('測試刪除');
await page.getByRole('button', { name: '永久刪除' }).click();
await page.waitForURL(/#vehicles$/);
await page.waitForTimeout(500);
check(await page.locator('#panel tbody tr').count() === 1, '刪除後車輛清單剩 1 台');

log('駕駛人：個資遮蔽');
await go(`#r/driver/${ids.d1}`);
check(await page.getByText('0912-345-678').count() === 1, '詳情顯示電話（資料本身）');
await page.getByRole('button', { name: '修改' }).click();
await page.locator('#edit-phoneNumber').fill('0987-654-321');
await page.getByRole('button', { name: '預覽變更' }).click();
await page.waitForSelector('table.diff');
await page.locator('#edit-reason').fill('更新電話');
await page.getByRole('button', { name: '確認儲存' }).click();
await page.waitForSelector('dialog', { state: 'detached' });
await page.waitForTimeout(800);
await page.locator('.timeline li').first().getByRole('button', { name: '查看差異' }).click();
const masked = await page.locator('.timeline li').first().textContent();
check(masked.includes('••••321') && !masked.includes('0987-654-321'), '歷史中的電話預設遮蔽');

log('報表');
await go('#reports');
check(await page.getByText('依車輛').isVisible(), '報表：依車輛');
const download = page.waitForEvent('download');
await page.getByRole('button', { name: '車趟 CSV' }).click();
const file = await download;
check(/^FleetDispatch_trips_.*\.csv$/.test(file.suggestedFilename()), `CSV 下載：${file.suggestedFilename()}`);
await shot('07-reports');

log('修改歷史與稽核、其他頁面');
for (const hash of ['#history', '#audit', '#drivers', '#devices', '#vehicles', '#requests', '#inspections', '#workorders', '#maintenance', '#maintitems', '#parts', '#locations', '#codes', '#settings']) {
  await go(hash);
  const err = await page.locator('#panel .banner.error').count();
  check(err === 0, `${hash} 載入`);
}
await go('#history?outcome=notApplied');
await shot('08-history-list');

log('手機寬度');
await page.setViewportSize({ width: 390, height: 844 });
await go('#trips');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 1, `手機寬度沒有橫向捲動（${overflow}px）`);
await shot('09-phone-trips');
await go(`#r/trip/${ids.t1}`);
await shot('10-phone-detail');

check(consoleErrors.length === 0, `主控台沒有錯誤${consoleErrors.length ? '：' + consoleErrors.join(' | ') : ''}`);
await browser.close();
log(problems.length ? `失敗 ${problems.length} 項` : '全部通過');
process.exit(problems.length ? 1 : 0);
