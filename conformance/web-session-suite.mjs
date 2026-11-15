// 網頁管理以 HttpOnly Cookie 登入（1.2.0，docs/protocol.md §13.1、docs/security-review.md §1）的相容性測試。
// 由 api.test.mjs 呼叫（需要管理員的 App 權杖）；三種主機實作都必須通過。
// 期限（閒置、登入期限）與「沒有可以使用的管理員時設定碼重新有效」需要改資料庫的時間，在 web-session-local.test.mjs。

import assert from 'node:assert/strict';

const CSRF = 'X-FleetDispatch-CSRF';

export async function webSessionSuite(t, h) {
  const { api, expectError, tokens, uuid, base } = h;
  const secure = base.startsWith('https:');
  const cookiePath = new URL(base).pathname.replace(/\/+$/, '') + '/api/v1';

  async function web(method, path, { cookie, csrf, body, raw, headers = {} } = {}) {
    const hd = { Accept: 'application/json', ...headers };
    if (cookie) hd.Cookie = cookie;
    if (csrf !== undefined) hd[CSRF] = csrf;
    if ((body !== undefined || raw !== undefined) && !('Content-Type' in hd)) hd['Content-Type'] = 'application/json';
    const res = await fetch(`${base}/api/v1/${path}`, { method, headers: hd, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _text: text };
    }
    return { status: res.status, json, headers: res.headers, cookies: res.headers.getSetCookie() };
  }
  /** Set-Cookie → 送回主機用的 `名稱=值`。 */
  const jarOf = (r) => {
    const set = r.cookies.find((c) => /^(__Secure-)?fd_admin=/.test(c));
    assert.ok(set, '有登入 Cookie：' + JSON.stringify(r.cookies));
    return set.split(';')[0];
  };
  const attrs = (set) => set.split(';').slice(1).map((s) => s.trim().toLowerCase());
  const code = async (role) => {
    const r = await api('POST', 'admin/pairing-codes', { token: tokens.admin, body: { role, ttlMinutes: 60, label: '網頁登入測試' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };

  let jar = null;
  let csrf = null;
  let webId = null;

  await t.test('1.2.0 網頁登入：自訂標頭、同一個來源、JSON；不是管理員的配對碼回 admin_only 且不用掉配對碼', async () => {
    const c = await code('admin');
    const login = { code: c.code, deviceName: '網頁管理（測試）' };
    expectError(await web('POST', 'web/login', { body: login }), 403, 'csrf_failed');
    expectError(await web('POST', 'web/login', { csrf: 'login', body: login, headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'csrf_failed');
    expectError(await web('POST', 'web/login', { csrf: 'login', raw: JSON.stringify(login), headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type');
    expectError(await web('POST', 'web/login', { csrf: 'login', body: { ...login, remember: 'yes' } }), 400, 'invalid_request');
    expectError(await web('POST', 'web/login', { csrf: 'login', body: { code: c.code } }), 400, 'invalid_request');

    const viewer = await code('viewer');
    expectError(await web('POST', 'web/login', { csrf: 'login', body: { code: viewer.code, deviceName: '網頁' } }), 403, 'admin_only');
    const codes = (await api('GET', 'admin/pairing-codes', { token: tokens.admin })).json.codes;
    assert.ok(codes.some((x) => x.id === viewer.id), '不是管理員的配對碼沒有被用掉');
    assert.equal((await api('DELETE', `admin/pairing-codes/${viewer.id}`, { token: tokens.admin })).status, 204);

    const r = await web('POST', 'web/login', { csrf: 'login', body: login, headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.token, undefined, '回應不含權杖');
    assert.equal(r.json.role, 'admin');
    assert.equal(r.json.deviceName, '網頁管理（測試）');
    assert.match(r.json.deviceId, /^[0-9A-F-]{36}$/);
    assert.equal(r.json.web.remember, false);
    assert.match(r.json.web.csrfToken, /^[0-9a-f]{32}$/);
    const now = Date.now();
    assert.ok(r.json.web.sessionUntil > now + 11 * 3600000 && r.json.web.sessionUntil < now + 12 * 3600000 + 60000, '登入期限 12 小時');
    assert.ok(r.json.tokenExpiresAt < now + 2 * 3600000 + 60000, '閒置 2 小時');
    assert.equal(r.cookies.length, 1);
    const set = r.cookies[0];
    assert.match(set, secure ? /^__Secure-fd_admin=[A-Za-z0-9_-]{43};/ : /^fd_admin=[A-Za-z0-9_-]{43};/);
    const a = attrs(set);
    for (const x of ['httponly', 'samesite=strict', `path=${cookiePath.toLowerCase()}`]) assert.ok(a.includes(x), `${x}：${set}`);
    assert.equal(a.includes('secure'), secure);
    assert.ok(!a.some((x) => x.startsWith('max-age') || x.startsWith('expires')), '不記住：瀏覽器關閉時刪除');
    jar = jarOf(r);
    csrf = r.json.web.csrfToken;
    webId = r.json.deviceId;

    expectError(await web('POST', 'web/login', { csrf: 'login', body: login }), 401, 'invalid_code');
  });

  await t.test('1.2.0 網頁登入：以 Cookie 驗證；非 GET 要帶 CSRF 權杖；Cookie 的權杖不能放在 Authorization', async () => {
    const s = await web('GET', 'session', { cookie: jar });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.deviceId, webId);
    assert.equal(s.json.web.csrfToken, csrf);
    assert.equal(s.json.web.remember, false);
    const app = await api('GET', 'session', { token: tokens.admin });
    assert.equal(app.json.web, undefined, 'App 的回應沒有 web');
    assert.equal((await web('GET', 'admin/devices', { cookie: jar })).status, 200);

    const body = { name: (await api('GET', 'info')).json.name };
    expectError(await web('PATCH', 'admin/server', { cookie: jar, body }), 403, 'csrf_failed');
    expectError(await web('PATCH', 'admin/server', { cookie: jar, csrf: '0'.repeat(32), body }), 403, 'csrf_failed');
    expectError(await web('PATCH', 'admin/server', { cookie: jar, csrf, body, headers: { 'Sec-Fetch-Site': 'same-site' } }), 403, 'csrf_failed');
    expectError(
      await web('PATCH', 'admin/server', { cookie: jar, csrf, raw: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' } }),
      415,
      'unsupported_media_type',
    );
    const ok = await web('PATCH', 'admin/server', { cookie: jar, csrf, body, headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));

    expectError(await api('GET', 'session', { token: jar.split('=')[1] }), 401, 'unauthorized');
    const both = await web('GET', 'session', { cookie: jar, headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(both.status, 200);
    assert.equal(both.json.deviceId, app.json.deviceId, 'Authorization 標頭優先於 Cookie');
    expectError(await web('GET', 'session', { cookie: 'fd_admin=' + 'A'.repeat(43) }), 401, 'unauthorized');

    const devices = (await api('GET', 'admin/devices', { token: tokens.admin })).json.devices;
    const mine = devices.find((d) => d.deviceId === webId);
    assert.equal(mine.platform, 'web');
    assert.equal(mine.webSession, 'session');
    assert.ok(mine.sessionUntil > Date.now());
    const appDevice = devices.find((d) => d.deviceId === app.json.deviceId);
    assert.equal(appDevice.webSession, null);
    assert.equal(appDevice.sessionUntil, null);
  });

  await t.test('1.2.0 網頁登入：記住這個瀏覽器（Max-Age 90 天、閒置 30 天）；登出刪除 Cookie 並解除配對', async () => {
    const c = await code('admin');
    const r = await web('POST', 'web/login', { csrf: 'login', body: { code: c.code, deviceName: '記住的瀏覽器', remember: true } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.web.remember, true);
    const maxAge = Number((attrs(r.cookies[0]).find((x) => x.startsWith('max-age=')) ?? '').slice('max-age='.length));
    assert.ok(maxAge > 89 * 86400 && maxAge <= 90 * 86400, `Max-Age ${maxAge}`);
    assert.ok(r.json.tokenExpiresAt < Date.now() + 30 * 86400000 + 60000, '閒置 30 天');
    const rj = jarOf(r);
    const out = await web('POST', 'unpair', { cookie: rj, csrf: r.json.web.csrfToken, headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(out.status, 204);
    assert.ok(out.cookies.some((x) => /^(__Secure-)?fd_admin=;/.test(x) && /max-age=0/i.test(x)), '刪除 Cookie：' + JSON.stringify(out.cookies));
    expectError(await web('GET', 'session', { cookie: rj }), 401, 'unauthorized');
  });

  await t.test('1.2.0 網頁登入：1.1 的網頁權杖轉成 Cookie（同一台裝置、舊權杖失效、只能轉一次）；App 的權杖不能轉', async () => {
    const c = await code('admin');
    const legacyId = uuid();
    const p = await api('POST', 'pair', { body: { code: c.code, deviceId: legacyId, deviceName: '1.1 的網頁管理', platform: 'web' } });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal((await api('GET', 'session', { token: p.json.token })).status, 200, '轉換前仍可使用');
    const bearer = { Authorization: `Bearer ${p.json.token}` };
    expectError(await web('POST', 'web/upgrade', { body: { remember: true }, headers: bearer }), 403, 'csrf_failed');
    expectError(await web('POST', 'web/upgrade', { csrf: 'upgrade', body: {}, headers: { Authorization: `Bearer ${tokens.admin}` } }), 403, 'not_web_session');
    expectError(await web('POST', 'web/upgrade', { csrf: 'upgrade', body: {} }), 401, 'unauthorized');

    const u = await web('POST', 'web/upgrade', { csrf: 'upgrade', body: { remember: true }, headers: bearer });
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.equal(u.json.deviceId, legacyId, '同一台網頁裝置');
    assert.equal(u.json.token, undefined);
    assert.equal(u.json.web.remember, true);
    expectError(await api('GET', 'session', { token: p.json.token }), 401, 'unauthorized');
    expectError(await web('POST', 'web/upgrade', { csrf: 'upgrade', body: {}, headers: bearer }), 401, 'unauthorized');
    const uj = jarOf(u);
    const s = await web('GET', 'session', { cookie: uj });
    assert.equal(s.json.deviceId, legacyId);
    assert.equal((await web('POST', 'unpair', { cookie: uj, csrf: u.json.web.csrfToken })).status, 204);

    // 稽核：網頁登入、轉換、登出（1.2.0）
    const audit = (await api('GET', 'admin/audit?limit=100', { token: tokens.admin })).json.entries;
    const mine = (id, op) => audit.filter((a) => a.entity === 'device' && a.entityId === id && a.operation === op).map((a) => JSON.parse(a.summary));
    assert.deepEqual(mine(webId, 'web-login').map((x) => [x.via, x.remember]), [['code', false]]);
    assert.deepEqual(mine(legacyId, 'web-upgrade'), [{ remember: true }]);
    assert.deepEqual(mine(legacyId, 'unpair'), [{ role: 'admin', web: true }]);
  });

  await t.test('1.2.0 網頁登入：管理員解除配對後 Cookie 立即失效', async () => {
    assert.equal((await api('DELETE', `admin/devices/${webId}`, { token: tokens.admin })).status, 204);
    expectError(await web('GET', 'session', { cookie: jar }), 401, 'unauthorized');
    expectError(await web('POST', 'unpair', { cookie: jar, csrf }), 401, 'unauthorized');
  });
}
