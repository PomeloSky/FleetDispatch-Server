// FleetDispatch Server 網頁管理（說明見 docs/protocol.md「網頁管理」與 docs/admin-management.md）。
// 只使用公開的 API v1：以管理員的配對碼（第一次設定用設定碼）登入（POST /web/login），權杖由主機以 HttpOnly Cookie 保存，
// 這個程式不保存也讀不到權杖；非 GET 的請求帶 X-FleetDispatch-CSRF（docs/security-review.md）。
// 不載入任何外部資源；伺服器資料一律以 textContent 顯示。
// 1.2.0：13 個管理區塊、資料清單（搜尋、篩選、排序、分頁）、詳情與關聯、受控修改（預覽差異 → 原因 → 確認）、
// 刪除的影響預覽、用車申請的簽核、報表與 CSV、修改前後歷史與版本比較。
(() => {
  'use strict';

  const root = document.documentElement;
  const BASE = root.dataset.base || '';
  const ADMIN = root.dataset.admin || '';
  const API = BASE + '/api/v1/';
  /** 1.0–1.1 把權杖存在瀏覽器的位置：1.2.0 只用來把舊的登入換成 Cookie，之後刪除。 */
  const STORE_KEY = 'fd.admin.session';
  const CSRF_HEADER = 'X-FleetDispatch-CSRF';
  const APPLE_EPOCH = 978307200;
  const app = document.getElementById('app');

  const ROLE = { admin: '管理員', driver: '駕駛', viewer: '檢視者' };
  const ENTITY = {
    trip: '車趟', vehicle: '車輛', driver: '駕駛人', maintenance: '保養紀錄', maintenanceItem: '保養項目',
    preset: '派車預設值', tripRequest: '用車申請', part: '零件', workOrder: '工單', inspection: '巡檢',
  };
  const AUDIT_ENTITY = { history: '修改歷史', device: '裝置', pairingCode: '配對碼', server: '主機設定' };
  const OPERATION = { create: '新增', update: '修改', delete: '刪除' };
  const OUTCOME = { applied: '已套用', rejected: '被拒絕', conflict: '版本衝突', ignored: '略過' };
  const SOURCE = { app: 'App', web: '網頁管理', api: 'API', cascade: '連鎖刪除' };
  /** 修改前後歷史的原因碼（App 事件被拒絕、略過時）。 */
  const REASON_CODE = {
    role: '這台裝置的角色不能修改', 'not-own-trip': '不是自己的車趟', 'not-own-inspection': '不是自己的巡檢', 'not-own-request': '不是自己的申請',
    'request-already-exists': '申請已經存在', 'create-must-be-pending': '新的申請必須是待簽核', 'approval-fields-not-allowed': '駕駛不能填簽核欄位',
    'requester-mismatch': '申請人不符', 'request-not-found': '找不到申請', 'request-not-pending': '申請已經處理過', 'status-transition-not-allowed': '不允許這個狀態變更',
    'only-admin-can-delete': '只有管理員可以刪除', 'revision-mismatch': '版本不同（期間已被修改）', stale: '比主機上的版本舊（最後寫入者勝）',
    'not-found': '主機上已經沒有這筆', 'vehicle-has-active-trips': '車輛還有出車中的車趟', 'payload-too-large': '內容太大',
    'invalid-expected-revision': '版本號格式錯誤', 'vehicle-deleted': '刪除車輛時一併刪除',
  };
  const VARIANT = { cloudflare: 'Cloudflare Workers＋D1', php: 'PHP', docker: 'Docker／Node' };
  const PLATFORM = { ios: 'iOS', ipados: 'iPadOS', android: 'Android', macos: 'macOS', windows: 'Windows', web: '網頁' };
  const REQUEST_STATUS = { pending: '待簽核', approved: '已核准', rejected: '已退回', cancelled: '已取消' };
  const VEHICLE_TYPE = { car: '小客車', truck: '貨車', van: '廂型車', motorcycle: '機車', bus: '巴士', scooter: '機車' };
  /** 13 個管理區塊（側欄）。 */
  const NAV = [
    ['overview', '總覽'], ['drivers', '使用者與駕駛'], ['devices', '裝置'], ['vehicles', '車輛'], ['trips', '車趟'],
    ['requests', '用車申請'], ['inspections', '巡檢與工單'], ['maintenance', '保養與零件'], ['locations', '即時位置'],
    ['reports', '報表'], ['history', '修改歷史與稽核'], ['codes', '配對碼'], ['settings', '主機設定'],
  ];
  /** 資料清單的網址 → 資料種類。 */
  const LIST_ROUTES = {
    drivers: 'driver', vehicles: 'vehicle', trips: 'trip', requests: 'tripRequest', inspections: 'inspection', workorders: 'workOrder',
    maintenance: 'maintenance', maintitems: 'maintenanceItem', parts: 'part',
  };
  const ENTITY_ROUTE = Object.fromEntries(Object.entries(LIST_ROUTES).map(([r, e]) => [e, r]));
  /** 子分頁所屬的側欄項目。 */
  const ROUTE_NAV = { workorders: 'inspections', maintitems: 'maintenance', parts: 'maintenance', audit: 'history' };
  const ENTITY_NAV = {
    trip: 'trips', vehicle: 'vehicles', driver: 'drivers', tripRequest: 'requests', inspection: 'inspections', workOrder: 'inspections',
    maintenance: 'maintenance', maintenanceItem: 'maintenance', part: 'maintenance', preset: 'settings',
  };
  const SUBTABS = {
    inspections: [['inspections', '巡檢'], ['workorders', '工單']],
    maintenance: [['maintenance', '保養紀錄'], ['maintitems', '保養項目'], ['parts', '零件']],
    history: [['history', '修改前後歷史'], ['audit', '稽核紀錄']],
  };
  const TTL_OPTIONS = [[60, '1 小時'], [1440, '1 天'], [4320, '3 天'], [10080, '7 天']];

  const state = {
    info: null, csrf: null, me: null, schema: null, vehicles: null, drivers: null,
    devices: null, codes: null, codePreset: null, showRevoked: false,
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
  /** 數字（千分位、最多 digits 位小數）。 */
  const fmtNum = (v, digits) => (typeof v === 'number' && isFinite(v) ? v.toLocaleString('zh-TW', { maximumFractionDigits: digits }) : '—');

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
    const roleText = (x) => (x && typeof x === 'object' ? [ROLE[x.role] || x.role, x.driverBinding && x.driverBinding.driverName].filter(Boolean).join('：') : '');
    const out = {
      // 管理操作（1.2.0）
      device: () => [p.name, ROLE[p.role] || p.role, PLATFORM[p.platform] || p.platform,
        p.via === 'setup' ? '以設定碼' : p.via === 'code' ? '以配對碼' : null,
        p.remember === true ? '記住瀏覽器' : p.remember === false ? '不記住瀏覽器' : null,
        p.from && p.to ? `${roleText(p.from)} → ${roleText(p.to)}` : null,
        p.driverBinding && p.driverBinding.driverName ? `綁定 ${p.driverBinding.driverName}` : null]
        .filter((v) => typeof v === 'string' && v !== '').join('・'),
      pairingCode: () => [ROLE[p.role] || p.role, p.label, p.driverBinding && p.driverBinding.driverName ? `綁定 ${p.driverBinding.driverName}` : null,
        typeof p.expiresAt === 'number' ? `到 ${fmtTime(p.expiresAt)}` : null].filter((v) => typeof v === 'string' && v !== '').join('・'),
      server: () => (typeof p.from === 'string' && typeof p.to === 'string' ? `${p.from} → ${p.to}` : ''),
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

  // ───────── 1.0–1.1 的登入資料（權杖存在瀏覽器；1.2.0 換成 Cookie 後刪除） ─────────

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
  /** 舊的登入：權杖與是否「記住這個瀏覽器」（存在 localStorage）。 */
  function loadLegacy() {
    for (const s of stores()) {
      try {
        const v = JSON.parse(s.getItem(STORE_KEY) || 'null');
        if (v && typeof v.token === 'string' && v.token.length >= 20) return { token: v.token, remember: s === window.localStorage };
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

  // ───────── API ─────────

  class ApiFailure extends Error {
    constructor(status, code, message, retryAfter) {
      super(message);
      this.status = status;
      this.code = code;
      this.retryAfter = retryAfter;
    }
  }

  /** 呼叫 API。登入 Cookie 由瀏覽器自動帶上；`auth` 是 false 的請求（登入前）收到 401 不會結束登入。 */
  async function call(method, path, body, auth = true, extra = null) {
    const headers = { Accept: 'application/json', ...(extra || {}) };
    if (method !== 'GET' && method !== 'HEAD') headers[CSRF_HEADER] = state.csrf || 'login';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin',
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
      failure.data = err; // 補充資料：fields（欄位錯誤）、current（版本衝突）、cascade（影響範圍改變）
      if (res.status === 401 && auth && state.me) expire();
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
    // 1.0–1.1 的登入（權杖存在瀏覽器）：換成主機保存的 Cookie，瀏覽器不再保存權杖
    const legacy = loadLegacy();
    let notice = null;
    if (legacy) {
      try {
        adopt(await call('POST', 'web/upgrade', { remember: legacy.remember }, false, { Authorization: 'Bearer ' + legacy.token }));
        clearStored();
        toast('登入方式已更新：登入資料改由主機保存（瀏覽器的程式讀不到），這個瀏覽器不再保存權杖。', 'ok');
      } catch (e) {
        if (e.status !== 401 && e.status !== 403) {
          renderFatal(e);
          return;
        }
        clearStored();
        notice = '網頁管理的登入方式已更新為更安全的方式，舊的登入已經失效，請用管理員的配對碼重新登入。';
      }
    }
    if (!state.me) {
      try {
        adopt(await call('GET', 'session', undefined, false));
      } catch (e) {
        if (e.status === 401) renderLogin(notice);
        else renderFatal(e);
        return;
      }
    }
    if (state.me.role !== 'admin') {
      renderNotAdmin();
      return;
    }
    renderConsole();
  }

  /** 登入成功（GET /session、POST /web/login、/web/upgrade 的回應）：記下這次登入與 CSRF 權杖（不含登入權杖）。 */
  function adopt(me) {
    state.me = me;
    state.csrf = me && me.web ? me.web.csrfToken : null;
  }

  function endSession(notice) {
    stopTimers();
    clearStored();
    Object.assign(state, { csrf: null, me: null, schema: null, vehicles: null, drivers: null, devices: null, codes: null });
    renderLogin(notice);
  }

  function expire() {
    endSession('登入已失效（閒置太久、超過登入期限，或已被解除配對），請用管理員的配對碼重新登入。');
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
        await call('POST', 'web/login', { code: r.setupToken, deviceName, remember: true }, false);
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
        h('p', { text: '這台主機目前沒有可以使用的管理員，也還沒有設定「設定碼」，所以目前沒有人可以登入。' }),
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
    const submit = h('button', { class: 'btn', type: 'submit', text: setup ? '建立管理員' : '登入' });
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
        ? h('p', { class: 'muted', text: '這個瀏覽器會記住登入（90 天內有效，30 天沒有使用需要重新登入）。建立後請在「配對碼」建立管理員配對碼，讓手機或平板的 App 也成為管理員。' })
        : h('label', { class: 'check', for: 'login-remember' }, remember,
          h('span', null, '記住這個瀏覽器', h('br'),
            h('span', { class: 'muted', text: '勾選：90 天內有效，30 天沒有使用需要重新登入。不勾選：關閉瀏覽器、閒置 2 小時或登入 12 小時後需要重新登入。公用電腦請不要勾選，用完請登出。' }))),
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
        adopt(await call('POST', 'web/login', { code: setup ? raw : raw.toUpperCase(), deviceName, remember: setup || remember.checked }, false));
        await boot();
      } catch (e) {
        submit.disabled = false;
        const msg = e.code === 'rate_limited'
          ? `嘗試太多次，請 ${Math.ceil((e.retryAfter || 900) / 60)} 分鐘後再試。`
          : e.code === 'invalid_code' ? (setup ? '設定碼不正確。' : '配對碼錯誤、已使用或已過期。')
            : e.code === 'admin_only' ? '這不是「管理員」的配對碼：網頁管理只能用管理員配對碼登入（這組配對碼沒有被用掉，仍可在 App 使用）。'
              : e.message;
        clear(status).append(banner('error', msg));
        codeInput.focus();
      }
    });

    clear(app).append(h('div', { class: 'center' }, h('div', { class: 'narrow' },
      brand('網頁管理'),
      h('h1', { text: setup ? '建立管理員' : '登入網頁管理' }),
      setup ? h('p', { text: '這台主機目前沒有可以使用的管理員（第一次設定，或所有管理員的登入都已失效）。輸入部署時設定的設定碼，這個瀏覽器就會成為管理員；之後有可以使用的管理員時，設定碼就不能用來登入。' }) : null,
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
    if (!window.confirm('要登出並解除這個瀏覽器的配對嗎？之後要再登入，需要新的管理員配對碼。')) return;
    try {
      await call('POST', 'unpair', undefined, false);
    } catch (e) {
      if (e.code === 'last_admin') {
        toast('目前沒有其他可以使用的管理員，不能登出。請先在「配對碼」建立管理員配對碼，讓另一台裝置成為管理員。');
        return;
      }
      if (e.status !== 401) {
        toast(e.message);
        return;
      }
    }
    endSession('已登出，這個瀏覽器的配對已解除。');
  }

  // ───────── 管理介面：外殼與路由 ─────────
  // 網址的 # 之後是畫面：#trips、#trips?plate=ABC-1234、#r/trip/<UUID>（詳情）。重新整理或分享網址會回到同一個畫面。

  function parseHash() {
    const raw = location.hash.slice(1);
    const i = raw.indexOf('?');
    const path = i >= 0 ? raw.slice(0, i) : raw;
    const query = new URLSearchParams(i >= 0 ? raw.slice(i + 1) : '');
    const parts = path.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    return { parts, query };
  }

  function hashFor(route, query) {
    const q = query ? query.toString() : '';
    return '#' + route + (q ? '?' + q : '');
  }

  function navigate(hash) {
    if (location.hash === hash) renderRoute();
    else location.hash = hash;
  }

  window.addEventListener('hashchange', () => {
    if (state.me && state.me.role === 'admin' && document.getElementById('panel')) renderRoute();
  });

  function renderConsole() {
    stopTimers();
    const nav = h('nav', { class: 'side', 'aria-label': '管理功能' },
      NAV.map(([id, label]) => h('a', { href: '#' + id, id: 'nav-' + id }, label, id === 'requests' ? h('span', { class: 'badge', id: 'pending-badge', hidden: true }) : null)));
    clear(app).append(h('div', { class: 'shell' },
      h('header', { class: 'top' },
        brand(`網頁管理・${VARIANT[state.info.variant] || state.info.variant}`),
        h('div', { class: 'who' },
          h('span', { class: 'me', text: `${state.me.deviceName}（${ROLE[state.me.role]}）` }),
          h('button', { class: 'btn ghost small', type: 'button', text: '登出', onclick: logout }))),
      h('div', { class: 'layout' }, nav, h('main', { id: 'panel', tabindex: '-1' }))));
    if (!location.hash || location.hash === '#') history.replaceState(null, '', '#overview');
    renderRoute();
  }

  /** 側欄「用車申請」的待簽核數。 */
  async function refreshPendingBadge() {
    try {
      const r = await call('GET', 'admin/records?entity=tripRequest&status=pending&limit=1');
      const b = document.getElementById('pending-badge');
      if (b) {
        b.textContent = String(r.total);
        b.hidden = r.total === 0;
        b.setAttribute('aria-label', `${r.total} 筆待簽核`);
      }
    } catch {
      /* 徽章只是提示 */
    }
  }

  async function renderRoute() {
    stopTimers();
    closeDialog();
    refreshPendingBadge();
    const { parts, query } = parseHash();
    let route = parts[0] || 'overview';
    let navId;
    let run;
    if (route === 'r' && parts.length === 3 && ENTITY[parts[1]]) {
      navId = ENTITY_NAV[parts[1]] || 'overview';
      run = (panel) => detailView(panel, parts[1], parts[2]);
    } else if (LIST_ROUTES[route]) {
      navId = ROUTE_NAV[route] || route;
      run = (panel) => listView(panel, route, LIST_ROUTES[route], query);
    } else if (VIEWS[route]) {
      navId = ROUTE_NAV[route] || route;
      run = (panel) => VIEWS[route](panel, query);
    } else {
      route = 'overview';
      navId = 'overview';
      run = (panel) => VIEWS.overview(panel, query);
    }
    for (const [id] of NAV) {
      const a = document.getElementById('nav-' + id);
      if (!a) continue;
      if (id === navId) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const panel = document.getElementById('panel');
    if (!panel) return;
    clear(panel).append(h('p', { class: 'skeleton', role: 'status', text: '載入中…' }));
    try {
      await ensureSchema();
      await run(panel);
      if (parts[0] === 'r') panel.focus({ preventScroll: true });
    } catch (e) {
      if (e && e.status === 401) return;
      clear(panel).append(banner('error', '載入失敗', e && e.message ? e.message : String(e),
        h('button', { class: 'btn small', type: 'button', text: '重試', onclick: renderRoute })));
    }
  }

  // ───────── 共用的資料 ─────────

  async function ensureSchema() {
    if (!state.schema) state.schema = await call('GET', 'admin/schema');
    return state.schema;
  }

  async function allRecords(entity, sort) {
    const out = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const r = await call('GET', `admin/records?entity=${entity}&limit=200&offset=${offset}${sort ? '&sort=' + sort + '&order=asc' : ''}`);
      out.push(...r.records);
      if (out.length >= r.total || r.records.length === 0) break;
    }
    return out;
  }

  async function ensureVehicles(force) {
    if (!state.vehicles || force) state.vehicles = await allRecords('vehicle', 'plate');
    return state.vehicles;
  }

  async function ensureDrivers(force) {
    if (!state.drivers || force) state.drivers = await allRecords('driver', 'name');
    return state.drivers;
  }

  async function ensureDevices(force) {
    if (!state.devices || force) state.devices = (await call('GET', 'admin/devices')).devices;
    return state.devices;
  }

  const vehicleByPlate = (plate) => (state.vehicles || []).find((v) => v.payload && v.payload.plateNumber === plate) || null;
  const driverById = (id) => (state.drivers || []).find((d) => d.id === String(id || '').toUpperCase()) || null;
  const deviceById = (id) => (state.devices || []).find((d) => d.deviceId === String(id || '').toUpperCase()) || null;

  function invalidate() {
    state.vehicles = null;
    state.drivers = null;
    state.devices = null;
  }

  // ───────── 欄位的顯示 ─────────

  const fieldsOf = (entity) => state.schema.entities[entity].fields;
  const fieldOf = (entity, key) => fieldsOf(entity).find((f) => f.key === key) || null;
  const statusLabel = (entity, value) => (state.schema.entities[entity].statuses || {})[value] || value;

  /** 資料的標題（規格的 title 欄位）。 */
  function titleOf(entity, p) {
    if (!p) return '（已刪除）';
    const parts = state.schema.entities[entity].title.map((k) => p[k]).filter((v) => typeof v === 'string' && v.trim() !== '');
    return parts.join('・') || ENTITY[entity];
  }

  function enumLabel(f, v) {
    const hit = (f.values || []).find(([value]) => value === v);
    return hit ? hit[1] : v === '' || v === undefined || v === null ? '—' : String(v);
  }

  /** 欄位值的顯示（文字或節點）。 */
  function fieldValue(entity, f, v) {
    if (entity === 'trip' && f.key === 'isCompleted') return v === true ? '已回車' : '出車中';
    if (v === undefined || v === null || v === '') return f.type === 'enum' ? enumLabel(f, v) : '—';
    switch (f.type) {
      case 'time':
        return fmtTime(appleMs(v));
      case 'date':
        return fmtDate(appleMs(v));
      case 'bool':
        return v === true ? '是' : '否';
      case 'list':
        return Array.isArray(v) && v.length ? v.filter((x) => typeof x === 'string').join('、') : '—';
      case 'enum':
        return enumLabel(f, v);
      case 'number':
      case 'integer':
        return typeof v === 'number' ? fmtNum(v, 2) + (f.unit ? ' ' + f.unit : '') : String(v);
      case 'plate': {
        const veh = vehicleByPlate(v);
        return veh ? recordLink('vehicle', veh.id, v) : String(v);
      }
      case 'driverRef': {
        const d = driverById(v);
        return d ? recordLink('driver', d.id, d.payload ? d.payload.name : v) : shortId(v);
      }
      case 'tripRef':
        return recordLink('trip', String(v).toUpperCase(), '查看車趟');
      case 'deviceRef': {
        const d = deviceById(v);
        return d ? `${d.name}（${ROLE[d.role] || d.role}）` : shortId(v);
      }
      case 'workOrderLines':
        return linesTable(v, ['類別', '項目', '數量', '單價', '小計'], (l) => [
          l.kind === 'part' ? '零件' : '工資', text(l.detail), fmtNum(num(l.quantity, 1), 2), fmtNum(num(l.unitCost, 0), 2),
          fmtNum(num(l.quantity, 1) * num(l.unitCost, 0), 2)]);
      case 'inspectionLines':
        return linesTable(v, ['項目', '結果', '嚴重度', '說明'], (l) => [
          text(l.item), l.status === 'defect' ? '缺陷' : l.status === 'na' ? '免檢' : '正常',
          l.severity === 'major' ? '嚴重' : l.severity === 'minor' ? '輕微' : '—', text(l.comment)]);
      case 'image':
        return typeof v === 'string' && /^[A-Za-z0-9+/=]+$/.test(v) && v.length < 2000000
          ? h('img', { src: 'data:image/png;base64,' + v, alt: f.label, style: 'max-width:160px;max-height:80px' }) : '—';
      default:
        return typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);

  function linesTable(lines, headers, row) {
    if (!Array.isArray(lines) || lines.length === 0) return '—';
    return h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, headers.map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', null, lines.filter((l) => l && typeof l === 'object').map((l) => h('tr', null, row(l).map((c) => h('td', { text: c })))))));
  }

  function recordLink(entity, id, label) {
    return h('a', { href: `#r/${entity}/${encodeURIComponent(id)}`, class: 'rowlink', text: label });
  }

  const tripDistance = (p) => (p && p.isCompleted === true && typeof p.odometerEnd === 'number' && typeof p.odometerStart === 'number'
    ? Math.max(0, p.odometerEnd - p.odometerStart) : null);
  const tripCost = (p) => num(p.fuelCost, 0) + num(p.tollCost, 0) + num(p.parkingCost, 0);
  const workOrderCost = (p) => (Array.isArray(p.lines) ? p.lines : []).reduce((s, l) => s + (l && typeof l === 'object' ? num(l.quantity, 1) * num(l.unitCost, 0) : 0), 0);
  const routeText = (p) => {
    const dest = Array.isArray(p.destinations) ? p.destinations.filter((x) => typeof x === 'string' && x) : [];
    return [text(p.origin), dest.join('、') || '—'].join(' → ');
  };

  function statusChip(entity, p) {
    if (!p) return h('span', { class: 'chip', text: '已刪除' });
    switch (entity) {
      case 'trip':
        return p.isCompleted ? h('span', { class: 'chip', text: '已回車' }) : h('span', { class: 'chip ok', text: '出車中' });
      case 'tripRequest':
        return h('span', { class: 'chip' + (p.status === 'pending' ? ' warn' : p.status === 'approved' ? ' ok' : ''), text: statusLabel(entity, p.status) });
      case 'workOrder':
        return h('span', { class: 'chip' + (p.status === 'completed' ? ' ok' : p.status === 'cancelled' ? '' : ' warn'), text: statusLabel(entity, p.status) });
      case 'inspection':
        return h('span', { class: 'chip' + (p.overallResult === 'pass' ? ' ok' : ' danger'), text: statusLabel(entity, p.overallResult) });
      case 'part':
        return p.reorderThreshold > 0 && p.stockQuantity <= p.reorderThreshold ? h('span', { class: 'chip warn', text: '低於安全庫存' }) : null;
      default:
        return null;
    }
  }

  /** 到期日的提示（逾期、30 天內）。 */
  function dueChip(apple) {
    const ms = appleMs(apple);
    if (ms === null) return '—';
    const days = Math.floor((ms - Date.now()) / 86400000);
    const label = fmtDate(ms);
    if (days < 0) return h('span', { class: 'chip danger', text: `${label}（逾期）` });
    if (days <= 30) return h('span', { class: 'chip warn', text: `${label}（${days} 天內）` });
    return label;
  }

  // ───────── 資料清單 ─────────

  /** 各種類的清單欄位：label、排序鍵（規格的 sorts）、儲存格。 */
  const COLUMNS = {
    trip: [
      { label: '出車時間', sort: 'time', cls: 'num', cell: (p) => fmtTime(appleMs(p.startTime)) },
      { label: '車牌', sort: 'plate', cls: 'nowrap', cell: (p) => text(p.vehiclePlateNumber) },
      { label: '駕駛', sort: 'driver', cls: 'nowrap', cell: (p) => text(p.driver) },
      { label: '起點 → 目的地', cls: 'clip opt', cell: routeText },
      { label: '任務', cls: 'clip opt', cell: (p) => text(p.mission) },
      { label: '里程', sort: 'distance', cls: 'num', cell: (p) => (tripDistance(p) === null ? '—' : fmtNum(tripDistance(p), 1) + ' km') },
      { label: '費用', sort: 'cost', cls: 'num opt', cell: (p) => fmtNum(tripCost(p), 0) },
      { label: '狀態', cell: (p) => statusChip('trip', p) },
    ],
    vehicle: [
      { label: '車牌', sort: 'plate', cls: 'nowrap', cell: (p) => text(p.plateNumber) },
      { label: '廠牌', sort: 'brand', cell: (p) => [text(p.brand), p.modelYear ? String(p.modelYear) : ''].filter((x) => x && x !== '—').join(' ') || '—' },
      { label: '車種・動力', cls: 'opt', cell: (p) => `${enumLabel(fieldOf('vehicle', 'vehicleType'), p.vehicleType)}・${enumLabel(fieldOf('vehicle', 'fuelType'), p.fuelType)}` },
      { label: '保管人', cls: 'opt', cell: (p) => text(p.custodian) },
      { label: '驗車到期', cell: (p) => dueChip(p.inspectionDueDate) },
      { label: '強制險到期', cls: 'opt', cell: (p) => dueChip(p.compulsoryInsuranceDueDate) },
    ],
    driver: [
      { label: '姓名', sort: 'name', cell: (p) => text(p.name) },
      { label: '電話', cls: 'num', cell: (p) => text(p.phoneNumber) },
      { label: '駕照號碼', cls: 'num opt', cell: (p) => text(p.licenseNumber) },
      { label: '駕照到期', sort: 'license', cell: (p) => dueChip(p.licenseExpiryDate) },
    ],
    tripRequest: [
      { label: '申請時間', sort: 'requested', cls: 'num', cell: (p) => fmtTime(appleMs(p.requestedAt)) },
      { label: '申請人', cls: 'nowrap', cell: (p) => text(p.requestedBy) },
      { label: '預計出發', sort: 'time', cls: 'num', cell: (p) => fmtTime(appleMs(p.plannedStartTime)) },
      { label: '車牌', cls: 'nowrap', cell: (p) => text(p.vehiclePlateNumber) },
      { label: '目的地', cls: 'clip opt', cell: routeText },
      { label: '狀態', sort: 'status', cell: (p) => statusChip('tripRequest', p) },
    ],
    inspection: [
      { label: '巡檢時間', sort: 'time', cls: 'num', cell: (p) => fmtTime(appleMs(p.date)) },
      { label: '車牌', sort: 'plate', cls: 'nowrap', cell: (p) => text(p.vehiclePlateNumber) },
      { label: '類型', cls: 'opt', cell: (p) => enumLabel(fieldOf('inspection', 'type'), p.type) },
      { label: '駕駛', sort: 'driver', cls: 'nowrap', cell: (p) => text(p.driverName) },
      { label: '缺陷', cls: 'num', cell: (p) => String((Array.isArray(p.lines) ? p.lines : []).filter((l) => l && l.status === 'defect').length) },
      { label: '結果', sort: 'result', cell: (p) => statusChip('inspection', p) },
    ],
    workOrder: [
      { label: '開單時間', sort: 'time', cls: 'num', cell: (p) => fmtTime(appleMs(p.openedAt)) },
      { label: '標題', cell: (p) => text(p.title) },
      { label: '車牌', sort: 'plate', cls: 'nowrap', cell: (p) => text(p.vehiclePlateNumber) },
      { label: '負責人', cls: 'opt', cell: (p) => text(p.assignedTo) },
      { label: '金額', cls: 'num opt', cell: (p) => fmtNum(workOrderCost(p), 0) },
      { label: '狀態', sort: 'status', cell: (p) => statusChip('workOrder', p) },
    ],
    maintenance: [
      { label: '保養日期', sort: 'time', cls: 'num', cell: (p) => fmtDate(appleMs(p.maintenanceDate)) },
      { label: '車牌', sort: 'plate', cls: 'nowrap', cell: (p) => text(p.vehiclePlateNumber) },
      { label: '里程', sort: 'odometer', cls: 'num', cell: (p) => fmtNum(num(p.odometerReading, 0), 0) + ' km' },
      { label: '費用', sort: 'cost', cls: 'num', cell: (p) => fmtNum(num(p.cost, 0), 0) },
      { label: '備註', cls: 'clip opt', cell: (p) => text(p.notes) },
    ],
    maintenanceItem: [
      { label: '車牌', sort: 'plate', cls: 'nowrap', cell: (p) => text(p.vehiclePlateNumber) },
      { label: '項目', sort: 'name', cell: (p) => text(p.name) },
      { label: '間隔', cls: 'opt', cell: (p) => [p.intervalKm > 0 ? fmtNum(p.intervalKm, 0) + ' km' : '', p.intervalMonths > 0 ? p.intervalMonths + ' 個月' : ''].filter(Boolean).join('・') || '—' },
      { label: '上次保養', sort: 'time', cls: 'num', cell: (p) => fmtDate(appleMs(p.lastServiceDate)) },
    ],
    part: [
      { label: '名稱', sort: 'name', cell: (p) => text(p.name) },
      { label: '料號', cls: 'num opt', cell: (p) => text(p.partNumber) },
      { label: '庫存', sort: 'stock', cls: 'num', cell: (p) => `${fmtNum(num(p.stockQuantity, 0), 2)} ${text(p.unit) === '—' ? '' : p.unit}` },
      { label: '單價', sort: 'cost', cls: 'num opt', cell: (p) => fmtNum(num(p.unitCost, 0), 2) },
      { label: '', cell: (p) => statusChip('part', p) },
    ],
    preset: [
      { label: '公司名稱', cell: (p) => text(p.companyName) },
      { label: '預設起點', cell: (p) => text(p.defaultOrigin) },
      { label: '最近修改', sort: 'modified', cls: 'num', cell: (p) => fmtTime(appleMs(p.lastModifiedAt)) },
    ],
  };

  const LIST_INTRO = {
    driver: '駕駛人資料（姓名、電話、駕照）。主機沒有使用者帳號：登入的是配對的裝置（見「裝置」），駕駛裝置可以綁定一位駕駛人。',
    vehicle: '車隊的車輛。車牌是車趟、保養、工單、巡檢對應車輛的依據，請在 App 修改車牌。',
    trip: '出車與回車的紀錄。可依狀態、車牌、駕駛人、期間篩選；點一筆看詳情、修改或回車。',
    tripRequest: '駕駛送出的用車申請。待簽核的申請可以在詳情核准（建立車趟）或退回。',
    inspection: '出車前、收車後的巡檢紀錄；結果由明細判斷。',
    workOrder: '維修工單。完工請在 App 操作（會扣零件庫存並寫保養紀錄）。',
    maintenance: '已完成的保養紀錄。',
    maintenanceItem: '各車的保養項目與間隔。',
    part: '零件與庫存。',
  };

  const PAGE_SIZE = 50;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  /** 日期（YYYY-MM-DD，這台電腦的時區）的開始時刻（毫秒）。 */
  function dayStartMs(date, plusDays) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d + (plusDays || 0)).getTime();
  }

  async function listView(panel, route, entity, query) {
    const es = state.schema.entities[entity];
    const hasPlate = fieldsOf(entity).some((f) => f.key === 'vehiclePlateNumber');
    const hasDriver = ['trip', 'inspection', 'tripRequest'].includes(entity);
    const params = new URLSearchParams({ entity, limit: String(PAGE_SIZE) });
    for (const k of ['q', 'status', 'plate', 'driverId', 'deviceId', 'sort', 'order', 'offset']) {
      const v = query.get(k);
      if (v) params.set(k, v);
    }
    const from = query.get('from');
    const to = query.get('to');
    if (from && ISO_DATE.test(from)) params.set('from', String(dayStartMs(from)));
    if (to && ISO_DATE.test(to)) params.set('to', String(dayStartMs(to, 1)));
    const [res] = await Promise.all([call('GET', 'admin/records?' + params), ensureVehicles(), hasDriver ? ensureDrivers() : null]);

    const go = (changes) => {
      const q = new URLSearchParams(query);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === undefined || v === '') q.delete(k);
        else q.set(k, String(v));
      }
      if (!('offset' in changes)) q.delete('offset');
      navigate(hashFor(route, q));
    };

    // 篩選列
    const qInput = h('input', { type: 'search', id: 'f-q', value: query.get('q') || '', maxlength: '100', placeholder: '搜尋', 'aria-label': '搜尋' });
    const controls = [h('div', { class: 'field wide' }, h('label', { for: 'f-q', text: '搜尋' }), qInput)];
    const selects = {};
    const statuses = Object.entries(es.statuses || {});
    if (statuses.length) {
      selects.status = h('select', { id: 'f-status' }, h('option', { value: '', text: '全部' }),
        statuses.map(([v, label]) => h('option', { value: v, selected: query.get('status') === v, text: label })));
      controls.push(h('div', { class: 'field' }, h('label', { for: 'f-status', text: '狀態' }), selects.status));
    }
    if (hasPlate) {
      selects.plate = h('select', { id: 'f-plate' }, h('option', { value: '', text: '全部車輛' }),
        (state.vehicles || []).map((v) => v.payload && v.payload.plateNumber).filter(Boolean)
          .map((plate) => h('option', { value: plate, selected: query.get('plate') === plate, text: plate })));
      controls.push(h('div', { class: 'field' }, h('label', { for: 'f-plate', text: '車輛' }), selects.plate));
    }
    if (hasDriver) {
      selects.driverId = h('select', { id: 'f-driver' }, h('option', { value: '', text: '全部駕駛人' }),
        (state.drivers || []).filter((d) => d.payload).map((d) => h('option', { value: d.id, selected: query.get('driverId') === d.id, text: d.payload.name })));
      controls.push(h('div', { class: 'field' }, h('label', { for: 'f-driver', text: '駕駛人' }), selects.driverId));
    }
    let fromInput = null;
    let toInput = null;
    if (es.time) {
      fromInput = h('input', { type: 'date', id: 'f-from', value: from && ISO_DATE.test(from) ? from : '' });
      toInput = h('input', { type: 'date', id: 'f-to', value: to && ISO_DATE.test(to) ? to : '' });
      controls.push(h('div', { class: 'field' }, h('label', { for: 'f-from', text: '從' }), fromInput),
        h('div', { class: 'field' }, h('label', { for: 'f-to', text: '到' }), toInput));
    }
    const form = h('form', { class: 'filters', role: 'search' }, controls,
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit', text: '套用' }),
        h('button', { class: 'btn ghost small', type: 'button', text: '清除', onclick: () => navigate('#' + route) })));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      go({
        q: qInput.value.trim(), status: selects.status ? selects.status.value : null, plate: selects.plate ? selects.plate.value : null,
        driverId: selects.driverId ? selects.driverId.value : null, from: fromInput ? fromInput.value : null, to: toInput ? toInput.value : null,
      });
    });

    // 表格
    const sort = query.get('sort') || es.defaultSort;
    const order = query.get('order') || es.defaultOrder;
    const cols = COLUMNS[entity];
    const head = h('tr', null, cols.map((c) => {
      if (!c.sort) return h('th', { scope: 'col', class: c.cls && c.cls.includes('opt') ? 'opt' : null, text: c.label });
      const active = sort === c.sort;
      return h('th', { scope: 'col', class: c.cls && c.cls.includes('opt') ? 'opt' : null, 'aria-sort': active ? (order === 'asc' ? 'ascending' : 'descending') : 'none' },
        h('button', { type: 'button', class: 'sort', onclick: () => go({ sort: c.sort, order: active && order === 'asc' ? 'desc' : active ? 'asc' : es.sorts[c.sort] && c.sort === es.defaultSort ? es.defaultOrder : 'asc' }) },
          c.label, active ? (order === 'asc' ? ' ▲' : ' ▼') : ''));
    }));
    const rows = res.records.map((r) => {
      const tr = h('tr', { class: 'link' }, cols.map((c, i) => {
        const v = r.payload ? c.cell(r.payload) : '—';
        const td = h('td', { class: c.cls || null });
        if (i === 0) td.append(recordLink(entity, r.id, typeof v === 'string' ? v : '開啟'));
        else if (v instanceof Node) td.append(v);
        else td.textContent = v === undefined || v === null || v === '' ? '—' : String(v);
        if (i === 0 && !(typeof v === 'string')) td.firstChild.textContent = '開啟';
        return td;
      }));
      tr.addEventListener('click', (ev) => {
        if (ev.target.closest('a')) return;
        navigate(`#r/${entity}/${encodeURIComponent(r.id)}`);
      });
      return tr;
    });
    const offset = Number(query.get('offset') || 0);
    const pager = h('div', { class: 'pager' },
      h('span', { role: 'status', text: res.total === 0 ? '沒有符合的資料' : `第 ${offset + 1}–${offset + res.records.length} 筆，共 ${res.total} 筆` }),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost small', type: 'button', text: '上一頁', disabled: offset <= 0, onclick: () => go({ offset: Math.max(0, offset - PAGE_SIZE) || null }) }),
        h('button', { class: 'btn ghost small', type: 'button', text: '下一頁', disabled: offset + res.records.length >= res.total, onclick: () => go({ offset: offset + PAGE_SIZE }) })));
    const tableNode = res.records.length === 0
      ? h('div', { class: 'tablewrap' }, h('p', { class: 'empty', text: hasFilters(query) ? '沒有符合條件的資料，試試清除篩選。' : `還沒有${ENTITY[entity]}。` }))
      : h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, head), h('tbody', null, rows)));

    // 手機上篩選欄位很多：收在「篩選」裡，有條件時預設展開
    const filterBox = h('details', { class: 'filterbox', open: hasFilters(query) || window.matchMedia('(min-width: 641px)').matches },
      h('summary', { text: hasFilters(query) ? '篩選（已套用）' : '篩選' }), form);
    clear(panel).append(card(sectionTitle(route, entity), LIST_INTRO[entity] || null,
      subtabs(route), filterBox, tableNode, pager));
  }

  const hasFilters = (query) => ['q', 'status', 'plate', 'driverId', 'deviceId', 'from', 'to'].some((k) => query.get(k));

  function sectionTitle(route, entity) {
    return ENTITY[entity] || NAV.find(([id]) => id === route)?.[1] || '';
  }

  function subtabs(route) {
    const tabs = SUBTABS[ROUTE_NAV[route] || route];
    if (!tabs) return null;
    return h('nav', { class: 'subtabs', 'aria-label': '分類' },
      tabs.map(([id, label]) => h('a', { href: '#' + id, 'aria-current': id === route ? 'page' : null, text: label })));
  }

  // ───────── 詳情 ─────────

  async function detailView(panel, entity, id) {
    const [d] = await Promise.all([call('GET', `admin/records/${entity}/${encodeURIComponent(id)}`), ensureVehicles(), ensureDrivers(), ensureDevices()]);
    const rec = d.record;
    const p = rec.payload;
    const es = state.schema.entities[entity];
    const back = h('a', { href: '#' + (ENTITY_ROUTE[entity] || 'overview'), class: 'small', text: `← ${ENTITY[entity]}清單` });

    // 標題與動作
    const actions = [];
    if (p) {
      const editable = fieldsOf(entity).some((f) => f.edit && !(entity === 'trip' && f.key === 'isCompleted'));
      if (entity === 'trip' && p.isCompleted !== true) {
        actions.push(h('button', { class: 'btn small', type: 'button', text: '回車', onclick: () => editDialog(entity, rec, 'complete') }));
      }
      if (entity === 'tripRequest' && p.status === 'pending') {
        actions.push(h('button', { class: 'btn small', type: 'button', text: '核准', onclick: () => decideDialog(rec, 'approve') }));
        actions.push(h('button', { class: 'btn danger small', type: 'button', text: '退回', onclick: () => decideDialog(rec, 'reject') }));
      }
      if (editable && entity !== 'tripRequest') {
        actions.push(h('button', { class: 'btn ghost small', type: 'button', text: '修改', onclick: () => editDialog(entity, rec, 'edit') }));
      }
      actions.push(h('button', { class: 'btn danger small', type: 'button', text: '刪除', onclick: () => deleteDialog(entity, rec) }));
    }
    const by = rec.updatedBy ? (rec.updatedBy.name || shortId(rec.updatedBy.deviceId)) : '—';
    const head = h('section', { class: 'card' },
      back,
      h('div', { class: 'detailhead' },
        h('h1', { text: `${ENTITY[entity]}：${titleOf(entity, p)}` }), statusChip(entity, p), h('span', { class: 'spacer' }), actions),
      h('p', { class: 'muted small', text: `版本 ${rec.revision}・最近寫入 ${fmtTime(rec.updatedAt)}（${by}）・UUID ${rec.id}` }),
      rec.deleted ? banner('warn', '這筆資料已被刪除', '只保留修改前後歷史。') : null);

    const parts = [head];
    if (p) {
      parts.push(card('內容', null, fieldsGrid(entity, p)));
      if (entity === 'trip') parts.push(tripLocationCard(p, d.location));
    }
    for (const [key, rel] of Object.entries(d.related || {})) parts.push(relatedCard(entity, p, key, rel));
    const hist = h('div');
    parts.push(card('修改前後歷史', '每一次寫入（App、網頁管理、連鎖刪除）與沒有套用的 App 修改（拒絕、版本衝突、略過）。', hist));
    clear(panel).append(...parts);
    await renderHistory(hist, { entity, id: rec.id }, true);
  }

  function fieldsGrid(entity, p) {
    const shown = fieldsOf(entity).filter((f) => !f.key.startsWith('departure') && !(entity === 'trip' && f.key === 'driver' && p.driverEntityUUID));
    const known = new Set(fieldsOf(entity).map((f) => f.key));
    const extra = Object.keys(p).filter((k) => !known.has(k) && k !== 'entityUUID');
    return h('dl', { class: 'fields' },
      shown.map((f) => {
        const v = fieldValue(entity, f, p[f.key]);
        return h('div', null, h('dt', { text: f.label }), h('dd', null, v instanceof Node ? v : String(v)));
      }),
      extra.map((k) => h('div', null, h('dt', { class: 'mono', text: k }), h('dd', { class: 'small', text: JSON.stringify(p[k]) }))));
  }

  /** 車趟的出發定位、出車中的即時位置；路線軌跡只在出車的裝置上。 */
  function tripLocationCard(p, live) {
    const items = [];
    const osm = (lat, lon) => h('a', {
      href: `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=16/${lat.toFixed(5)}/${lon.toFixed(5)}`,
      target: '_blank', rel: 'noopener noreferrer', class: 'mono', text: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    });
    const status = enumLabel(fieldOf('trip', 'departureLocationStatus'), p.departureLocationStatus);
    if (typeof p.departureLatitude === 'number' && typeof p.departureLongitude === 'number') {
      items.push(h('div', null, h('dt', { text: '出發位置' }), h('dd', null, osm(p.departureLatitude, p.departureLongitude),
        h('div', { class: 'muted small', text: `${status}・±${fmtNum(num(p.departureHorizontalAccuracy, 0), 0)} m・${fmtTime(appleMs(p.departureLocationTime))}` }))));
    } else {
      items.push(h('div', null, h('dt', { text: '出發位置' }), h('dd', { text: p.departureLocationStatus ? status : '沒有記錄（App 8.1 以前的車趟，或沒有開啟路線記錄）' })));
    }
    if (live) {
      items.push(h('div', null, h('dt', { text: '即時位置' }), h('dd', null, osm(live.latitude, live.longitude),
        h('div', { class: 'muted small', text: `${text(live.deviceName)}・${fmtAgo(appleMs(live.timestamp))}${live.stale ? '（超過 5 分鐘沒有更新）' : ''}` }))));
    }
    return card('位置', '路線軌跡只存在出車的裝置上（App 的車趟詳情、路線回放）；主機只有出發定位與出車中的即時位置。', h('dl', { class: 'fields' }, items));
  }

  const RELATED_TITLE = {
    trips: '車趟', vehicles: '車輛', drivers: '駕駛人', tripRequests: '用車申請', maintenance: '保養紀錄', maintenanceItems: '保養項目',
    workOrders: '工單', inspections: '巡檢', parts: '零件', devices: '綁定的裝置',
  };
  const RELATED_NOTE = {
    trip: { inspections: '同車、出車前 1 天到回車後 1 天的巡檢', workOrders: '同車、這段期間開著的工單' },
    inspection: { trips: '同車、巡檢前後 1 天內出車的車趟' },
  };

  function relatedCard(entity, p, key, rel) {
    const title = RELATED_TITLE[key] || key;
    if (Array.isArray(rel)) {
      const rows = rel.map((dv) => h('tr', null,
        h('td', { text: dv.name }), h('td', { text: ROLE[dv.role] || dv.role }), h('td', { class: 'nowrap', text: fmtAgo(dv.lastSeenAt) }),
        h('td', null, dv.revokedAt ? h('span', { class: 'chip', text: '已解除配對' }) : h('span', { class: 'chip ok', text: '配對中' }))));
      return card(title, null, table(['裝置', '角色', '最近連線', '狀態'], rows, '沒有綁定的裝置。'), h('div', { class: 'row end' }, h('a', { href: '#devices', class: 'small', text: '到裝置管理' })));
    }
    const cols = COLUMNS[rel.entity] || [];
    const rows = rel.records.map((r) => h('tr', { class: 'link', onclick: (ev) => { if (!ev.target.closest('a')) navigate(`#r/${rel.entity}/${encodeURIComponent(r.id)}`); } },
      cols.map((c, i) => {
        const v = r.payload ? c.cell(r.payload) : '—';
        const td = h('td', { class: c.cls || null });
        if (i === 0) td.append(recordLink(rel.entity, r.id, typeof v === 'string' ? v : '開啟'));
        else if (v instanceof Node) td.append(v);
        else td.textContent = v === undefined || v === null || v === '' ? '—' : String(v);
        return td;
      })));
    const more = [];
    if (rel.total > rel.records.length) more.push(h('span', { class: 'muted small', text: `只顯示 ${rel.records.length} 筆，共 ${rel.total} 筆` }));
    const listRoute = ENTITY_ROUTE[rel.entity];
    const q = new URLSearchParams();
    if (entity === 'vehicle' && p && p.plateNumber && fieldsOf(rel.entity).some((f) => f.key === 'vehiclePlateNumber')) q.set('plate', p.plateNumber);
    if (entity === 'driver' && ['trip', 'inspection', 'tripRequest'].includes(rel.entity)) q.set('driverId', parseHash().parts[2] || '');
    if (listRoute && q.toString()) more.push(h('a', { href: hashFor(listRoute, q), class: 'small', text: '在清單中查看全部' }));
    const note = (RELATED_NOTE[entity] || {})[key];
    return card(`${title}（${rel.total}）`, note || null,
      rel.records.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col', class: c.cls && c.cls.includes('opt') ? 'opt' : null, text: c.label })))), h('tbody', null, rows)))
        : h('p', { class: 'muted', text: `沒有相關的${title}。` }),
      more.length ? h('div', { class: 'row end' }, more) : null);
  }

  // ───────── 修改前後歷史 ─────────

  /** 歷史列表（詳情頁與「修改歷史」共用）。single：同一筆資料（顯示版本比較）。 */
  async function renderHistory(host, filter, single) {
    const piiKey = filter.entity === 'driver' || !filter.entity;
    let pii = false;
    let next = null;
    const entries = [];
    const list = h('ul', { class: 'timeline' });
    const more = h('button', { class: 'btn ghost small', type: 'button', text: '載入更多', hidden: true });
    const compareHost = h('div');
    const retention = h('p', { class: 'muted small', hidden: true });
    const load = async (reset) => {
      const q = new URLSearchParams({ limit: single ? '100' : '50' });
      for (const k of ['entity', 'id', 'outcome', 'source']) if (filter[k]) q.set(k, filter[k]);
      if (!reset && next) q.set('before', String(next));
      if (pii) q.set('pii', '1');
      const r = await call('GET', 'admin/history?' + q);
      if (reset) {
        entries.length = 0;
        clear(list);
      }
      entries.push(...r.entries);
      if (!single && typeof r.retentionDays === 'number') {
        retention.textContent = r.retentionDays > 0
          ? `主機設定只保留最近 ${r.retentionDays} 天的修改前後歷史，較舊的會自動刪除（稽核紀錄不受影響）。`
          : '修改前後歷史不會自動刪除（主機可以設定保留天數，見架設說明）。';
        retention.hidden = false;
      }
      for (const e of r.entries) list.append(historyItem(e, single));
      next = r.next;
      more.hidden = !next;
      if (entries.length === 0) list.append(h('li', { class: 'muted', text: '還沒有修改前後歷史（1.2.0 之前的修改沒有紀錄）。' }));
      if (single) renderCompare(compareHost, filter.entity, entries);
    };
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        await load(false);
      } catch (e) {
        if (e.status !== 401) toast(e.message);
      }
      more.disabled = false;
    });
    const tools = [];
    if (piiKey) {
      const btn = h('button', { class: 'btn ghost small', type: 'button', text: '顯示個資' });
      btn.addEventListener('click', async () => {
        if (!pii && !window.confirm('要顯示駕駛人的電話、證號與備註嗎？這次查看會記在稽核紀錄。')) return;
        pii = !pii;
        btn.textContent = pii ? '遮蔽個資' : '顯示個資';
        try {
          await load(true);
        } catch (e) {
          if (e.status !== 401) toast(e.message);
        }
      });
      tools.push(h('span', { class: 'muted small', text: '駕駛人的電話、證號、備註預設遮蔽。' }), btn);
    }
    clear(host).append(...[tools.length ? h('div', { class: 'row' }, tools) : null, retention, compareHost, list, h('div', { class: 'row' }, more)].filter(Boolean));
    await load(true);
  }

  function historyItem(e, single) {
    const label = `${OPERATION[e.operation] || e.operation}${single ? '' : ENTITY[e.entity] || e.entity}`;
    const chips = [
      h('span', { class: 'chip' + (e.outcome === 'applied' ? '' : e.outcome === 'conflict' || e.outcome === 'rejected' ? ' danger' : ' warn'), text: OUTCOME[e.outcome] || e.outcome }),
      h('span', { class: 'chip accent', text: SOURCE[e.source] || e.source }),
    ];
    const reason = e.reason ? (REASON_CODE[e.reason] || e.reason) : null;
    const diffHost = h('div', { hidden: true });
    const toggle = h('button', { class: 'btn ghost small', type: 'button', text: '查看差異', 'aria-expanded': 'false' });
    toggle.addEventListener('click', () => {
      const open = diffHost.hidden;
      diffHost.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '收起' : '查看差異';
      if (open && !diffHost.firstChild) {
        const keys = Array.isArray(e.changedFields) && e.changedFields.length ? e.changedFields
          : [...new Set([...Object.keys(e.before || {}), ...Object.keys(e.after || {})])].filter((k) => k !== 'lastModifiedAt');
        diffHost.append(diffTable(e.entity, e.before, e.after, keys, e.outcome === 'applied' ? ['修改前', '修改後'] : ['主機上的內容', '送來的內容（沒有套用）']));
      }
    });
    return h('li', null,
      h('div', { class: 'meta' },
        h('strong', { text: label }), chips,
        h('span', { class: 'muted', text: `${fmtTime(e.at)}・${text(e.actor && e.actor.name)}・版本 ${e.revision}` }),
        single ? null : recordLink(e.entity, e.entityId, shortId(e.entityId))),
      reason ? h('div', { class: 'small', text: `原因：${reason}` }) : null,
      Array.isArray(e.changedFields) && e.changedFields.length && e.operation !== 'create'
        ? h('div', { class: 'muted small', text: '變更：' + e.changedFields.map((k) => (fieldOf(e.entity, k) || {}).label || k).join('、') }) : null,
      (e.before || e.after) ? h('div', { class: 'row' }, toggle) : null,
      diffHost);
  }

  /** 兩份內容的差異（只列 keys）。 */
  function diffTable(entity, before, after, keys, titles) {
    const rows = keys.map((k) => {
      const f = fieldOf(entity, k) || { key: k, label: k, type: 'text' };
      const fmt = (obj) => {
        if (!obj || !(k in obj)) return '（沒有）';
        const v = fieldValue(entity, f, obj[k]);
        return v instanceof Node ? v : String(v);
      };
      return h('tr', null, h('th', { scope: 'row', text: f.label }), h('td', { class: 'before' }, fmt(before)), h('td', { class: 'after' }, fmt(after)));
    });
    return h('div', { class: 'tablewrap' }, h('table', { class: 'diff' },
      h('thead', null, h('tr', null, h('th', { scope: 'col', text: '欄位' }), h('th', { scope: 'col', text: titles[0] }), h('th', { scope: 'col', text: titles[1] }))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: '3', class: 'empty', text: '沒有差異' })))));
  }

  /** 指定版本比較：每一筆已套用的紀錄的「修改後」就是那個版本的完整內容。 */
  function renderCompare(host, entity, entries) {
    const versions = entries.filter((e) => e.outcome === 'applied' && e.after).sort((a, b) => a.revision - b.revision);
    clear(host);
    if (versions.length < 2) return;
    const opt = (sel) => versions.map((e) => h('option', { value: String(e.revision), selected: e.revision === sel, text: `版本 ${e.revision}（${fmtTime(e.at)}）` }));
    const a = h('select', { id: 'cmp-a', class: 'inline' }, opt(versions[versions.length - 2].revision));
    const b = h('select', { id: 'cmp-b', class: 'inline' }, opt(versions[versions.length - 1].revision));
    const out = h('div');
    const show = () => {
      const ea = versions.find((e) => String(e.revision) === a.value);
      const eb = versions.find((e) => String(e.revision) === b.value);
      const keys = [...new Set([...Object.keys(ea.after), ...Object.keys(eb.after)])].filter((k) => k !== 'lastModifiedAt' && JSON.stringify(ea.after[k]) !== JSON.stringify(eb.after[k]));
      clear(out).append(diffTable(entity, ea.after, eb.after, keys, [`版本 ${ea.revision}`, `版本 ${eb.revision}`]));
    };
    a.addEventListener('change', show);
    b.addEventListener('change', show);
    host.append(h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('label', { for: 'cmp-a', class: 'small', text: '比較版本' }), a, h('span', { text: '與' }), b), out));
    show();
  }

  // ───────── 對話框 ─────────

  let openDialogEl = null;

  function closeDialog() {
    if (openDialogEl) {
      try {
        openDialogEl.close();
      } catch {
        /* 已關閉 */
      }
      openDialogEl.remove();
      openDialogEl = null;
    }
  }

  function showDialog(title, ...children) {
    closeDialog();
    const dlg = h('dialog', { 'aria-label': title }, h('div', { class: 'dlg' }, h('h2', { text: title }), children));
    dlg.addEventListener('close', () => {
      if (openDialogEl === dlg) openDialogEl = null;
      dlg.remove();
    });
    document.body.append(dlg);
    openDialogEl = dlg;
    dlg.showModal();
    return dlg;
  }

  function reasonField(id) {
    const input = h('input', { type: 'text', id, maxlength: '500', required: true, autocomplete: 'off' });
    const chips = h('div', { class: 'reasons' }, (state.schema.reasons || []).map((r) => h('button', { type: 'button', text: r, onclick: () => { input.value = r; input.focus(); } })));
    return { input, node: h('div', { class: 'field' }, h('label', { for: id, text: '原因（寫進修改前後歷史）' }), input, chips) };
  }

  /** 表單的輸入元件（依規格的欄位型別）。 */
  function inputFor(entity, f, value, idPrefix) {
    const id = `${idPrefix}-${f.key}`;
    let el;
    let read;
    switch (f.type) {
      case 'multiline':
        el = h('textarea', { id, maxlength: f.max ? String(f.max) : null });
        el.value = typeof value === 'string' ? value : '';
        read = () => el.value;
        break;
      case 'list':
        el = h('textarea', { id, placeholder: '一行一項' });
        el.value = Array.isArray(value) ? value.filter((x) => typeof x === 'string').join('\n') : '';
        read = () => el.value.split('\n').map((x) => x.trim()).filter(Boolean);
        break;
      case 'number':
      case 'integer':
        el = h('input', { type: 'number', id, step: f.type === 'integer' ? '1' : 'any', min: f.min !== undefined ? String(f.min) : null, max: f.max !== undefined ? String(f.max) : null, inputmode: 'decimal' });
        el.value = typeof value === 'number' ? String(value) : '';
        read = () => (el.value.trim() === '' ? null : Number(el.value));
        break;
      case 'bool':
        el = h('input', { type: 'checkbox', id, checked: value === true });
        read = () => el.checked;
        break;
      case 'time':
        el = h('input', { type: 'datetime-local', id, step: '60' });
        el.value = typeof value === 'number' ? localInputValue(appleMs(value)) : '';
        read = () => (el.value ? msToAppleSeconds(new Date(el.value).getTime()) : null);
        break;
      case 'date':
        el = h('input', { type: 'date', id });
        el.value = typeof value === 'number' ? localInputValue(appleMs(value)).slice(0, 10) : '';
        read = () => (el.value ? msToAppleSeconds(dayStartMs(el.value)) : null);
        break;
      case 'enum': {
        const values = (f.values || []).filter(([v]) => !(entity === 'workOrder' && f.key === 'status' && v === 'completed' && value !== 'completed'));
        el = h('select', { id }, values.map(([v, label]) => h('option', { value: v, selected: v === value, text: label })),
          value !== undefined && value !== null && !values.some(([v]) => v === value) ? h('option', { value: String(value), selected: true, text: `${value}（原值）` }) : null);
        read = () => el.value;
        break;
      }
      case 'plate':
        el = h('select', { id }, (state.vehicles || []).filter((v) => v.payload).map((v) => h('option', { value: v.payload.plateNumber, selected: v.payload.plateNumber === value, text: v.payload.plateNumber })),
          value && !vehicleByPlate(value) ? h('option', { value, selected: true, text: `${value}（車輛已不存在）` }) : null);
        read = () => el.value;
        break;
      case 'driverRef':
        el = h('select', { id }, h('option', { value: '', text: '（不指定）', disabled: true, selected: !value }),
          (state.drivers || []).filter((d) => d.payload).map((d) => h('option', { value: d.id, selected: d.id === String(value || '').toUpperCase(), text: d.payload.name })));
        read = () => el.value || null;
        break;
      default:
        el = h('input', { type: 'text', id, maxlength: f.max ? String(f.max) : null });
        el.value = typeof value === 'string' ? value : '';
        read = () => el.value;
    }
    const err = h('span', { class: 'error', id: id + '-err', role: 'alert' });
    el.setAttribute('aria-describedby', id + '-err');
    // 有沒有修改：比較輸入元件本身的狀態（時間欄位只到分鐘，不能拿換算後的值與原值比）
    const snapshot = () => (el.type === 'checkbox' ? String(el.checked) : el.value);
    const original = snapshot();
    const dirty = () => snapshot() !== original;
    const label = h('label', { for: id, text: f.label + (f.unit ? `（${f.unit}）` : '') });
    const node = f.type === 'bool'
      ? h('div', { class: 'field' }, h('label', { class: 'check', for: id }, el, h('span', { text: f.label })), err)
      : h('div', { class: 'field' }, label, el, f.hint ? h('span', { class: 'hint', text: f.hint }) : null, err);
    return { key: f.key, el, read, err, node, initial: value, dirty };
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  function localInputValue(ms) {
    if (ms === null) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const msToAppleSeconds = (ms) => ms / 1000 - APPLE_EPOCH;

  /** 修改（mode：edit）或回車（complete）：填寫 → 預覽差異（主機檢查）→ 填原因 → 確認儲存。 */
  async function editDialog(entity, rec, mode) {
    await Promise.all([ensureVehicles(), ensureDrivers()]);
    const p = rec.payload;
    let fields = fieldsOf(entity).filter((f) => f.edit);
    if (entity === 'trip') {
      fields = fields.filter((f) => f.key !== 'isCompleted');
      if (mode === 'complete') fields = fields.filter((f) => ['endTime', 'odometerEnd', 'destinations', 'fuelType', 'fuelAmount', 'fuelCost', 'tollCost', 'parkingCost', 'didSwapBattery'].includes(f.key));
      else if (p.isCompleted !== true) fields = fields.filter((f) => f.key !== 'endTime' && f.key !== 'odometerEnd');
    }
    const prefix = 'edit';
    const inputs = fields.map((f) => {
      let v = p[f.key];
      if (mode === 'complete' && f.key === 'endTime') v = msToAppleSeconds(Date.now());
      if (mode === 'complete' && f.key === 'odometerEnd') v = undefined;
      return inputFor(entity, f, v, prefix);
    });
    const status = h('div');
    const preview = h('div');
    const reason = reasonField('edit-reason');
    reason.node.hidden = true;
    const previewBtn = h('button', { class: 'btn', type: 'submit', text: '預覽變更' });
    const saveBtn = h('button', { class: 'btn', type: 'button', text: '確認儲存', hidden: true });
    const cancel = h('button', { class: 'btn ghost', type: 'button', text: '取消', onclick: closeDialog });
    const form = h('form', { class: 'stack', novalidate: true }, h('div', { class: 'grid2' }, inputs.map((i) => i.node)), status, preview, reason.node,
      h('div', { class: 'row end' }, cancel, previewBtn, saveBtn));
    showDialog(mode === 'complete' ? `回車：${titleOf(entity, p)}` : `修改${ENTITY[entity]}：${titleOf(entity, p)}`,
      h('p', { class: 'muted small', text: `以版本 ${rec.revision} 修改。送出前主機會再檢查一次；期間被其他裝置改過時會請你重新載入。` }), form);

    const changes = () => {
      const out = {};
      for (const i of inputs) {
        const v = i.read();
        if (mode === 'complete' && ['endTime', 'odometerEnd', 'destinations'].includes(i.key)) {
          out[i.key] = v;
          continue;
        }
        if (i.dirty()) out[i.key] = v;
      }
      if (mode === 'complete') out.isCompleted = true;
      return out;
    };
    const clearErrors = () => inputs.forEach((i) => {
      i.err.textContent = '';
      i.el.removeAttribute('aria-invalid');
    });
    const showErrors = (fields) => {
      let first = null;
      for (const [k, msg] of Object.entries(fields || {})) {
        const i = inputs.find((x) => x.key === k);
        if (i) {
          i.err.textContent = msg;
          i.el.setAttribute('aria-invalid', 'true');
          first = first || i.el;
        } else {
          status.append(banner('error', k === '_' ? msg : `${k}：${msg}`));
        }
      }
      if (first) first.focus();
    };
    let pending = null;
    form.addEventListener('input', (ev) => {
      if (ev.target === reason.input) return;
      // 內容改了就要重新預覽
      pending = null;
      saveBtn.hidden = true;
      reason.node.hidden = true;
      previewBtn.hidden = false;
      clear(preview);
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      clearErrors();
      clear(status);
      clear(preview);
      const body = changes();
      if (Object.keys(body).length === 0) {
        status.append(banner('info', '沒有修改任何欄位。'));
        return;
      }
      for (const i of inputs) {
        if (i.el.validity && !i.el.validity.valid) {
          i.err.textContent = i.el.validationMessage;
          i.el.setAttribute('aria-invalid', 'true');
          i.el.focus();
          return;
        }
      }
      previewBtn.disabled = true;
      try {
        const r = await call('PATCH', `admin/records/${entity}/${encodeURIComponent(rec.id)}`, { expectedRevision: rec.revision, changes: body, dryRun: true });
        pending = body;
        preview.append(h('p', { class: 'small', text: '主機檢查通過，以下是會寫入的變更：' }),
          diffTable(entity, r.before, r.after, r.changedFields, ['修改前', '修改後']),
          (r.warnings || []).map((w) => banner('warn', w)));
        reason.node.hidden = false;
        previewBtn.hidden = true;
        saveBtn.hidden = false;
        reason.input.focus();
      } catch (e) {
        if (e.status === 401) return;
        if (e.code === 'invalid_changes') showErrors(e.data && e.data.fields);
        else if (e.code === 'revision_mismatch') conflictBanner(status, entity, rec);
        else status.append(banner('error', e.message));
      }
      previewBtn.disabled = false;
    });
    saveBtn.addEventListener('click', async () => {
      if (!pending) return;
      const why = reason.input.value.trim();
      if (!why) {
        reason.input.setAttribute('aria-invalid', 'true');
        reason.input.focus();
        toast('請填寫原因。');
        return;
      }
      saveBtn.disabled = true;
      try {
        await call('PATCH', `admin/records/${entity}/${encodeURIComponent(rec.id)}`, { expectedRevision: rec.revision, changes: pending, reason: why });
        closeDialog();
        invalidate();
        toast(mode === 'complete' ? '已回車' : '已儲存', 'ok');
        renderRoute();
        return;
      } catch (e) {
        if (e.status === 401) return;
        if (e.code === 'invalid_changes') showErrors(e.data && e.data.fields);
        else if (e.code === 'revision_mismatch') conflictBanner(status, entity, rec);
        else status.append(banner('error', e.message));
      }
      saveBtn.disabled = false;
    });
  }

  function conflictBanner(host, entity, rec) {
    clear(host).append(banner('error', '這筆資料已被其他裝置修改',
      '你看到的是舊的版本。請重新載入，確認最新的內容後再修改（你在這裡輸入的內容不會保留）。',
      h('button', { class: 'btn small', type: 'button', text: '重新載入', onclick: () => { closeDialog(); renderRoute(); } })));
    void entity;
    void rec;
  }

  /** 刪除：影響預覽 → 輸入確認文字與原因 → 刪除。 */
  async function deleteDialog(entity, rec) {
    const p = rec.payload;
    let impact;
    try {
      impact = await call('GET', `admin/records/${entity}/${encodeURIComponent(rec.id)}/impact`);
    } catch (e) {
      if (e.status !== 401) toast(e.message);
      return;
    }
    const cascade = Object.entries(impact.cascade || {}).filter(([, n]) => n > 0);
    const refs = Object.entries(impact.references || {}).filter(([, n]) => n > 0);
    const blocked = impact.blockers.length > 0;
    const confirmText = entity === 'vehicle' ? p.plateNumber : '刪除';
    const typed = h('input', { type: 'text', id: 'del-confirm', autocomplete: 'off' });
    const reason = reasonField('del-reason');
    const status = h('div');
    const go = h('button', { class: 'btn danger', type: 'button', text: '永久刪除', disabled: true });
    typed.addEventListener('input', () => {
      go.disabled = blocked || typed.value.trim() !== confirmText;
    });
    const REF_LABEL = { trips: '車趟（保留駕駛姓名，不會刪除）', devices: '綁定的裝置（綁定不會自動解除）', workOrders: '引用這個零件的工單' };
    showDialog(`刪除${ENTITY[entity]}：${titleOf(entity, p)}`,
      blocked ? impact.blockers.map((b) => banner('error', `不能刪除：${b.message}`, `${b.count} 筆`)) : null,
      banner('warn', '刪除是永久的', 'App 同步後也會刪除這筆資料；修改前後歷史會保留刪除前的內容。'),
      cascade.length ? h('div', null, h('p', { text: '會一併刪除：' }),
        h('ul', null, cascade.map(([k, n]) => h('li', { text: `${ENTITY[k] || k} ${n} 筆` })))) : null,
      refs.length ? h('div', null, h('p', { text: '引用這筆資料的：' }), h('ul', null, refs.map(([k, n]) => h('li', { text: `${REF_LABEL[k] || k} ${n} 筆` })))) : null,
      blocked ? null : h('div', { class: 'field' }, h('label', { for: 'del-confirm', text: `請輸入「${confirmText}」確認` }), typed),
      blocked ? null : reason.node,
      status,
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost', type: 'button', text: '取消', onclick: closeDialog }), blocked ? null : go));
    go.addEventListener('click', async () => {
      const why = reason.input.value.trim();
      if (!why) {
        reason.input.focus();
        toast('請填寫原因。');
        return;
      }
      go.disabled = true;
      try {
        await call('POST', `admin/records/${entity}/${encodeURIComponent(rec.id)}/delete`, { expectedRevision: rec.revision, reason: why, expectedCascade: impact.cascade });
        closeDialog();
        invalidate();
        toast('已刪除', 'ok');
        navigate('#' + (ENTITY_ROUTE[entity] || 'overview'));
        return;
      } catch (e) {
        if (e.status === 401) return;
        if (e.code === 'impact_changed') clear(status).append(banner('error', '影響範圍已經改變', '預覽之後又有新的資料，請關閉後重新刪除以查看最新的影響。'));
        else if (e.code === 'revision_mismatch') conflictBanner(status, entity, rec);
        else clear(status).append(banner('error', e.message));
      }
      go.disabled = false;
    });
  }

  /** 用車申請：核准（可指派駕駛人）或退回（填原因）。 */
  async function decideDialog(rec, action) {
    await ensureDrivers();
    const p = rec.payload;
    const status = h('div');
    const driver = h('select', { id: 'dec-driver' }, h('option', { value: '', text: '（不指派，以申請人姓名出車）' }),
      (state.drivers || []).filter((d) => d.payload).map((d) => h('option', { value: d.id, selected: d.payload.name === p.requestedBy, text: d.payload.name })));
    const note = h('input', { type: 'text', id: 'dec-note', maxlength: '500' });
    const why = h('input', { type: 'text', id: 'dec-why', maxlength: '500' });
    const go = h('button', { class: action === 'approve' ? 'btn' : 'btn danger', type: 'button', text: action === 'approve' ? '核准並建立車趟' : '退回' });
    showDialog(`${action === 'approve' ? '核准' : '退回'}用車申請：${titleOf('tripRequest', p)}`,
      h('dl', { class: 'facts' },
        h('dt', { text: '申請人' }), h('dd', { text: text(p.requestedBy) }),
        h('dt', { text: '預計時間' }), h('dd', { text: `${fmtTime(appleMs(p.plannedStartTime))} → ${fmtTime(appleMs(p.plannedEndTime))}` }),
        h('dt', { text: '車輛' }), h('dd', { text: text(p.vehiclePlateNumber) }),
        h('dt', { text: '路線' }), h('dd', { text: routeText(p) })),
      action === 'approve'
        ? [h('p', { class: 'muted small', text: '核准後主機建立一趟出車中的車趟（與 App 的核准相同），起始里程取同一台車最後一趟的結束里程。' }),
          h('div', { class: 'field' }, h('label', { for: 'dec-driver', text: '指派駕駛人' }), driver),
          h('div', { class: 'field' }, h('label', { for: 'dec-note', text: '備註（選填，寫進修改前後歷史）' }), note)]
        : h('div', { class: 'field' }, h('label', { for: 'dec-why', text: '退回原因（申請人會看到）' }), why),
      status,
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost', type: 'button', text: '取消', onclick: closeDialog }), go));
    go.addEventListener('click', async () => {
      const body = { expectedRevision: rec.revision };
      if (action === 'approve') {
        if (driver.value) body.driverId = driver.value;
        if (note.value.trim()) body.note = note.value.trim();
      } else {
        if (!why.value.trim()) {
          why.focus();
          toast('請填寫退回原因。');
          return;
        }
        body.rejectionReason = why.value.trim();
      }
      go.disabled = true;
      try {
        const r = await call('POST', `admin/requests/${encodeURIComponent(rec.id)}/${action}`, body);
        closeDialog();
        toast(action === 'approve' ? '已核准，已建立車趟' : '已退回', 'ok');
        refreshPendingBadge();
        if (r.trip) navigate(`#r/trip/${encodeURIComponent(r.trip.id)}`);
        else renderRoute();
        return;
      } catch (e) {
        if (e.status === 401) return;
        if (e.code === 'revision_mismatch') conflictBanner(status, 'tripRequest', rec);
        else clear(status).append(banner('error', e.code === 'request_not_pending' ? '這筆申請已經處理過了，請重新載入。' : e.message));
      }
      go.disabled = false;
    });
  }

  // ───────── 總覽 ─────────

  async function viewOverview(panel) {
    const count = async (q) => (await call('GET', 'admin/records?limit=1&' + q)).total;
    const [devices, codes, loc, vehicles, drivers, active, pending, recent, pendingList, activeList] = await Promise.all([
      ensureDevices(true), loadCodes(), call('GET', 'locations'), count('entity=vehicle'), count('entity=driver'),
      count('entity=trip&status=active'), count('entity=tripRequest&status=pending'), call('GET', 'admin/history?limit=8'),
      call('GET', 'admin/records?entity=tripRequest&status=pending&limit=5&sort=time&order=asc'),
      call('GET', 'admin/records?entity=trip&status=active&limit=5'),
    ]);
    const live = devices.filter(isActive);
    const admins = live.filter((d) => d.role === 'admin');
    const fresh = loc.locations.filter((l) => !l.stale);
    const parts = [];
    const web = state.me.web;
    if (web && web.remember && web.sessionUntil - Date.now() < 3 * 86400000) {
      parts.push(banner('warn', `這個瀏覽器的登入將在 ${fmtTime(web.sessionUntil)} 到期`,
        '到期後要用新的管理員配對碼重新登入。請先在「配對碼」建立管理員配對碼，或確認手機或平板的 App 也是管理員。'));
    }
    if (admins.length === 1 && admins[0].deviceId === state.me.deviceId) {
      parts.push(banner('warn', '目前只有這個瀏覽器是管理員',
        '建議建立一組「管理員」配對碼，讓你的手機或平板也成為管理員；這個瀏覽器的登入資料被清除時才不會失去管理權限。',
        h('button', { class: 'btn small', type: 'button', text: '建立管理員配對碼', onclick: () => { state.codePreset = 'admin'; navigate('#codes'); } })));
    }
    const stat = (k, v, href) => h(href ? 'a' : 'div', { class: 'stat', href: href || null, style: href ? 'text-decoration:none;color:inherit' : null },
      h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) }));
    parts.push(h('div', { class: 'stats' },
      stat('已配對裝置', live.length, '#devices'), stat('管理員', admins.length, '#devices'), stat('車輛', vehicles, '#vehicles'),
      stat('駕駛人', drivers, '#drivers'), stat('出車中', active, '#trips?status=active'), stat('待簽核申請', pending, '#requests?status=pending'),
      stat('有效配對碼', codes.length, '#codes'), stat('即時位置', fresh.length, '#locations')));
    const reqRows = pendingList.records.map((r) => h('tr', { class: 'link', onclick: () => navigate(`#r/tripRequest/${encodeURIComponent(r.id)}`) },
      h('td', null, recordLink('tripRequest', r.id, text(r.payload.requestedBy))), h('td', { class: 'num', text: fmtTime(appleMs(r.payload.plannedStartTime)) }),
      h('td', { class: 'nowrap', text: text(r.payload.vehiclePlateNumber) }), h('td', { class: 'clip opt', text: routeText(r.payload) })));
    parts.push(card('待簽核的用車申請', null, table(['申請人', '預計出發', '車牌', '路線'], reqRows, '目前沒有待簽核的申請。'),
      pending > 5 ? h('div', { class: 'row end' }, h('a', { href: '#requests?status=pending', class: 'small', text: `查看全部 ${pending} 筆` })) : null));
    const tripRows = activeList.records.map((r) => h('tr', { class: 'link', onclick: () => navigate(`#r/trip/${encodeURIComponent(r.id)}`) },
      h('td', null, recordLink('trip', r.id, text(r.payload.vehiclePlateNumber))), h('td', { text: text(r.payload.driver) }),
      h('td', { class: 'nowrap', text: fmtAgo(appleMs(r.payload.startTime)) }), h('td', { class: 'clip opt', text: routeText(r.payload) })));
    parts.push(card('出車中', null, table(['車牌', '駕駛', '出車', '路線'], tripRows, '目前沒有出車中的車趟。')));
    const histHost = h('ul', { class: 'timeline' }, recent.entries.map((e) => historyItem(e, false)));
    parts.push(card('最近的修改', null, recent.entries.length ? histHost : h('p', { class: 'muted', text: '還沒有修改前後歷史。' }),
      h('div', { class: 'row end' }, h('a', { href: '#history', class: 'small', text: '查看全部修改歷史' }))));
    const info = state.info;
    parts.push(card('主機', null, h('dl', { class: 'facts' },
      h('dt', { text: '名稱' }), h('dd', { text: info.name }),
      h('dt', { text: '主機 ID' }), h('dd', { class: 'mono', text: info.serverId }),
      h('dt', { text: '部署方式' }), h('dd', { text: VARIANT[info.variant] || info.variant }),
      h('dt', { text: '主機版本' }), h('dd', { class: 'mono', text: `${info.serverVersion}（API v${info.apiVersion}、資料表版本 ${info.schemaVersion ?? '—'}）` }),
      h('dt', { text: 'App 輸入的主機網址' }), h('dd', { class: 'mono', text: location.origin + BASE }))));
    clear(panel).append(...parts);
  }

  // ───────── 裝置 ─────────

  async function viewDevices(panel) {
    const [devices] = await Promise.all([ensureDevices(true), ensureDrivers()]);
    const drivers = (state.drivers || []).filter((d) => d.payload).map((d) => ({ uuid: d.id, name: d.payload.name }));
    const shown = devices
      .filter((d) => state.showRevoked || d.revokedAt === null)
      .sort((a, b) => (isActive(b) - isActive(a)) || ((b.lastSeenAt || 0) - (a.lastSeenAt || 0)));
    const rows = shown.map((d) => {
      const mine = d.deviceId === state.me.deviceId;
      const active = isActive(d);
      const roleSel = h('select', { class: 'inline', 'aria-label': `${d.name} 的角色`, disabled: !active || mine },
        Object.entries(ROLE).map(([v, label]) => h('option', { value: v, selected: d.role === v, text: label })));
      const bindSel = h('select', { class: 'inline', 'aria-label': `${d.name} 綁定的駕駛人`, disabled: !active || d.role !== 'driver' },
        h('option', { value: '', text: '不綁定' }),
        drivers.map((x) => h('option', { value: x.uuid, selected: d.driverBinding && d.driverBinding.driverUuid === x.uuid, text: x.name })),
        d.driverBinding && !drivers.some((x) => x.uuid === d.driverBinding.driverUuid)
          ? h('option', { value: d.driverBinding.driverUuid, selected: true, text: `${d.driverBinding.driverName}（已不在駕駛人清單）` }) : null);
      roleSel.addEventListener('change', () => {
        if (roleSel.value === 'admin' && !window.confirm(`要把「${d.name}」設為管理員嗎？管理員可以讀寫全部資料、管理裝置與配對碼。`)) {
          roleSel.value = d.role;
          return;
        }
        patchDevice(d, { role: roleSel.value });
      });
      bindSel.addEventListener('change', () => {
        const x = drivers.find((v) => v.uuid === bindSel.value);
        patchDevice(d, { driverBinding: x ? { driverUuid: x.uuid, driverName: x.name } : null });
      });
      const statusChip = d.revokedAt !== null ? h('span', { class: 'chip', text: '已解除配對' })
        : active ? h('span', { class: 'chip ok', text: '使用中' }) : h('span', { class: 'chip warn', text: '權杖已過期' });
      const bound = d.driverBinding && driverById(d.driverBinding.driverUuid);
      const webLogin = d.webSession === 'remember' ? '記住瀏覽器' : d.webSession === 'session' ? '不記住瀏覽器'
        : d.platform === 'web' ? '舊的登入方式' : null;
      return h('tr', { class: active ? null : 'dim' },
        h('td', null, h('div', { text: d.name }),
          h('div', { class: 'muted', text: [PLATFORM[d.platform] || d.platform, webLogin, shortId(d.deviceId)].filter(Boolean).join('・') }),
          d.sessionUntil && active ? h('div', { class: 'muted', text: `登入期限 ${fmtTime(d.sessionUntil)}` }) : null,
          mine ? h('span', { class: 'chip accent', text: '這個瀏覽器' }) : null),
        h('td', null, roleSel),
        h('td', null, bindSel, bound ? h('div', null, recordLink('driver', bound.id, '駕駛人資料')) : null),
        h('td', { class: 'nowrap', title: fmtTime(d.lastSeenAt), text: fmtAgo(d.lastSeenAt) }),
        h('td', { class: 'num opt', text: fmtDate(d.pairedAt) }),
        h('td', null, statusChip),
        h('td', null, h('a', { href: hashFor('trips', new URLSearchParams({ deviceId: d.deviceId })), class: 'small', text: '建立的車趟' })),
        h('td', null, d.revokedAt === null && !mine
          ? h('button', { class: 'btn danger small', type: 'button', text: '解除配對', onclick: () => unpairDevice(d) }) : null));
    });
    const toggle = h('input', { type: 'checkbox', id: 'show-revoked', checked: state.showRevoked });
    toggle.addEventListener('change', () => {
      state.showRevoked = toggle.checked;
      renderRoute();
    });
    clear(panel).append(card('裝置', '配對到這台主機的 App 與瀏覽器（主機沒有使用者帳號，角色屬於裝置）。角色與綁定的駕駛人改了之後，該裝置下次同步時生效；解除配對後它就不能再連線，網頁管理的登入也立即失效。「最近連線」App 每小時、網頁管理每 5 分鐘更新一次。',
      h('div', { class: 'row' }, h('label', { class: 'check', for: 'show-revoked' }, toggle, '顯示已解除配對的裝置'), h('span', { class: 'spacer' }), refreshButton()),
      table(['裝置', '角色', '綁定駕駛人', '最近連線', '配對日期', '狀態', '資料', ''], rows, '還沒有配對的裝置。')));
  }

  async function patchDevice(d, body) {
    try {
      await call('PATCH', 'admin/devices/' + encodeURIComponent(d.deviceId), body);
      toast('已更新', 'ok');
    } catch (e) {
      if (e.status === 401) return;
      toast(e.code === 'last_admin' ? '最後一位可以使用的管理員不能降級。' : e.message);
    }
    state.devices = null;
    renderRoute();
  }

  async function unpairDevice(d) {
    if (!window.confirm(`要解除「${d.name}」的配對嗎？那台裝置之後要重新以配對碼加入。`)) return;
    try {
      await call('DELETE', 'admin/devices/' + encodeURIComponent(d.deviceId));
      toast('已解除配對', 'ok');
    } catch (e) {
      if (e.status === 401) return;
      toast(e.code === 'last_admin' ? '最後一位可以使用的管理員不能解除配對。' : e.message);
    }
    state.devices = null;
    renderRoute();
  }

  function refreshButton() {
    return h('button', { class: 'btn ghost small', type: 'button', text: '重新整理', onclick: () => { invalidate(); renderRoute(); } });
  }

  // ───────── 配對碼 ─────────

  const loadCodes = async () => (state.codes = (await call('GET', 'admin/pairing-codes')).codes);

  async function viewCodes(panel) {
    const [codes] = await Promise.all([loadCodes(), ensureDrivers()]);
    const drivers = (state.drivers || []).filter((d) => d.payload).map((d) => ({ uuid: d.id, name: d.payload.name }));
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
      if (role.value === 'admin' && !window.confirm('要建立「管理員」配對碼嗎？用這組碼配對的裝置可以讀寫全部資料、管理裝置與配對碼。')) return;
      submit.disabled = true;
      const x = drivers.find((v) => v.uuid === bind.value);
      const body = { role: role.value, label: label.value.trim(), ttlMinutes: Number(ttl.value) };
      if (role.value === 'driver' && x) body.driverBinding = { driverUuid: x.uuid, driverName: x.name };
      try {
        const r = await call('POST', 'admin/pairing-codes', body);
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

  // ───────── 即時位置 ─────────

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
            h('td', null, recordLink('trip', l.tripUUID, text(l.plateNumber))),
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
      h('div', { class: 'row end' }, refreshButton()), host));
    timers.push(setInterval(() => {
      if (document.visibilityState === 'visible') render().catch(() => {});
    }, 20000));
  }

  // ───────── 報表 ─────────

  const PERIODS = [['thisMonth', '本月'], ['lastMonth', '上個月'], ['last30', '最近 30 天'], ['thisYear', '今年'], ['custom', '自訂']];

  function periodRange(kind, query) {
    const now = new Date();
    const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    switch (kind) {
      case 'lastMonth':
        return [ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 0))];
      case 'last30':
        return [ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), ymd(now)];
      case 'thisYear':
        return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
      case 'custom': {
        const f = query.get('from');
        const t = query.get('to');
        if (f && t && ISO_DATE.test(f) && ISO_DATE.test(t)) return [f, t];
        return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(now)];
      }
      default:
        return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
    }
  }

  async function viewReports(panel, query) {
    await Promise.all([ensureVehicles(), ensureDrivers()]);
    const kind = PERIODS.some(([k]) => k === query.get('period')) ? query.get('period') : 'thisMonth';
    const [fromDate, toDate] = periodRange(kind, query);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const params = new URLSearchParams({ from: String(dayStartMs(fromDate)), to: String(dayStartMs(toDate, 1)), tz });
    for (const k of ['plate', 'driverId', 'costCenter']) {
      const v = query.get(k);
      if (v !== null && (v !== '' || k === 'costCenter' && query.has('cc'))) params.set(k, v);
    }
    const s = await call('GET', 'admin/reports/summary?' + params);

    const go = (changes) => {
      const q = new URLSearchParams(query);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === undefined || v === '') q.delete(k);
        else q.set(k, String(v));
      }
      navigate(hashFor('reports', q));
    };
    const periodSel = h('select', { id: 'r-period' }, PERIODS.map(([k, label]) => h('option', { value: k, selected: k === kind, text: label })));
    const fromInput = h('input', { type: 'date', id: 'r-from', value: fromDate });
    const toInput = h('input', { type: 'date', id: 'r-to', value: toDate });
    const plateSel = h('select', { id: 'r-plate' }, h('option', { value: '', text: '全部車輛' }),
      (state.vehicles || []).filter((v) => v.payload).map((v) => h('option', { value: v.payload.plateNumber, selected: query.get('plate') === v.payload.plateNumber, text: v.payload.plateNumber })));
    const driverSel = h('select', { id: 'r-driver' }, h('option', { value: '', text: '全部駕駛人' }),
      (state.drivers || []).filter((d) => d.payload).map((d) => h('option', { value: d.id, selected: query.get('driverId') === d.id, text: d.payload.name })));
    const customFields = [h('div', { class: 'field' }, h('label', { for: 'r-from', text: '從' }), fromInput), h('div', { class: 'field' }, h('label', { for: 'r-to', text: '到' }), toInput)];
    const syncCustom = () => customFields.forEach((f) => { f.hidden = periodSel.value !== 'custom'; });
    periodSel.addEventListener('change', syncCustom);
    syncCustom();
    const form = h('form', { class: 'filters' },
      h('div', { class: 'field' }, h('label', { for: 'r-period', text: '期間' }), periodSel), customFields,
      h('div', { class: 'field' }, h('label', { for: 'r-plate', text: '車輛' }), plateSel),
      h('div', { class: 'field' }, h('label', { for: 'r-driver', text: '駕駛人' }), driverSel),
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit', text: '產生報表' })));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      go({ period: periodSel.value, from: periodSel.value === 'custom' ? fromInput.value : null, to: periodSel.value === 'custom' ? toInput.value : null,
        plate: plateSel.value, driverId: driverSel.value });
    });

    const x = s.totals;
    const kpi = (k, v, note) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }), note ? h('div', { class: 'muted small', text: note }) : null);
    const kpis = h('div', { class: 'kpis' },
      kpi('車趟', fmtNum(x.trips, 0)), kpi('里程', fmtNum(x.distance, 1) + ' km'), kpi('加油量', fmtNum(x.fuel, 1)),
      kpi('費用合計', fmtNum(x.totalCost, 0), `車趟 ${fmtNum(x.tripCost, 0)}・保養 ${fmtNum(x.maintenanceCost, 0)}・工單 ${fmtNum(x.workOrderCost, 0)}`),
      kpi('每公里成本', x.costPerKm === null ? '—' : fmtNum(x.costPerKm, 2)), kpi('稼動率', x.utilization === null ? '—' : fmtNum(x.utilization, 1) + '%', `${s.period.days} 天`),
      kpi('保養／工單／巡檢', `${x.maintenanceCount}／${x.workOrderCount}／${x.inspectionCount}`, x.inspectionDefects ? `${x.inspectionDefects} 筆巡檢有缺陷` : null));
    const maxDaily = Math.max(1, ...s.daily.map((d) => d.distance));
    const vRows = s.vehicles.filter((v) => v.trips > 0 || v.vehicleId).map((v) => h('tr', null,
      h('td', null, v.vehicleId ? recordLink('vehicle', v.vehicleId, v.plate) : (v.plate || '（未指定車輛）')),
      h('td', { class: 'num', text: fmtNum(v.trips, 0) }), h('td', { class: 'num', text: fmtNum(v.distance, 1) }),
      h('td', { class: 'num', text: fmtNum(v.tripCost, 0) }), h('td', { class: 'num opt', text: fmtNum(v.maintenanceCost + v.workOrderCost, 0) }),
      h('td', { class: 'num', text: v.utilization === null ? '—' : fmtNum(v.utilization, 1) + '%' })));
    const dRows = s.drivers.map((d) => h('tr', null,
      h('td', null, d.driverId ? recordLink('driver', d.driverId, d.name || '（未填）') : (d.name || '（未填）')),
      h('td', { class: 'num', text: fmtNum(d.trips, 0) }), h('td', { class: 'num', text: fmtNum(d.distance, 1) }), h('td', { class: 'num', text: fmtNum(d.tripCost, 0) })));
    const cRows = s.costCenters.map((c) => h('tr', null, h('td', { text: c.costCenter || '（未指定）' }),
      h('td', { class: 'num', text: fmtNum(c.trips, 0) }), h('td', { class: 'num', text: fmtNum(c.distance, 1) }), h('td', { class: 'num', text: fmtNum(c.tripCost, 0) })));
    const dayRows = s.daily.map((d) => h('tr', null, h('td', { class: 'num', text: d.date }), h('td', { class: 'num', text: fmtNum(d.trips, 0) }),
      h('td', { class: 'num', text: fmtNum(d.distance, 1) }), h('td', { class: 'barcell opt' }, h('div', { class: 'bar', style: `width:${Math.round((d.distance / maxDaily) * 100)}%` }))));
    const downloads = h('div', { class: 'row' }, [['trips', '車趟'], ['maintenance', '保養'], ['workOrders', '工單'], ['inspections', '巡檢']].map(([k, label]) =>
      h('button', { class: 'btn ghost small', type: 'button', text: `${label} CSV`, onclick: (ev) => downloadCsv(`admin/reports/export?kind=${k}&${params}`, ev.currentTarget) })));
    clear(panel).append(
      card('報表', `依 App 的報表規則即時計算：只算已回車的車趟、依出車時間落在期間內；日期以這台電腦的時區（${tz}）計算。單趟車趟的內容請看車趟詳情。`, form),
      card(`${s.period.firstDay} 到 ${s.period.lastDay}`, null, kpis, downloads),
      card('依車輛', '車輛使用情況：稼動率是有出車的天數比例。', table(['車輛', '車趟', '里程 (km)', '車趟費用', '保養＋工單', '稼動率'], vRows, '這段期間沒有車趟。')),
      card('依駕駛人', null, table(['駕駛人', '車趟', '里程 (km)', '費用'], dRows, '這段期間沒有車趟。')),
      card('依成本中心', null, table(['成本中心', '車趟', '里程 (km)', '費用'], cRows, '這段期間沒有車趟。')),
      card('每日里程', null, table(['日期', '車趟', '里程 (km)', ''], dayRows, '這段期間沒有車趟。')));
  }

  /** 下載 CSV（以 fetch 取得後存檔，檔名依主機的 Content-Disposition）。 */
  async function downloadCsv(path, button) {
    if (button) button.disabled = true;
    try {
      const res = await fetch(API + path, { headers: { Accept: 'text/csv' }, cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) {
        let msg = `主機回應錯誤（HTTP ${res.status}）`;
        try {
          msg = (await res.json()).error.message || msg;
        } catch {
          /* 不是 JSON */
        }
        if (res.status === 401) expire();
        throw new Error(msg);
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
      let name = 'FleetDispatch.csv';
      try {
        if (m) name = decodeURIComponent(m[1]);
      } catch {
        /* 用預設檔名 */
      }
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      toast(e.message || String(e));
    }
    if (button) button.disabled = false;
  }

  // ───────── 修改歷史與稽核 ─────────

  async function viewHistory(panel, query) {
    const entitySel = h('select', { id: 'h-entity' }, h('option', { value: '', text: '全部' }),
      Object.entries(ENTITY).map(([k, label]) => h('option', { value: k, selected: query.get('entity') === k, text: label })));
    const outcomeSel = h('select', { id: 'h-outcome' }, [['', '全部'], ['applied', '已套用'], ['notApplied', '沒有套用（拒絕、衝突、略過）']]
      .map(([v, label]) => h('option', { value: v, selected: (query.get('outcome') || '') === v, text: label })));
    const sourceSel = h('select', { id: 'h-source' }, h('option', { value: '', text: '全部' }),
      Object.entries(SOURCE).map(([k, label]) => h('option', { value: k, selected: query.get('source') === k, text: label })));
    const form = h('form', { class: 'filters' },
      h('div', { class: 'field' }, h('label', { for: 'h-entity', text: '資料' }), entitySel),
      h('div', { class: 'field' }, h('label', { for: 'h-outcome', text: '結果' }), outcomeSel),
      h('div', { class: 'field' }, h('label', { for: 'h-source', text: '來源' }), sourceSel),
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'submit', text: '套用' })));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const q = new URLSearchParams();
      if (entitySel.value) q.set('entity', entitySel.value);
      if (outcomeSel.value) q.set('outcome', outcomeSel.value);
      if (sourceSel.value) q.set('source', sourceSel.value);
      navigate(hashFor('history', q));
    });
    const host = h('div');
    clear(panel).append(card('修改前後歷史', '主機上每一次寫入的修改前後內容、來源與原因（新的在前）；App 的修改沒有套用時也留下摘要。點一筆的「查看差異」比較內容，資料的詳情頁可以比較任兩個版本。',
      subtabs('history'), form, host));
    await renderHistory(host, { entity: query.get('entity') || null, outcome: query.get('outcome') || null, source: query.get('source') || null }, false);
  }

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
          h('td', { class: 'nowrap', text: auditAction(a) }),
          h('td', null, ENTITY[a.entity] && a.entityId ? recordLink(a.entity, a.entityId, shortId(a.entityId)) : h('span', { class: 'mono', text: shortId(a.entityId) || '—' })),
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
    clear(panel).append(card('稽核紀錄', '誰在什麼時候新增、修改或刪除了哪一筆資料，以及配對、登入、角色、配對碼、主機名稱、查看個資等管理操作（最新的在最上面）。稽核紀錄不含駕駛人的個資、權杖與配對碼。',
      subtabs('audit'),
      h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['時間', '裝置', '動作', '資料', '摘要'].map((t) => h('th', { scope: 'col', text: t })))), tbody)),
      h('div', { class: 'row' }, more)));
  }

  /** 管理操作（1.2.0）的動作名稱。 */
  const ADMIN_ACTION = {
    'device:pair': '配對裝置', 'device:web-login': '登入網頁管理', 'device:web-upgrade': '網頁登入改用 Cookie', 'device:unpair': '自行解除配對（登出）',
    'device:update': '變更裝置的角色或綁定', 'device:revoke': '解除裝置的配對', 'pairingCode:create': '建立配對碼', 'pairingCode:delete': '撤銷配對碼',
    'server:rename': '變更主機名稱',
  };

  function auditAction(a) {
    if (a.operation === 'view-pii') return '查看個資';
    return ADMIN_ACTION[`${a.entity}:${a.operation}`] || `${OPERATION[a.operation] || a.operation}${ENTITY[a.entity] || AUDIT_ENTITY[a.entity] || a.entity}`;
  }

  // ───────── 主機設定 ─────────

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
    const presets = await call('GET', 'admin/records?entity=preset&limit=5');
    const me = state.me;
    const info = state.info;
    clear(panel).append(
      card('主機名稱', null, form),
      card('派車預設值', 'App 出車時帶入的起點、目的地、任務與公司名稱（報表封面）。',
        presets.records.length ? h('ul', null, presets.records.map((r) => h('li', null, recordLink('preset', r.id, titleOf('preset', r.payload)))))
          : h('p', { class: 'muted', text: '還沒有派車預設值（在 App 的設定建立後會同步到這裡）。' })),
      card('主機資訊', null, h('dl', { class: 'facts' },
        h('dt', { text: '主機版本' }), h('dd', { class: 'mono', text: info.serverVersion }),
        h('dt', { text: '資料表版本' }), h('dd', { class: 'mono', text: String(info.schemaVersion ?? '—') }),
        h('dt', { text: '能力' }), h('dd', { class: 'mono', text: (info.features || []).join('、') }),
        h('dt', { text: '部署方式' }), h('dd', { text: VARIANT[info.variant] || info.variant }))),
      card('這個瀏覽器', '這個瀏覽器以管理員的身分配對到主機；登入資料由主機以 HttpOnly Cookie 保存（網頁的程式讀不到）。登出會解除配對。', h('dl', { class: 'facts' },
        h('dt', { text: '名稱' }), h('dd', { text: me.deviceName }),
        h('dt', { text: '裝置 ID' }), h('dd', { class: 'mono', text: me.deviceId }),
        h('dt', { text: '登入方式' }), h('dd', { text: me.web && me.web.remember
          ? '記住這個瀏覽器：30 天沒有使用或登入 90 天後需要重新登入' : '不記住：關閉瀏覽器、閒置 2 小時或登入 12 小時後需要重新登入' }),
        h('dt', { text: '目前有效到' }), h('dd', { text: `${fmtTime(me.tokenExpiresAt)}（使用時延長，最晚到登入期限）` }),
        me.web ? h('dt', { text: '登入期限' }) : null, me.web ? h('dd', { text: fmtTime(me.web.sessionUntil) }) : null),
        h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'button', text: '登出並解除配對', onclick: logout }))),
      card('網頁管理的網址', '首頁不會顯示管理頁面；請記下這個網址（可以加入書籤），不要公開分享。',
        h('p', { class: 'mono', text: location.origin + BASE + ADMIN })));
  }

  const VIEWS = {
    overview: viewOverview, devices: viewDevices, codes: viewCodes, locations: viewLocations, reports: viewReports,
    history: viewHistory, audit: viewAudit, settings: viewSettings,
  };

  boot();
})();
