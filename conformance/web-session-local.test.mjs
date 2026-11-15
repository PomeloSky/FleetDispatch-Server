// 網頁管理登入的期限與管理員的恢復（1.2.0，docs/security-review.md §1–§2）：需要改資料庫裡的時間，只在本機的暫存資料夾執行
// （Docker／Node 版與 PHP＋SQLite 版；不連任何正式主機）：
//   node --test conformance/web-session-local.test.mjs（PHP 版需要 php 與 pdo_sqlite；沒有 php 時略過）
//   FD_LOCAL_VARIANTS=node 或 php：只執行其中一種（CI 依工作分開）
// - 使用時延長閒置期限，但不超過登入期限；5 分鐘內不重複寫入；過期後 401；
// - 1.1 的網頁權杖（Authorization 標頭）只更新最後使用時間、不延長；App 的權杖照舊延長 90 天；
// - 所有管理員的登入都失效時設定碼重新有效（info.setupRequired），同時送出的兩個設定碼請求只有一個成功；
//   有可以使用的管理員後設定碼又不能用。

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const SETUP = 'web-session-test-setup-token';
const CSRF = 'X-FleetDispatch-CSRF';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const uuid = () => crypto.randomUUID().toUpperCase();

const VARIANTS = {
  node(dir, port) {
    return spawn(process.execPath, ['docker/src/server.ts'], {
      env: { ...process.env, FD_DATA_DIR: dir, FD_HOST: '127.0.0.1', FD_PORT: String(port), FD_SETUP_TOKEN: SETUP },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  },
  php(dir, port) {
    const config = join(dir, 'config.php');
    writeFileSync(config, `<?php\nreturn ['setup_token' => '${SETUP}', 'db' => ['dsn' => 'sqlite:${join(dir, 'fleetdispatch.sqlite')}', 'user' => '', 'password' => ''], 'server_name' => 'x', 'admin_path' => '/admin', 'trust_proxy' => 0];\n`);
    return spawn('php', ['-S', `127.0.0.1:${port}`, 'php/public/index.php'], { env: { ...process.env, FD_PHP_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  },
};

const hasPhp = spawnSync('php', ['-r', 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);']).status === 0;
const only = (process.env.FD_LOCAL_VARIANTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const skipReason = (variant) =>
  only.length > 0 && !only.includes(variant) ? `FD_LOCAL_VARIANTS=${only.join(',')}` : variant === 'php' && !hasPhp ? '沒有 php 或 pdo_sqlite' : false;

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

for (const [variant, start] of Object.entries(VARIANTS)) {
  test(`網頁登入的期限與管理員的恢復（${variant}）`, { skip: skipReason(variant) }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fd-websession-'));
    const port = 19800 + Math.floor(Math.random() * 400);
    const base = `http://127.0.0.1:${port}`;
    const child = start(dir, port);
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    try {
      await waitReady(base);
      const call = async (method, path, { token, cookie, csrf, body } = {}) => {
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (cookie) headers.Cookie = cookie;
        if (csrf) headers[CSRF] = csrf;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${base}/api/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : null, cookies: res.headers.getSetCookie() };
      };
      const db = new DatabaseSync(join(dir, 'fleetdispatch.sqlite'));
      db.exec('PRAGMA busy_timeout = 5000');
      const row = (id) => db.prepare('SELECT * FROM fd_devices WHERE device_id = ?').get(id);
      const set = (id, fields) => {
        const keys = Object.keys(fields);
        db.prepare(`UPDATE fd_devices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE device_id = ?`).run(...keys.map((k) => fields[k]), id);
      };

      // App 的管理員（設定碼）與網頁登入（不記住）
      const appId = uuid();
      const app = await call('POST', 'pair', { body: { code: SETUP, deviceId: appId, deviceName: '管理員 iPad', platform: 'ipados' } });
      assert.equal(app.status, 200, JSON.stringify(app.json));
      const code = async () => (await call('POST', 'admin/pairing-codes', { token: app.json.token, body: { role: 'admin', ttlMinutes: 60 } })).json.code;
      const login = await call('POST', 'web/login', { csrf: 'login', body: { code: await code(), deviceName: '網頁' } });
      assert.equal(login.status, 200, JSON.stringify(login.json));
      const webId = login.json.deviceId;
      const cookie = login.cookies[0].split(';')[0];

      // 使用時延長閒置期限，但不超過登入期限
      const now = Date.now();
      set(webId, { last_seen_at: now - 10 * 60 * 1000, session_until: now + 30 * 60 * 1000 });
      assert.equal((await call('GET', 'session', { cookie })).status, 200);
      let r = row(webId);
      assert.equal(Number(r.token_expires_at), now + 30 * 60 * 1000, '有效期限不超過登入期限');
      assert.ok(Number(r.last_seen_at) >= now);
      // 5 分鐘內再使用：不寫入
      set(webId, { token_expires_at: now + 60 * 1000 });
      assert.equal((await call('GET', 'session', { cookie })).status, 200);
      assert.equal(Number(row(webId).token_expires_at), now + 60 * 1000);
      // 閒置超過期限：401
      set(webId, { token_expires_at: Date.now() - 1 });
      assert.equal((await call('GET', 'session', { cookie })).status, 401);
      // 一般的閒置期限：2 小時
      set(webId, { token_expires_at: Date.now() + HOUR, session_until: Date.now() + 10 * HOUR, last_seen_at: Date.now() - 10 * 60 * 1000 });
      const s = await call('GET', 'session', { cookie });
      assert.equal(s.status, 200);
      assert.ok(Math.abs(s.json.tokenExpiresAt - (Date.now() + 2 * HOUR)) < 60 * 1000, '閒置 2 小時');

      // 1.1 的網頁權杖：只更新最後使用時間、不延長；App 的權杖延長 90 天
      const legacyId = uuid();
      const legacy = await call('POST', 'pair', { body: { code: await code(), deviceId: legacyId, deviceName: '1.1 的網頁', platform: 'web' } });
      assert.equal(legacy.status, 200);
      const keep = Date.now() + DAY;
      set(legacyId, { last_seen_at: Date.now() - 2 * HOUR, token_expires_at: keep });
      assert.equal((await call('GET', 'session', { token: legacy.json.token })).status, 200);
      assert.equal(Number(row(legacyId).token_expires_at), keep, '1.1 的網頁權杖不延長');
      assert.ok(Number(row(legacyId).last_seen_at) > Date.now() - 60 * 1000);
      set(appId, { last_seen_at: Date.now() - 2 * HOUR, token_expires_at: Date.now() + DAY });
      assert.equal((await call('GET', 'session', { token: app.json.token })).status, 200);
      assert.ok(Number(row(appId).token_expires_at) > Date.now() + 89 * DAY, 'App 的權杖延長 90 天');

      // 所有管理員的登入都失效：設定碼重新有效
      assert.equal((await call('GET', 'info')).json.setupRequired, false);
      db.prepare(`UPDATE fd_devices SET token_expires_at = ? WHERE role = 'admin'`).run(Date.now() - 1);
      assert.equal((await call('GET', 'info')).json.setupRequired, true, '沒有可以使用的管理員');
      // 同時送出兩個設定碼請求：只有一個成功
      const both = await Promise.all([1, 2].map((i) => call('POST', 'pair', { body: { code: SETUP, deviceId: uuid(), deviceName: `恢復 ${i}`, platform: 'macos' } })));
      assert.deepEqual(both.map((x) => x.status).sort(), [200, 401], JSON.stringify(both.map((x) => x.json)));
      assert.equal((await call('GET', 'info')).json.setupRequired, false);
      // 有可以使用的管理員後，設定碼不能再用（App 與網頁都一樣）
      assert.equal((await call('POST', 'pair', { body: { code: SETUP, deviceId: uuid(), deviceName: '再一次' } })).json.error.code, 'invalid_code');
      assert.equal((await call('POST', 'web/login', { csrf: 'login', body: { code: SETUP, deviceName: '再一次' } })).json.error.code, 'invalid_code');

      // 只剩已失效的管理員：網頁以設定碼登入成為管理員；失效的管理員不算「其他可以使用的管理員」
      db.prepare(`UPDATE fd_devices SET token_expires_at = ? WHERE role = 'admin'`).run(Date.now() - 1);
      const rescue = await call('POST', 'web/login', { csrf: 'login', body: { code: SETUP, deviceName: '恢復的網頁', remember: true } });
      assert.equal(rescue.status, 200, JSON.stringify(rescue.json));
      const rescueCookie = rescue.cookies[0].split(';')[0];
      const out = await call('POST', 'unpair', { cookie: rescueCookie, csrf: rescue.json.web.csrfToken });
      assert.equal(out.status, 409, '其他管理員都已失效：最後一位可以使用的管理員不能登出');
      assert.equal(out.json.error.code, 'last_admin');
      db.close();
    } catch (e) {
      console.error(log);
      throw e;
    } finally {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
