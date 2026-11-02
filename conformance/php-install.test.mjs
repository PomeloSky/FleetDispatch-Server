// PHP 版安裝精靈的測試（只適用 PHP 版）。對一個「還沒有 config.php、程式資料夾可以寫入」的 PHP 主機，在同一台機器上執行
// （安裝金鑰從程式資料夾的 install-key.php 讀取）：
//   FD_BASE=http://127.0.0.1:8081 FD_APP_DIR=/path/to/php FD_INSTALL_DB=sqlite node --test conformance/php-install.test.mjs
//   MySQL：FD_INSTALL_DB=mysql FD_DB_HOST=127.0.0.1 FD_DB_PORT=3306 FD_DB_NAME=<空的資料庫> FD_DB_USER=… FD_DB_PASSWORD=…
// 測試會完成安裝（寫入 config.php、建立資料表）並以設定碼建立第一位管理員。

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const BASE = (process.env.FD_BASE ?? 'http://127.0.0.1:8081').replace(/\/+$/, '');
const DB = process.env.FD_INSTALL_DB ?? 'sqlite';
const MYSQL = {
  driver: 'mysql',
  host: process.env.FD_DB_HOST ?? '127.0.0.1',
  port: process.env.FD_DB_PORT ?? '3306',
  name: process.env.FD_DB_NAME ?? 'fd_install',
  user: process.env.FD_DB_USER ?? 'fleetdispatch',
  password: process.env.FD_DB_PASSWORD ?? '',
};
const DB_BODY = DB === 'mysql' ? MYSQL : { driver: 'sqlite' };
const HTML = { Accept: 'text/html' };
const APP_DIR = process.env.FD_APP_DIR ?? '';
const KEY_FILE = `${APP_DIR}/install-key.php`;
const readKey = () => /安裝金鑰：([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/u.exec(readFileSync(KEY_FILE, 'utf8'))?.[1];
let KEY = '';

async function api(method, path, { body, headers } = {}) {
  const h = { Accept: 'application/json', ...(headers ?? {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v1/${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _text: text };
  }
  return { status: res.status, json };
}

const expectError = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.json));
  assert.equal(r.json?.error?.code, code, JSON.stringify(r.json));
};

test('PHP 安裝精靈', async (t) => {
  await t.test('還沒有設定檔：/info 回設定錯誤，/install 回主機環境', async () => {
    const info = await api('GET', 'info');
    expectError(info, 500, 'server_error');
    assert.match(info.json.error.message, /config\.php/);
    const s = await api('GET', 'install', { headers: { Authorization: 'Bearer fd-install-header-check-000000000000' } });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.installed, false);
    assert.equal(s.json.installable, true);
    assert.equal(s.json.authorization, true, 'Authorization 標頭應該傳得到 PHP');
    assert.equal(s.json.drivers[DB], true);
    assert.equal(s.json.writable, true);
    assert.equal(s.json.keyFile, 'install-key.php');
    assert.match(s.json.phpVersion, /^\d+\.\d+\.\d+$/);
    KEY = readKey();
    assert.match(KEY ?? '', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, '程式資料夾裡建立了安裝金鑰');
    const again = await api('GET', 'install');
    assert.equal(again.status, 200);
    assert.equal(readKey(), KEY, '再次開啟不會換金鑰');
    const file = await fetch(`${BASE}/install-key.php`, { headers: { Accept: 'application/json' } });
    assert.ok(!(await file.text()).includes(KEY), '從網站讀不到金鑰');
  });

  await t.test('沒有安裝金鑰或金鑰錯誤：不能測試連線，也不能安裝', async () => {
    expectError(await api('POST', 'install/test', { body: DB_BODY }), 403, 'invalid_install_key');
    expectError(await api('POST', 'install/test', { body: { ...DB_BODY, installKey: 'AAAA-BBBB-CCCC' } }), 403, 'invalid_install_key');
    expectError(await api('POST', 'install', { body: { ...DB_BODY, installKey: '' } }), 403, 'invalid_install_key');
  });

  await t.test('預設的管理網址 /admin 載入網頁管理（安裝畫面由它顯示）', async () => {
    const r = await fetch(`${BASE}/admin`, { headers: HTML });
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('data-admin="/admin"'));
  });

  await t.test('輸入檢查：資料庫類型、主機、資料庫名稱、連接埠', async () => {
    const bad = [
      {},
      { driver: 'oracle' },
      { driver: 'mysql', host: 'db.example.com', name: 'fleet;dbname=other', user: 'u' },
      { driver: 'mysql', host: 'bad host', name: 'fleet', user: 'u' },
      { driver: 'mysql', host: 'localhost', name: 'fleet', user: 'u', port: 70000 },
      { driver: 'mysql', host: 'localhost', name: 'fleet', user: '' },
    ];
    for (const body of bad) {
      if (body.driver === 'mysql' && DB !== 'mysql') continue; // 沒有 pdo_mysql 時回的是另一個訊息
      expectError(await api('POST', 'install/test', { body: { ...body, installKey: KEY } }), 400, 'invalid_request');
    }
  });

  if (DB === 'mysql') {
    await t.test('MySQL：密碼錯誤時說明原因', async () => {
      const r = await api('POST', 'install/test', { body: { ...MYSQL, password: MYSQL.password + '-wrong', installKey: KEY } });
      expectError(r, 400, 'db_error');
      assert.match(r.json.error.message, /帳號或密碼/);
    });
  }

  await t.test('測試連線', async () => {
    const r = await api('POST', 'install/test', { body: { ...DB_BODY, installKey: KEY.toLowerCase().replace(/-/g, ' ') } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true, '金鑰不分大小寫、可以省略連字號');
    assert.equal(typeof r.json.version, 'string');
  });

  let result;
  await t.test('完成安裝：寫入 config.php、建立資料表，回傳設定碼與管理網址', async () => {
    const r = await api('POST', 'install', { body: { ...DB_BODY, serverName: '安裝測試主機', installKey: KEY } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    result = r.json;
    assert.equal(result.written, true, '程式資料夾可以寫入時直接建立 config.php');
    assert.equal(result.config, null);
    assert.match(result.setupToken, /^[A-Za-z0-9]{32}$/);
    assert.match(result.adminPath, /^\/manage-[a-z0-9]{10}$/);
    assert.equal(existsSync(KEY_FILE), false, '安裝完成後刪除金鑰檔');
    if (DB === 'sqlite') {
      assert.ok(existsSync(`${APP_DIR}/data/.htaccess`) && existsSync(`${APP_DIR}/data/index.html`), 'data/ 有禁止網站直接存取的 .htaccess');
    }
  });

  await t.test('安裝之後：/info 正常、安裝端點消失、管理頁換到新的網址', async () => {
    const info = await api('GET', 'info');
    assert.equal(info.status, 200, JSON.stringify(info.json));
    assert.equal(info.json.name, '安裝測試主機');
    assert.equal(info.json.setupRequired, true);
    assert.equal(info.json.setupConfigured, true);
    expectError(await api('GET', 'install'), 404, 'not_found');
    expectError(await api('POST', 'install', { body: { ...DB_BODY, installKey: KEY } }), 404, 'not_found');
    const page = await fetch(BASE + result.adminPath);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(`data-admin="${result.adminPath}"`));
    const old = await fetch(`${BASE}/admin`, { headers: HTML });
    assert.equal(old.status, 404);
    assert.ok((await old.text()).includes('<meta name="fd-page" content="home">'), '舊的 /admin 變成首頁內容');
  });

  await t.test('用設定碼建立第一位管理員', async () => {
    const r = await api('POST', 'pair', {
      body: { code: result.setupToken, deviceId: crypto.randomUUID().toUpperCase(), deviceName: '網頁管理（測試）', platform: 'web' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.role, 'admin');
  });
});
