// FleetDispatch Server 網頁管理（說明見 docs/protocol.md「網頁管理」）。
// 只使用公開的 API v1：這個瀏覽器像 App 一樣「配對」取得權杖（第一次設定用設定碼，之後用管理員建立的配對碼），
// 再呼叫 /admin/* 等端點。不載入任何外部資源；伺服器資料一律以 textContent 顯示。
(() => {
  'use strict';

  const root = document.documentElement;
  const BASE = root.dataset.base || '';
  const ADMIN = root.dataset.admin || '';
  const API = BASE + '/api/v1/';
  const STORE_KEY = 'fd.admin.session';
  const APPLE_EPOCH = 978307200;
  const app = document.getElementById('app');

  const ROLE = { admin: '管理員', driver: '駕駛', viewer: '檢視者' };
  const ENTITY = {
    trip: '車趟', vehicle: '車輛', driver: '駕駛人', maintenance: '保養紀錄', maintenanceItem: '保養項目',
    preset: '常用設定', tripRequest: '用車申請', part: '零件', workOrder: '工單', inspection: '巡檢',
  };
  const OPERATION = { create: '新增', update: '修改', delete: '刪除' };
  const VARIANT = { cloudflare: 'Cloudflare Workers＋D1', php: 'PHP', docker: 'Docker／Node' };
  const PLATFORM = { ios: 'iOS', ipados: 'iPadOS', android: 'Android', macos: 'macOS', windows: 'Windows', web: '網頁' };
  const REQUEST_STATUS = { pending: '待簽核', approved: '已核准', rejected: '已退回', cancelled: '已取消' };
  const VEHICLE_TYPE = { car: '小客車', truck: '貨車', van: '廂型車', motorcycle: '機車', bus: '巴士', scooter: '機車' };
  const TABS = [
    ['overview', '概況'], ['devices', '裝置'], ['codes', '配對碼'], ['locations', '即時位置'],
    ['audit', '稽核紀錄'], ['data', '資料'], ['settings', '設定'],
  ];
  const TTL_OPTIONS = [[60, '1 小時'], [1440, '1 天'], [4320, '3 天'], [10080, '7 天']];

  const state = {
    info: null, session: null, me: null, tab: 'overview', data: null,
    devices: null, codes: null, codePreset: null, dataView: 'trips', showRevoked: false,
  };
  let timers = [];

  // ───────── DOM ─────────

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const clear = (el) => {
    el.replaceChildren();
    return el;
  };

  function toast(message, kind) {
    const t = h('div', { class: 'toast ' + (kind || 'error'), role: kind === 'ok' ? 'status' : 'alert' }, message);
    document.body.append(t);
    setTimeout(() => t.remove(), 6000);
  }

  function banner(kind, title, text, ...actions) {
    return h('div', { class: 'banner ' + kind, role: kind === 'error' ? 'alert' : null },
      h('strong', { text: title }), text ? h('p', { text }) : null, actions.length ? h('div', { class: 'row' }, actions) : null);
  }

  function table(headers, rows, emptyText) {
    if (rows.length === 0) return h('div', { class: 'tablewrap' }, h('p', { class: 'empty', text: emptyText }));
    return h('div', { class: 'tablewrap' },
      h('table', null,
        h('thead', null, h('tr', null, headers.map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', null, rows)));
  }

  function card(title, lede, ...children) {
    return h('section', { class: 'card' }, h('h2', { text: title }), lede ? h('p', { class: 'lede', text: lede }) : null, children);
  }

  function mark() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '30');
    svg.setAttribute('height', '30');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    const box = document.createElementNS(ns, 'rect');
    for (const [k, v] of Object.entries({ x: 1, y: 1, width: 30, height: 30, rx: 8, fill: 'var(--accent)' })) box.setAttribute(k, String(v));
    const route = document.createElementNS(ns, 'path');
    for (const [k, v] of Object.entries({ d: 'M8 22c3-8 7-2 10-8s5-4 6-6', fill: 'none', stroke: 'var(--accent-ink)', 'stroke-width': 2.6, 'stroke-linecap': 'round' })) {
      route.setAttribute(k, String(v));
    }
    const dot = document.createElementNS(ns, 'circle');
    for (const [k, v] of Object.entries({ cx: 8, cy: 22, r: 2.6, fill: 'var(--accent-ink)' })) dot.setAttribute(k, String(v));
    svg.append(box, route, dot);
    return svg;
  }

  function brand(sub) {
    return h('div', { class: 'brand' }, mark(),
      h('div', null, h('div', { class: 'name', text: state.info ? state.info.name : 'FleetDispatch Server' }), h('div', { class: 'sub', text: sub })));
  }

  // ───────── 格式 ─────────

  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDate(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fmtAgo(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 0) return fmtTime(ms);
    if (s < 60) return '剛剛';
    if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
    return fmtDate(ms);
  }
  const appleMs = (s) => (typeof s === 'number' && isFinite(s) ? (s + APPLE_EPOCH) * 1000 : null);
  const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : '—');
  const shortId = (id) => (typeof id === 'string' ? id.slice(0, 8) : '');
  const formatCode = (c) => (typeof c === 'string' && c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c);
  const isActive = (d) => d.revokedAt === null && typeof d.tokenExpiresAt === 'number' && d.tokenExpiresAt > Date.now();

  /** 稽核紀錄的摘要是那筆資料的 JSON（前 2,000 字）：取出容易辨認的欄位。 */
  function describe(entity, summary) {
    if (typeof summary !== 'string' || summary === '') return '—';
    let p = null;
    try {
      p = JSON.parse(summary);
    } catch {
      p = null;
    }
    if (!p || typeof p !== 'object') return summary.length > 80 ? summary.slice(0, 80) + '…' : summary;
    const pick = (...keys) => keys.map((k) => p[k]).filter((v) => typeof v === 'string' && v.trim() !== '').join('・');
    const out = {
      vehicle: () => pick('plateNumber', 'brand'),
      driver: () => pick('name'),
      trip: () => pick('vehiclePlateNumber', 'driver', 'origin'),
      tripRequest: () => [p.requestedBy, REQUEST_STATUS[p.status] || p.status].filter((v) => typeof v === 'string' && v).join('・'),
      inspection: () => pick('vehiclePlateNumber', 'driverName'),
      part: () => pick('name', 'partNumber'),
      workOrder: () => pick('vehiclePlateNumber', 'title'),
      maintenance: () => pick('vehiclePlateNumber', 'itemName', 'name'),
      maintenanceItem: () => pick('vehiclePlateNumber', 'name', 'itemName'),
      preset: () => pick('plateNumber', 'name'),
    }[entity];
    return (out && out()) || '—';
  }

  /** 隨機 UUID（http 的區域網路位址不是安全環境，沒有 crypto.randomUUID）。 */
  function uuid() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  function browserName() {
    const ua = navigator.userAgent || '';
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '瀏覽器';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${b}・${os}` : b;
  }

  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      toast('已複製', 'ok');
    } catch {
      toast('無法自動複製，請手動選取後複製。');
    }
  }

  // ───────── 登入資料（只存在這個瀏覽器） ─────────

  function stores() {
    const out = [];
    try {
      out.push(window.localStorage);
    } catch {
      /* 瀏覽器不允許時略過 */
    }
    try {
      out.push(window.sessionStorage);
    } catch {
      /* 同上 */
    }
    return out;
  }
  function loadSession() {
    for (const s of stores()) {
      try {
        const v = JSON.parse(s.getItem(STORE_KEY) || 'null');
        if (v && typeof v.token === 'string' && v.token.length >= 20) return v;
      } catch {
        /* 損壞的資料視為沒有登入 */
      }
    }
    return null;
  }
  function clearStored() {
    for (const s of stores()) {
      try {
        s.removeItem(STORE_KEY);
      } catch {
        /* 略過 */
      }
    }
  }
  function saveSession(v, remember) {
    clearStored();
    try {
      (remember ? window.localStorage : window.sessionStorage).setItem(STORE_KEY, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  }

  // ───────── API ─────────

  class ApiFailure extends Error {
    constructor(status, code, message, retryAfter) {
      super(message);
      this.status = status;
      this.code = code;
      this.retryAfter = retryAfter;
    }
  }

  async function call(method, path, body, auth = true, extra = null) {
    const headers = { Accept: 'application/json', ...(extra || {}) };
    if (auth && state.session) headers.Authorization = 'Bearer ' + state.session.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit',
      });
    } catch {
      throw new ApiFailure(0, 'network', '無法連線到主機，請檢查網路後再試一次。');
    }
    if (res.status === 204) return null;
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = data && data.error ? data.error : {};
      const failure = new ApiFailure(res.status, err.code || 'error', err.message || `主機回應錯誤（HTTP ${res.status}）`,
        Number(res.headers.get('Retry-After')) || undefined);
      if (res.status === 401 && auth && state.session) expire();
      throw failure;
    }
    return data;
  }

  // ───────── 啟動與登入 ─────────

  function stopTimers() {
    timers.forEach((t) => clearInterval(t));
    timers = [];
  }

  async function boot() {
    stopTimers();
    clear(app).append(h('p', { class: 'boot', text: '載入中…' }));
    try {
      state.info = await call('GET', 'info', undefined, false);
    } catch (e) {
      // PHP 版還沒有 config.php 時，改顯示安裝精靈。
      const setup = await installStatus();
      if (setup) renderInstall(setup);
      else renderFatal(e);
      return;
    }
    document.title = `${state.info.name}｜FleetDispatch Server 管理`;
    state.session = state.session || loadSession();
    if (!state.session) {
      renderLogin();
      return;
    }
    try {
      state.me = await call('GET', 'session');
    } catch (e) {
      if (e.status !== 401) renderFatal(e);
      return;
    }
    if (state.me.role !== 'admin') {
      renderNotAdmin();
      return;
    }
    const wanted = location.hash.slice(1);
    if (TABS.some(([id]) => id === wanted)) state.tab = wanted;
    renderConsole();
  }

  function endSession(notice) {
    stopTimers();
    clearStored();
    Object.assign(state, { session: null, me: null, data: null, devices: null, codes: null });
    renderLogin(notice);
  }

  function expire() {
    endSession('登入已失效（可能已被解除配對，或超過 90 天沒有使用），請重新登入。');
  }

  function renderFatal(e) {
    const setupHint = e.code === 'server_error' && /設定/.test(e.message);
    clear(app).append(h('div', { class: 'center' }, h('div', { class: 'narrow' },
      brand('網頁管理'),
      h('h1', { text: '無法開啟網頁管理' }),
      banner('error', e.message, setupHint ? '請依主機的架設說明檢查設定，修正後重新整理這一頁。' : null),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: '重試', onclick: boot })))));
  }

  // ───────── 安裝精靈（PHP 版，還沒有 config.php 時） ─────────

  async function installStatus() {
    try {
      // 附上假的權杖，讓主機回報 Authorization 標頭能不能傳到 PHP。
      const s = await call('GET', 'install', undefined, false, { Authorization: 'Bearer fd-install-header-check-000000000000' });
      return s && s.installed === false ? s : null;
    } catch {
      return null;
    }
  }

  function field(id, label, control, hint) {
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, hint ? h('span', { class: 'hint', text: hint }) : null);
  }

  function copyButton(value, label) {
    return h('button', { class: 'btn ghost small', type: 'button', text: label || '複製', onclick: () => copy(value) });
  }

  function installError(e) {
    if (e.code === 'rate_limited') return `嘗試太多次，請 ${Math.ceil((e.retryAfter || 900) / 60)} 分鐘後再試。`;
    return e.message;
  }

  function renderInstall(s) {
    stopTimers();
    const row = (ok, title, detail, level) => h('li', null,
      h('span', { class: 'chip ' + (ok ? 'ok' : level || 'warn'), text: ok ? '正常' : level === 'danger' ? '需要處理' : '注意' }),
      h('div', null, h('div', { text: title }), !ok && detail ? h('div', { class: 'muted', text: detail }) : null));
    const drivers = [s.drivers.mysql ? 'MySQL／MariaDB' : null, s.drivers.sqlite ? 'SQLite' : null].filter(Boolean);
    const checks = h('ul', { class: 'checks' },
      row(true, `PHP ${s.phpVersion}`),
      row(drivers.length > 0, '資料庫擴充功能：' + (drivers.join('、') || '沒有'), '請在主機控制台的 PHP 設定啟用 pdo_mysql（或 pdo_sqlite）後重新整理這一頁。', 'danger'),
      row(s.rewrite, '網址改寫', '網址改寫沒有作用：App 的主機網址要加上 /index.php；或請主機商啟用 mod_rewrite 並允許 .htaccess。'),
      row(s.authorization, '權杖標頭（Authorization）', 'PHP 收不到 Authorization 標頭，App 配對後會一直被要求重新配對。請照架設說明「疑難排解」的「一直回 401」修正。', 'danger'),
      row(s.https, 'HTTPS', '目前不是用 HTTPS 開啟。App 只接受 HTTPS（區域網路位址除外），請先在主機控制台啟用 SSL 憑證。'),
      row(s.writable, '程式資料夾可以寫入', '程式資料夾不能讓 PHP 寫入，無法使用安裝精靈：請把資料夾權限改成 PHP 可以寫入後重新整理，或依架設說明手動建立 config.php。', 'danger'));

    const page = h('div', { class: 'narrow wide' },
      brand('安裝'),
      h('h1', { text: '安裝 FleetDispatch Server' }),
      h('p', { text: '這台主機還沒有設定。照下面的步驟完成安裝；完成後這個安裝畫面就會消失。' }),
      card('1. 主機環境', null, checks));

    if (!s.installable) {
      page.append(banner('error', '設定檔的位置由環境變數 FD_PHP_CONFIG 指定', '請依架設說明手動建立設定檔。'));
      clear(app).append(h('div', { class: 'center' }, page));
      return;
    }
    if (drivers.length === 0 || !s.keyFile) {
      page.append(h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: '重新檢查', onclick: boot })));
      clear(app).append(h('div', { class: 'center' }, page));
      return;
    }

    const input = (id, value, extra) => h('input', { type: 'text', id, value, spellcheck: 'false', autocomplete: 'off', ...(extra || {}) });
    const key = input('install-key', '', { class: 'code', placeholder: 'XXXX-XXXX-XXXX', maxlength: '20', autocapitalize: 'characters' });
    const driver = h('select', { id: 'db-driver' },
      s.drivers.mysql ? h('option', { value: 'mysql', text: 'MySQL／MariaDB（建議）' }) : null,
      s.drivers.sqlite ? h('option', { value: 'sqlite', text: 'SQLite（測試或很小的車隊）' }) : null);
    const host = input('db-host', 'localhost');
    const port = input('db-port', '3306', { inputmode: 'numeric', maxlength: '5' });
    const dbName = input('db-name', '', { placeholder: '例如 帳號_fleet', maxlength: '64' });
    const user = input('db-user', '', { maxlength: '80' });
    const pass = h('input', { type: 'password', id: 'db-pass', autocomplete: 'new-password', maxlength: '200' });
    const serverName = input('server-name', 'FleetDispatch Server', { maxlength: '100' });
    const mysqlFields = h('div', { class: 'grid2' },
      field('db-host', '資料庫主機', host, '虛擬主機通常是 localhost'),
      field('db-port', '連接埠', port, 'MySQL 通常是 3306'),
      field('db-name', '資料庫名稱', dbName, '在主機控制台建立的資料庫'),
      field('db-user', '使用者', user, '有這個資料庫全部權限的使用者'),
      field('db-pass', '密碼', pass));
    const sqliteNote = h('p', { class: 'muted', text: 'SQLite 的資料庫檔案會放在程式資料夾的 data/，不需要另外建立資料庫。正式使用、多台裝置同時同步時建議用 MySQL。' });
    const sync = () => {
      mysqlFields.hidden = driver.value !== 'mysql';
      sqliteNote.hidden = driver.value === 'mysql';
    };
    driver.addEventListener('change', sync);
    sync();
    const body = () => ({
      installKey: key.value.trim(), driver: driver.value, host: host.value.trim(), port: port.value.trim(), name: dbName.value.trim(),
      user: user.value.trim(), password: pass.value, serverName: serverName.value.trim(),
    });

    const testResult = h('div');
    const testBtn = h('button', { class: 'btn ghost', type: 'button', text: '測試連線' });
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      try {
        const r = await call('POST', 'install/test', body(), false);
        clear(testResult).append(banner(r.warning ? 'warn' : 'info', `可以連線：${r.version}`, r.warning));
      } catch (e) {
        clear(testResult).append(banner('error', installError(e)));
      }
      testBtn.disabled = false;
    });
    const result = h('div');
    const installBtn = h('button', { class: 'btn', type: 'submit', text: '完成安裝' });
    const form = h('form', { class: 'stack', novalidate: true },
      card('2. 安裝金鑰', `為了確認是能管理這台主機的人在安裝，請用主機控制台的檔案管理員打開程式資料夾裡的 ${s.keyFile}（和 config.sample.php 在同一個資料夾），把「安裝金鑰」那一行的金鑰貼到這裡。安裝完成後這個檔案會自動刪除。`,
        field('install-key', '安裝金鑰', key)),
      card('3. 資料庫', '先在主機控制台建立資料庫與使用者（MySQL），再填入這裡。', field('db-driver', '資料庫類型', driver), mysqlFields, sqliteNote,
        h('div', { class: 'row' }, testBtn), testResult),
      card('4. 主機名稱', null, field('server-name', '名稱', serverName, 'App 的配對主機頁與網頁管理會顯示這個名稱，之後可以修改。')),
      h('div', { class: 'row' }, installBtn),
      result);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      installBtn.disabled = true;
      clear(result);
      try {
        const r = await call('POST', 'install', body(), false);
        renderInstalled(r);
        return;
      } catch (e) {
        clear(result).append(banner('error', installError(e),
          e.code === 'already_installed' ? '如果不是你完成的安裝，請用檔案管理員刪除程式資料夾裡的 config.php，再重新整理這一頁。' : null));
      }
      installBtn.disabled = false;
    });
    page.append(form);
    clear(app).append(h('div', { class: 'center' }, page));
  }

  function renderInstalled(r) {
    const hostUrl = location.origin + BASE;
    const adminUrl = hostUrl + r.adminPath;
    const go = h('button', { class: 'btn', type: 'button', text: '以這個瀏覽器成為第一位管理員' });
    const status = h('div');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const deviceName = '網頁管理（' + browserName() + '）';
        const p = await call('POST', 'pair', { code: r.setupToken, deviceId: uuid(), deviceName, platform: 'web' }, false);
        saveSession({ token: p.token, deviceId: p.deviceId, deviceName }, true);
        location.assign(adminUrl);
      } catch (e) {
        go.disabled = false;
        clear(status).append(banner('error', e.message));
      }
    });
    const keep = card('請保存這些資料', '存在密碼管理器等安全的地方。設定碼只在這裡顯示，管理員的裝置遺失時要用它恢復；網頁管理的網址不會出現在首頁。',
      h('dl', { class: 'facts' },
        h('dt', { text: '設定碼' }), h('dd', null, h('span', { class: 'mono', text: r.setupToken }), ' ', copyButton(r.setupToken)),
        h('dt', { text: '網頁管理' }), h('dd', null, h('span', { class: 'mono', text: adminUrl }), ' ', copyButton(adminUrl)),
        h('dt', { text: 'App 輸入的主機網址' }), h('dd', null, h('span', { class: 'mono', text: hostUrl }), ' ', copyButton(hostUrl))));
    const next = card('下一步', '這個瀏覽器可以直接成為第一位管理員（之後在網頁管理建立配對碼給每一台 App）；也可以改在 App 用設定碼連線。',
      h('div', { class: 'row' }, go), status);
    const page = h('div', { class: 'narrow wide' }, brand('安裝'));
    if (r.written) {
      page.append(h('h1', { text: '安裝完成' }), banner('info', '已建立設定檔 config.php 與資料表', `資料庫：${r.database}`), keep, next);
    } else {
      go.disabled = true;
      const check = h('button', { class: 'btn ghost', type: 'button', text: '我已建立設定檔' });
      check.addEventListener('click', async () => {
        try {
          await call('GET', 'info', undefined, false);
          go.disabled = false;
          clear(status).append(banner('info', '已讀到設定檔，可以繼續。'));
        } catch (e) {
          clear(status).append(banner('error', '還讀不到設定檔', e.message));
        }
      });
      page.append(h('h1', { text: '還差一步：建立設定檔' }),
        banner('warn', '程式資料夾不能寫入，請自己建立 config.php', `資料表已經建立（${r.database}）。`),
        card('建立 config.php', '用主機控制台的檔案管理員，在 config.sample.php 所在的資料夾建立 config.php，貼上下面的內容並儲存（權限設為 600），再按「我已建立設定檔」。',
          h('pre', { class: 'config', text: r.config }),
          h('div', { class: 'row' }, copyButton(r.config, '複製設定檔內容'), check)),
        keep, next);
    }
    clear(app).append(h('div', { class: 'center' }, page));
    window.scrollTo(0, 0);
  }

  const SETUP_SOURCE = {
    cloudflare: '部署時以 npx wrangler secret put FD_SETUP_TOKEN 設定的值（Cloudflare 主控台的 Worker ›「設定」›「變數與機密」也看得到名稱）。',
    docker: '環境變數 FD_SETUP_TOKEN；沒有設定時主機自動產生，以 docker compose exec fleetdispatch node docker/src/admin-tools.ts setup-token 查看。',
    php: 'config.php 裡的 setup_token。',
  };

  function renderLogin(notice) {
    stopTimers();
    const info = state.info;
    const setup = info.setupRequired;
    if (setup && !info.setupConfigured) {
      clear(app).append(h('div', { class: 'center' }, h('div', { class: 'narrow' },
        brand('網頁管理'),
        h('h1', { text: '還不能建立管理員' }),
        h('p', { text: '這台主機還沒有管理員，也還沒有設定「設定碼」，所以目前沒有人可以登入。' }),
        h('ol', { class: 'steps' },
          h('li', { text: info.variant === 'php' ? '在 config.php 填入 setup_token（至少 16 個字元）。'
            : info.variant === 'cloudflare' ? '執行 npx wrangler secret put FD_SETUP_TOKEN 設定一組至少 16 個字元的設定碼。'
              : '設定環境變數 FD_SETUP_TOKEN（至少 16 個字元），或刪除這個設定讓主機自動產生。' }),
          h('li', { text: '重新整理這一頁，用設定碼建立第一位管理員。' })),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: '重新整理', onclick: boot })))));
      return;
    }

    const codeInput = h('input', {
      type: setup ? 'password' : 'text', id: 'login-code', class: setup ? null : 'code', required: true, spellcheck: 'false',
      autocomplete: setup ? 'off' : 'one-time-code', autocapitalize: setup ? 'off' : 'characters', maxlength: setup ? '200' : '12',
      placeholder: setup ? '' : 'XXXX-XXXX',
    });
    const nameInput = h('input', { type: 'text', id: 'login-name', maxlength: '100', required: true, value: '網頁管理（' + browserName() + '）' });
    const remember = h('input', { type: 'checkbox', id: 'login-remember' });
    const submit = h('button', { class: 'btn', type: 'submit', text: setup ? '建立第一位管理員' : '登入' });
    const status = h('div');

    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: 'login-code', text: setup ? '設定碼' : '配對碼' }),
        codeInput,
        h('span', { class: 'hint', text: setup ? SETUP_SOURCE[info.variant] || '部署時設定的設定碼。'
          : '請管理員在 App 的「管理主機」或這個網頁的「配對碼」建立角色為「管理員」的配對碼（只能使用一次）。' })),
      h('div', { class: 'field' },
        h('label', { for: 'login-name', text: '這個瀏覽器的名稱' }),
        nameInput,
        h('span', { class: 'hint', text: '會出現在裝置清單，方便辨認。' })),
      setup
        ? h('p', { class: 'muted', text: '這個瀏覽器會記住登入。建立後請在「配對碼」建立管理員配對碼，讓手機或平板的 App 也成為管理員。' })
        : h('label', { class: 'check', for: 'login-remember' }, remember,
          h('span', null, '記住這個瀏覽器', h('br'), h('span', { class: 'muted', text: '公用電腦請不要勾選，用完請登出。' }))),
      status,
      h('div', { class: 'row' }, submit));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const raw = codeInput.value.trim();
      const deviceName = nameInput.value.trim();
      if (!raw || !deviceName) {
        clear(status).append(banner('error', setup ? '請輸入設定碼與名稱。' : '請輸入配對碼與名稱。'));
        return;
      }
      submit.disabled = true;
      clear(status);
      try {
        const deviceId = uuid();
        const r = await call('POST', 'pair', { code: setup ? raw : raw.toUpperCase(), deviceId, deviceName, platform: 'web' }, false);
        const session = { token: r.token, deviceId: r.deviceId || deviceId, deviceName };
        const saved = saveSession(session, setup || remember.checked);
        state.session = session;
        if (!saved) toast('瀏覽器不允許保存登入資料：關閉這個分頁後需要重新登入。');
        await boot();
      } catch (e) {
        submit.disabled = false;
        const msg = e.code === 'rate_limited'
          ? `嘗試太多次，請 ${Math.ceil((e.retryAfter || 900) / 60)} 分鐘後再試。`
          : e.code === 'invalid_code' ? (setup ? '設定碼不正確。' : '配對碼錯誤、已使用或已過期。') : e.message;
        clear(status).append(banner('error', msg));
        codeInput.focus();
      }
    });

    clear(app).append(h('div', { class: 'center' }, h('div', { class: 'narrow' },
      brand('網頁管理'),
      h('h1', { text: setup ? '建立第一位管理員' : '登入網頁管理' }),
      setup ? h('p', { text: '這台主機還沒有管理員。輸入部署時設定的設定碼，這個瀏覽器就會成為第一位管理員；設定碼之後就不能再用。' }) : null,
      notice ? banner('info', notice) : null,
      h('section', { class: 'card' }, form))));
    codeInput.focus();
  }

  function renderNotAdmin() {
    clear(app).append(h('div', { class: 'center' }, h('div', { class: 'narrow' },
      brand('網頁管理'),
      h('h1', { text: '只有管理員可以使用網頁管理' }),
      h('p', { text: `這個瀏覽器以「${ROLE[state.me.role] || state.me.role}」的身分配對。請登出後改用管理員的配對碼登入。` }),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: '登出', onclick: logout })))));
  }

  async function logout() {
    if (!window.confirm('要登出並解除這個瀏覽器的配對嗎？之後要再登入，需要新的配對碼。')) return;
    try {
      await call('POST', 'unpair');
    } catch (e) {
      if (e.code === 'last_admin') {
        toast('你是目前唯一的管理員，不能登出。請先在「配對碼」建立管理員配對碼，讓另一台裝置成為管理員。');
        return;
      }
      if (e.status !== 401) {
        toast(e.message);
        return;
      }
    }
    endSession('已登出，這個瀏覽器的配對已解除。');
  }

  // ───────── 管理介面 ─────────

  function renderConsole() {
    stopTimers();
    const nav = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': '管理功能' },
      TABS.map(([id, label]) => h('button', {
        type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'panel', 'aria-selected': String(state.tab === id), text: label,
        onclick: () => switchTab(id),
      })));
    clear(app).append(h('div', { class: 'shell' },
      h('header', { class: 'top' },
        brand(`網頁管理・${VARIANT[state.info.variant] || state.info.variant}`),
        h('div', { class: 'who' },
          h('span', { class: 'me', text: `${state.me.deviceName}（${ROLE[state.me.role]}）` }),
          h('button', { class: 'btn ghost small', type: 'button', text: '登出', onclick: logout }))),
      nav,
      h('main', { id: 'panel', role: 'tabpanel', tabindex: '-1' })));
    switchTab(state.tab);
  }

  function switchTab(id) {
    state.tab = id;
    for (const [tid] of TABS) {
      const b = document.getElementById('tab-' + tid);
      if (b) b.setAttribute('aria-selected', String(tid === id));
    }
    try {
      history.replaceState(null, '', '#' + id);
    } catch {
      /* 略過 */
    }
    stopTimers();
    const panel = document.getElementById('panel');
    clear(panel).append(h('p', { class: 'muted', text: '載入中…' }));
    VIEWS[id](panel).catch((e) => {
      if (e && e.status === 401) return;
      clear(panel).append(banner('error', '載入失敗', e && e.message ? e.message : String(e),
        h('button', { class: 'btn small', type: 'button', text: '重試', onclick: () => switchTab(id) })));
    });
  }

  const loadDevices = async () => (state.devices = (await call('GET', 'admin/devices')).devices);
  const loadCodes = async () => (state.codes = (await call('GET', 'admin/pairing-codes')).codes);
  const loadSnapshot = async (force) => {
    if (!state.data || force) state.data = (await call('GET', 'snapshot')).snapshot;
    return state.data;
  };
  const driverList = (data) => (data.drivers || [])
    .filter((d) => typeof d.entityUUID === 'string' && typeof d.name === 'string')
    .map((d) => ({ uuid: d.entityUUID, name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));

  function refreshButton(id) {
    return h('button', { class: 'btn ghost small', type: 'button', text: '重新整理', onclick: () => switchTab(id) });
  }

  // 概況
  async function viewOverview(panel) {
    const [devices, codes, data, loc, audit] = await Promise.all([
      loadDevices(), loadCodes(), loadSnapshot(true), call('GET', 'locations'), call('GET', 'admin/audit?limit=8'),
    ]);
    const active = devices.filter(isActive);
    const admins = active.filter((d) => d.role === 'admin');
    const trips = data.trips || [];
    const running = trips.filter((t) => t.isCompleted === false);
    const pending = (data.tripRequests || []).filter((r) => r.status === 'pending');
    const fresh = loc.locations.filter((l) => !l.stale);

    const parts = [];
    if (admins.length === 1 && admins[0].deviceId === state.session.deviceId) {
      parts.push(banner('warn', '目前只有這個瀏覽器是管理員',
        '建議建立一組「管理員」配對碼，讓你的手機或平板也成為管理員；這個瀏覽器的登入資料被清除時才不會失去管理權限。',
        h('button', { class: 'btn small', type: 'button', text: '建立管理員配對碼', onclick: () => { state.codePreset = 'admin'; switchTab('codes'); } })));
    }
    const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) }));
    parts.push(h('div', { class: 'stats' },
      stat('已配對裝置', active.length), stat('管理員', admins.length), stat('車輛', (data.vehicles || []).length),
      stat('駕駛人', (data.drivers || []).length), stat('出車中', running.length), stat('待簽核申請', pending.length),
      stat('有效配對碼', codes.length), stat('即時位置', fresh.length)));

    const info = state.info;
    parts.push(card('主機', null, h('dl', { class: 'facts' },
      h('dt', { text: '名稱' }), h('dd', { text: info.name }),
      h('dt', { text: '主機 ID' }), h('dd', { class: 'mono', text: info.serverId }),
      h('dt', { text: '部署方式' }), h('dd', { text: VARIANT[info.variant] || info.variant }),
      h('dt', { text: '主機版本' }), h('dd', { class: 'mono', text: `${info.serverVersion}（API v${info.apiVersion}）` }),
      h('dt', { text: 'App 輸入的主機網址' }), h('dd', { class: 'mono', text: location.origin + BASE }))));

    const rows = audit.entries.map((a) => h('tr', null,
      h('td', { class: 'num', text: fmtTime(a.at) }), h('td', { text: text(a.deviceName) }),
      h('td', { class: 'nowrap', text: `${OPERATION[a.operation] || a.operation}${ENTITY[a.entity] || a.entity}` }),
      h('td', { class: 'clip', text: describe(a.entity, a.summary) })));
    parts.push(card('最近的變更', null,
      table(['時間', '裝置', '動作', '摘要'], rows, '還沒有任何變更。'),
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost small', type: 'button', text: '看全部稽核紀錄', onclick: () => switchTab('audit') }))));

    clear(panel).append(...parts);
  }

  // 裝置
  async function viewDevices(panel) {
    const [devices, data] = await Promise.all([loadDevices(), loadSnapshot()]);
    const drivers = driverList(data);
    const shown = devices
      .filter((d) => state.showRevoked || d.revokedAt === null)
      .sort((a, b) => (isActive(b) - isActive(a)) || ((b.lastSeenAt || 0) - (a.lastSeenAt || 0)));

    const rows = shown.map((d) => {
      const mine = d.deviceId === state.session.deviceId;
      const active = isActive(d);
      const roleSel = h('select', { class: 'inline', 'aria-label': `${d.name} 的角色`, disabled: !active || mine },
        Object.entries(ROLE).map(([v, label]) => h('option', { value: v, selected: d.role === v, text: label })));
      const bindSel = h('select', { class: 'inline', 'aria-label': `${d.name} 綁定的駕駛人`, disabled: !active || d.role !== 'driver' },
        h('option', { value: '', text: '不綁定' }),
        drivers.map((x) => h('option', { value: x.uuid, selected: d.driverBinding && d.driverBinding.driverUuid === x.uuid, text: x.name })),
        d.driverBinding && !drivers.some((x) => x.uuid === d.driverBinding.driverUuid)
          ? h('option', { value: d.driverBinding.driverUuid, selected: true, text: `${d.driverBinding.driverName}（已不在駕駛人清單）` }) : null);
      roleSel.addEventListener('change', () => patchDevice(d, { role: roleSel.value }));
      bindSel.addEventListener('change', () => {
        const x = drivers.find((v) => v.uuid === bindSel.value);
        patchDevice(d, { driverBinding: x ? { driverUuid: x.uuid, driverName: x.name } : null });
      });
      const statusChip = d.revokedAt !== null ? h('span', { class: 'chip', text: '已解除配對' })
        : active ? h('span', { class: 'chip ok', text: '使用中' }) : h('span', { class: 'chip warn', text: '權杖已過期' });
      return h('tr', { class: active ? null : 'dim' },
        h('td', null, h('div', { text: d.name }),
          h('div', { class: 'muted', text: [PLATFORM[d.platform] || d.platform, shortId(d.deviceId)].filter(Boolean).join('・') }),
          mine ? h('span', { class: 'chip accent', text: '這個瀏覽器' }) : null),
        h('td', null, roleSel),
        h('td', null, bindSel),
        h('td', { class: 'nowrap', title: fmtTime(d.lastSeenAt), text: fmtAgo(d.lastSeenAt) }),
        h('td', { class: 'num', text: fmtDate(d.pairedAt) }),
        h('td', null, statusChip),
        h('td', null, d.revokedAt === null && !mine
          ? h('button', { class: 'btn danger small', type: 'button', text: '解除配對', onclick: () => unpairDevice(d) }) : null));
    });

    const toggle = h('input', { type: 'checkbox', id: 'show-revoked', checked: state.showRevoked });
    toggle.addEventListener('change', () => {
      state.showRevoked = toggle.checked;
      switchTab('devices');
    });
    clear(panel).append(card('裝置', '配對到這台主機的 App 與瀏覽器。角色與綁定的駕駛人改了之後，該裝置下次同步時生效；解除配對後它就不能再連線。',
      h('div', { class: 'row' }, h('label', { class: 'check', for: 'show-revoked' }, toggle, '顯示已解除配對的裝置'), h('span', { class: 'spacer' }), refreshButton('devices')),
      table(['裝置', '角色', '綁定駕駛人', '最後連線', '配對日期', '狀態', ''], rows, '還沒有配對的裝置。')));
  }

  async function patchDevice(d, body) {
    try {
      await call('PATCH', 'admin/devices/' + encodeURIComponent(d.deviceId), body);
      toast('已更新', 'ok');
    } catch (e) {
      if (e.status === 401) return;
      toast(e.code === 'last_admin' ? '最後一位管理員不能降級。' : e.message);
    }
    switchTab('devices');
  }

  async function unpairDevice(d) {
    if (!window.confirm(`要解除「${d.name}」的配對嗎？那台裝置之後要重新以配對碼加入。`)) return;
    try {
      await call('DELETE', 'admin/devices/' + encodeURIComponent(d.deviceId));
      toast('已解除配對', 'ok');
    } catch (e) {
      if (e.status === 401) return;
      toast(e.code === 'last_admin' ? '最後一位管理員不能解除配對。' : e.message);
    }
    switchTab('devices');
  }

  // 配對碼
  async function viewCodes(panel) {
    const [codes, data] = await Promise.all([loadCodes(), loadSnapshot()]);
    const drivers = driverList(data);
    const preset = state.codePreset || 'driver';
    state.codePreset = null;

    const role = h('select', { id: 'code-role' }, Object.entries(ROLE).map(([v, label]) => h('option', { value: v, selected: v === preset, text: label })));
    const bind = h('select', { id: 'code-binding' }, h('option', { value: '', text: '不綁定' }), drivers.map((x) => h('option', { value: x.uuid, text: x.name })));
    const label = h('input', { type: 'text', id: 'code-label', maxlength: '100', placeholder: '例如：王小明的手機' });
    const ttl = h('select', { id: 'code-ttl' }, TTL_OPTIONS.map(([v, t]) => h('option', { value: String(v), selected: v === 1440, text: t })));
    const bindField = h('div', { class: 'field' }, h('label', { for: 'code-binding', text: '綁定的駕駛人' }), bind,
      h('span', { class: 'hint', text: drivers.length ? '駕駛只會收到這位駕駛人的車趟與巡檢。' : '還沒有駕駛人資料；可以先不綁定，之後在「裝置」設定。' }));
    const syncBind = () => {
      bindField.hidden = role.value !== 'driver';
    };
    role.addEventListener('change', syncBind);
    syncBind();
    const result = h('div');
    const submit = h('button', { class: 'btn', type: 'submit', text: '建立配對碼' });
    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', { for: 'code-role', text: '角色' }), role),
        bindField,
        h('div', { class: 'field' }, h('label', { for: 'code-label', text: '標籤（選填）' }), label),
        h('div', { class: 'field' }, h('label', { for: 'code-ttl', text: '有效期限' }), ttl)),
      h('div', { class: 'row' }, submit),
      result);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      submit.disabled = true;
      const x = drivers.find((v) => v.uuid === bind.value);
      const body = { role: role.value, label: label.value.trim(), ttlMinutes: Number(ttl.value) };
      if (role.value === 'driver' && x) body.driverBinding = { driverUuid: x.uuid, driverName: x.name };
      try {
        const r = await call('POST', 'admin/pairing-codes', body);
        state.codes = null;
        renderCodeList(listHost, await loadCodes());
        const shown = formatCode(r.code);
        clear(result).append(h('div', { class: 'newcode', role: 'status' },
          h('div', { class: 'muted', text: `${ROLE[r.role]}${r.driverBinding ? `・${r.driverBinding.driverName}` : ''}${r.label ? `・${r.label}` : ''}` }),
          h('div', { class: 'code', text: shown }),
          h('p', { text: `這組配對碼只會顯示這一次，${fmtTime(r.expiresAt)} 前有效，只能使用一次。` }),
          h('p', { class: 'muted', text: `在 App 的「設定 › 使用模式 › 連線到自訂主機」輸入主機網址 ${location.origin + BASE} 與這組配對碼；或在另一個瀏覽器開啟這個管理網址登入。` }),
          h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', text: '複製配對碼', onclick: () => copy(shown) }))));
        label.value = '';
      } catch (e) {
        if (e.status !== 401) clear(result).append(banner('error', e.message));
      }
      submit.disabled = false;
    });

    const listHost = h('div');
    renderCodeList(listHost, codes);
    clear(panel).append(
      card('建立配對碼', '新的 App 或瀏覽器用配對碼加入這台主機；角色由配對碼決定。', form),
      card('有效的配對碼', '還沒使用、也還沒過期的配對碼（配對碼本身只在建立時顯示）。', listHost));
  }

  function renderCodeList(host, codes) {
    const rows = codes.map((c) => h('tr', null,
      h('td', { text: text(c.label) }),
      h('td', { text: ROLE[c.role] || c.role }),
      h('td', { text: c.driverBinding ? c.driverBinding.driverName : '—' }),
      h('td', { class: 'num', text: fmtTime(c.createdAt) }),
      h('td', { class: 'num', text: fmtTime(c.expiresAt) }),
      h('td', null, h('button', {
        class: 'btn danger small', type: 'button', text: '撤銷',
        onclick: async () => {
          if (!window.confirm('要撤銷這組配對碼嗎？')) return;
          try {
            await call('DELETE', 'admin/pairing-codes/' + encodeURIComponent(c.id));
            toast('已撤銷', 'ok');
            renderCodeList(host, await loadCodes());
          } catch (e) {
            if (e.status !== 401) toast(e.message);
          }
        },
      }))));
    clear(host).append(table(['標籤', '角色', '綁定駕駛人', '建立時間', '到期時間', ''], rows, '目前沒有有效的配對碼。'));
  }

  // 即時位置
  async function viewLocations(panel) {
    const host = h('div');
    const render = async () => {
      const { locations } = await call('GET', 'locations');
      const rows = locations
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((l) => {
          const lat = Number(l.latitude).toFixed(5);
          const lon = Number(l.longitude).toFixed(5);
          const speed = typeof l.speed === 'number' && l.speed >= 0 ? `${Math.round(l.speed * 3.6)} km/h` : '—';
          return h('tr', null,
            h('td', { class: 'nowrap', text: text(l.plateNumber) }),
            h('td', { text: text(l.deviceName) }),
            h('td', null, h('a', {
              href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`, target: '_blank', rel: 'noopener noreferrer',
              class: 'mono', text: `${lat}, ${lon}`,
            })),
            h('td', { class: 'num', text: speed }),
            h('td', { class: 'nowrap', title: fmtTime(appleMs(l.timestamp)), text: fmtAgo(appleMs(l.timestamp)) }),
            h('td', null, l.stale ? h('span', { class: 'chip warn', text: '超過 5 分鐘沒有更新' }) : h('span', { class: 'chip ok', text: '更新中' })));
        });
      clear(host).append(table(['車牌', '裝置', '位置（另開地圖）', '速度', '最後回報', '狀態'], rows,
        '目前沒有出車中的即時位置。駕駛出車並在 App 開啟位置回報後，會顯示在這裡。'));
    };
    await render();
    clear(panel).append(card('即時位置', '出車中的車輛最近一次回報的位置，每 20 秒自動更新；回車後或 30 分鐘沒有回報就會移除。',
      h('div', { class: 'row end' }, refreshButton('locations')), host));
    timers.push(setInterval(() => {
      if (document.visibilityState === 'visible') render().catch(() => {});
    }, 20000));
  }

  // 稽核紀錄
  async function viewAudit(panel) {
    const tbody = h('tbody');
    const more = h('button', { class: 'btn ghost small', type: 'button', text: '載入更多' });
    let next = null;
    const append = async () => {
      const r = await call('GET', 'admin/audit?limit=100' + (next ? '&before=' + next : ''));
      for (const a of r.entries) {
        tbody.append(h('tr', null,
          h('td', { class: 'num', text: fmtTime(a.at) }),
          h('td', { text: text(a.deviceName) }),
          h('td', { class: 'nowrap', text: `${OPERATION[a.operation] || a.operation}${ENTITY[a.entity] || a.entity}` }),
          h('td', { class: 'mono', title: a.entityId, text: shortId(a.entityId) }),
          h('td', { class: 'clip', text: describe(a.entity, a.summary) })));
      }
      next = r.next;
      more.hidden = !next;
      if (!tbody.firstChild) tbody.append(h('tr', null, h('td', { class: 'empty', colspan: '5', text: '還沒有任何稽核紀錄。' })));
    };
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        await append();
      } catch (e) {
        if (e.status !== 401) toast(e.message);
      }
      more.disabled = false;
    });
    await append();
    clear(panel).append(card('稽核紀錄', '誰在什麼時候新增、修改或刪除了哪一筆資料（最新的在最上面）。',
      h('div', { class: 'row end' }, refreshButton('audit')),
      h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['時間', '裝置', '動作', '資料', '摘要'].map((t) => h('th', { scope: 'col', text: t })))), tbody)),
      h('div', { class: 'row' }, more)));
  }

  // 資料（唯讀）
  const DATA_VIEWS = [['trips', '車趟'], ['vehicles', '車輛'], ['drivers', '駕駛人'], ['requests', '用車申請']];

  async function viewData(panel) {
    const data = await loadSnapshot(true);
    const host = h('div');
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '資料種類' },
      DATA_VIEWS.map(([id, label]) => h('button', {
        type: 'button', 'aria-pressed': String(state.dataView === id), text: label,
        onclick: () => {
          state.dataView = id;
          for (const b of seg.children) b.setAttribute('aria-pressed', String(b.textContent === label));
          renderData(host, data);
        },
      })));
    renderData(host, data);
    clear(panel).append(card('資料', '主機上的資料（唯讀）。新增與修改請使用 App。', h('div', { class: 'row' }, seg, h('span', { class: 'spacer' }), refreshButton('data')), host));
  }

  function renderData(host, data) {
    let content;
    if (state.dataView === 'vehicles') {
      const rows = (data.vehicles || []).slice().sort((a, b) => String(a.plateNumber).localeCompare(String(b.plateNumber)))
        .map((v) => h('tr', null,
          h('td', { class: 'nowrap', text: text(v.plateNumber) }), h('td', { text: text(v.brand) }),
          h('td', { text: VEHICLE_TYPE[v.vehicleType] || text(v.vehicleType) }), h('td', { class: 'num', text: v.modelYear ? String(v.modelYear) : '—' }),
          h('td', { text: v.isElectric ? '電動' : text(v.fuelType) }), h('td', { text: text(v.custodian) })));
      content = table(['車牌', '廠牌', '類型', '年份', '動力', '保管人'], rows, '還沒有車輛。');
    } else if (state.dataView === 'drivers') {
      const rows = (data.drivers || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant'))
        .map((d) => h('tr', null,
          h('td', { text: text(d.name) }), h('td', { class: 'num', text: text(d.phoneNumber) }),
          h('td', { class: 'num', text: text(d.licenseNumber) }), h('td', { class: 'num', text: fmtDate(appleMs(d.licenseExpiryDate)) })));
      content = table(['姓名', '電話', '駕照號碼', '駕照到期'], rows, '還沒有駕駛人。');
    } else if (state.dataView === 'requests') {
      const rows = (data.tripRequests || []).slice().sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0)).slice(0, 200)
        .map((r) => h('tr', null,
          h('td', { class: 'num', text: fmtTime(appleMs(r.requestedAt)) }), h('td', { text: text(r.requestedBy) }),
          h('td', { class: 'num', text: `${fmtTime(appleMs(r.plannedStartTime))} → ${fmtTime(appleMs(r.plannedEndTime))}` }),
          h('td', { class: 'nowrap', text: text(r.vehiclePlateNumber) }),
          h('td', null, h('span', { class: 'chip' + (r.status === 'pending' ? ' warn' : r.status === 'approved' ? ' ok' : ''), text: REQUEST_STATUS[r.status] || text(r.status) }))));
      content = table(['申請時間', '申請人', '預計時間', '車牌', '狀態'], rows, '還沒有用車申請。');
    } else {
      const trips = (data.trips || []).slice().sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
      const rows = trips.slice(0, 200).map((t) => {
        const dist = t.isCompleted && typeof t.odometerEnd === 'number' && typeof t.odometerStart === 'number' && t.odometerEnd >= t.odometerStart
          ? `${Math.round(t.odometerEnd - t.odometerStart)} km` : '—';
        const dest = Array.isArray(t.destinations) ? t.destinations.filter((x) => typeof x === 'string' && x).join('、') : '';
        return h('tr', null,
          h('td', { class: 'num', text: fmtTime(appleMs(t.startTime)) }), h('td', { class: 'nowrap', text: text(t.vehiclePlateNumber) }),
          h('td', { text: text(t.driver) }), h('td', { class: 'clip', title: `${t.origin || ''} → ${dest}`, text: `${text(t.origin)} → ${dest || '—'}` }),
          h('td', { class: 'clip', text: text(t.mission) }), h('td', { class: 'num', text: dist }),
          h('td', null, t.isCompleted ? h('span', { class: 'chip', text: '已回車' }) : h('span', { class: 'chip ok', text: '出車中' })));
      });
      content = h('div', { class: 'stack' },
        table(['出車時間', '車牌', '駕駛', '起點 → 目的地', '任務', '里程', '狀態'], rows, '還沒有車趟。'),
        trips.length > 200 ? h('p', { class: 'muted', text: `只顯示最近 200 筆（共 ${trips.length} 筆）。` }) : null);
    }
    clear(host).append(content);
  }

  // 設定
  async function viewSettings(panel) {
    const name = h('input', { type: 'text', id: 'server-name', maxlength: '100', required: true, value: state.info.name });
    const save = h('button', { class: 'btn', type: 'submit', text: '儲存' });
    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'server-name', text: '主機名稱' }), name,
        h('span', { class: 'hint', text: 'App 的配對主機頁與這個網頁會顯示這個名稱。' })),
      h('div', { class: 'row' }, save));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = name.value.trim();
      if (!v) return;
      save.disabled = true;
      try {
        state.info = await call('PATCH', 'admin/server', { name: v });
        document.title = `${state.info.name}｜FleetDispatch Server 管理`;
        toast('已儲存', 'ok');
        renderConsole();
        return;
      } catch (e) {
        if (e.status !== 401) toast(e.message);
      }
      save.disabled = false;
    });
    const me = state.me;
    clear(panel).append(
      card('主機名稱', null, form),
      card('這個瀏覽器', '這個瀏覽器以管理員的身分配對到主機；登出會解除配對。', h('dl', { class: 'facts' },
        h('dt', { text: '名稱' }), h('dd', { text: me.deviceName }),
        h('dt', { text: '裝置 ID' }), h('dd', { class: 'mono', text: me.deviceId }),
        h('dt', { text: '登入有效到' }), h('dd', { text: `${fmtTime(me.tokenExpiresAt)}（使用時自動延長）` })),
        h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'button', text: '登出並解除配對', onclick: logout }))),
      card('網頁管理的網址', '首頁不會顯示管理頁面；請記下這個網址（可以加入書籤），不要公開分享。',
        h('p', { class: 'mono', text: location.origin + BASE + ADMIN })));
  }

  const VIEWS = {
    overview: viewOverview, devices: viewDevices, codes: viewCodes, locations: viewLocations,
    audit: viewAudit, data: viewData, settings: viewSettings,
  };

  boot();
})();
