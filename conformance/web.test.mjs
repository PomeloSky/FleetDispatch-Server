// 網頁（首頁與網頁管理）的相容性測試（docs/protocol.md §13）。三種主機實作都必須通過；不寫入任何資料。
//   FD_BASE=http://127.0.0.1:8080 FD_ADMIN_PATH=/admin node --test conformance/web.test.mjs
// FD_ADMIN_PATH 要與主機的設定相同（沒有設定時是 /admin）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

const BASE = (process.env.FD_BASE ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const ADMIN = process.env.FD_ADMIN_PATH ?? '/admin';
const basePath = new URL(BASE).pathname.replace(/\/+$/, '');

const get = (path, init) => fetch(BASE + path, { redirect: 'manual', ...init });
const JSON_ACCEPT = { headers: { Accept: 'application/json' } };
const HTML_ACCEPT = { headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } };
const isHome = (html) => html.includes('<meta name="fd-page" content="home">');

test('網頁', async (t) => {
  await t.test('首頁是 App 的介紹與下載連結（HTML、沒有程式）', async () => {
    for (const p of [basePath + '/', basePath + '/index.html']) {
      const r = await fetch(new URL(BASE).origin + p, { redirect: 'manual' });
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      const csp = r.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("default-src 'none'") && !csp.includes('script-src'), csp);
      const html = await r.text();
      assert.ok(isHome(html), p);
      assert.ok(html.includes('https://apps.apple.com/'), 'App Store 連結');
      assert.ok(!html.includes('<script'), '首頁沒有程式');
      assert.ok(!html.includes('{{'), '沒有未替換的佔位符');
      assert.ok(!html.includes(`"${ADMIN}"`) && !html.includes(`${ADMIN}/`), '首頁不透露管理網址');
    }
  });

  await t.test('找不到的網址：API 用戶端回 404 JSON，瀏覽器看到首頁（狀態仍是 404）', async () => {
    for (const p of ['/admin-not-here', '/wp-login.php', ADMIN + '/missing', ADMIN + '/app.css']) {
      const r = await get(p, JSON_ACCEPT);
      assert.equal(r.status, 404, p);
      assert.equal((await r.json()).error.code, 'not_found', p);
      const b = await get(p, HTML_ACCEPT);
      assert.equal(b.status, 404, p);
      assert.match(b.headers.get('content-type') ?? '', /^text\/html/);
      assert.ok(isHome(await b.text()), p);
    }
  });

  await t.test('沒有設定成管理網址的 /admin 不會顯示管理頁', async (t2) => {
    if (ADMIN === '/admin') {
      t2.skip('主機的管理網址就是 /admin');
      return;
    }
    const r = await get('/admin', HTML_ACCEPT);
    assert.equal(r.status, 404);
    assert.ok(isHome(await r.text()));
  });

  await t.test('管理頁：HTML、安全標頭、填入基底路徑與管理網址', async () => {
    for (const p of [ADMIN, ADMIN + '/']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
      assert.match(r.headers.get('cache-control') ?? '', /no-store/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      const csp = r.headers.get('content-security-policy') ?? '';
      for (const part of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(part), csp);
      const html = await r.text();
      assert.ok(html.includes(`data-base="${basePath}"`), 'data-base');
      assert.ok(html.includes(`data-admin="${ADMIN}"`), 'data-admin');
      assert.ok(html.includes(`<script src="${basePath}${ADMIN}/app.js" defer></script>`), 'script');
      assert.ok(!html.includes('{{'), '沒有未替換的佔位符');
    }
  });

  await t.test('管理頁的程式', async () => {
    const r = await get(ADMIN + '/app.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const js = await r.text();
    assert.ok(js.length > 1000);
    assert.ok(js.includes('/api/v1/'));
  });

  await t.test('基底路徑含特殊字元時不回應（不把請求路徑填進頁面）', async () => {
    for (const p of [`/%22%3E%3Cscript%3E${ADMIN}`, `/a%20b${ADMIN}`, `/api/v1${ADMIN}`]) {
      const r = await get(p);
      assert.notEqual(r.status, 200, p);
      await r.arrayBuffer();
    }
  });

  await t.test('只接受 GET／HEAD：其他方法照 API 規則回 404', async () => {
    const r = await get(ADMIN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 404);
    await r.arrayBuffer();
  });

  await t.test('API 不受影響', async () => {
    const r = await get('/api/v1/info');
    assert.equal(r.status, 200);
    const info = await r.json();
    assert.equal(info.product, 'FleetDispatch Server');
    assert.ok(!JSON.stringify(info).includes(ADMIN === '/admin' ? '"/admin"' : ADMIN), '/info 不透露管理網址');
  });
});
