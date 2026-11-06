// HTTP 處理：路由、驗證、各端點（規格：docs/protocol.md）。只用 Web 標準的 Request／Response，
// Cloudflare Workers 直接使用；Docker 版由 node:http 轉接。

import { auditSummary, changedFields, historyJson } from './admin.ts';
import { AdminApi } from './admin-api.ts';
import { constantTimeEqual, newPairingCode, newToken, normalizePairingCode, sha256Hex } from './crypto.ts';
import type { DeviceRow, SqlDb } from './db.ts';
import { Repo } from './db.ts';
import { authorize, outgoingPayload, parseBinding, scopeFields, validateEvent, visible } from './rules.ts';
import type { DriverBinding, Entity, EventResult, Role, ServerConfig, Session, StoredRecord, SyncEvent } from './types.ts';
import { ApiError, ENTITIES, ROLES, SNAPSHOT_KEYS, VEHICLE_CHILDREN } from './types.ts';
import { badRequest, cleanName, intParam, isObject, msToApple, normalizeUuid, nowMs, num, str } from './util.ts';
import { SERVER_VERSION } from './version.ts';
import { acceptsHtml, adminResponse, homeResponse, isHome, matchAdmin } from './web.ts';
import {
  CSRF_HEADER, WEB_SESSION_LIFETIME, WEB_TOUCH_INTERVAL_MS, clearSessionCookie, crossSite, csrfToken, isJsonContent,
  readSessionCookie, sessionCookie, webExpiry, webSessionKind,
} from './web-session.ts';
import type { WebSessionKind } from './web-session.ts';

export const LIMITS = { maxEventsPerRequest: 500, maxBodyBytes: 5 * 1024 * 1024, maxPayloadBytes: 1024 * 1024 };
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 3600 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const LOCATION_STALE_MS = 300 * 1000;
const LOCATION_TTL_MS = 30 * 60 * 1000;

export interface RequestContext {
  db: SqlDb;
  config: ServerConfig;
  /** 來源 IP（嘗試次數限制用）；無法取得時給空字串。 */
  clientIp: string;
}

const initialized = new WeakMap<SqlDb, Promise<void>>();
const lastPurge = new WeakMap<SqlDb, number>();
/** 已處理事件的保留期間。 */
const PROCESSED_TTL_MS = 30 * 24 * 3600 * 1000;

type ValidEvent = Extract<ReturnType<typeof validateEvent>, { ok: true }>;

/** 事件的 `expectedRevision`（1.2.0，選填）：沒有時 null；不是非負整數時 undefined（拒絕）。 */
function optionalRevision(raw: unknown): number | null | undefined {
  if (!isObject(raw) || raw.expectedRevision === undefined || raw.expectedRevision === null) return null;
  const n = raw.expectedRevision;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** 每個資料庫連線（Worker isolate、Node 程序）只建立一次資料表（CREATE TABLE IF NOT EXISTS）。 */
function ensureInit(repo: Repo, config: ServerConfig): Promise<void> {
  let p = initialized.get(repo.db);
  if (!p) {
    p = repo.init(config.defaultName, nowMs());
    initialized.set(repo.db, p);
    p.catch(() => initialized.delete(repo.db));
  }
  return p;
}

/** 各路徑允許的方法（`*` 是一段任意值）。 */
const ROUTES: [string, string[]][] = [
  ['info', ['GET']],
  ['pair', ['POST']],
  // 1.2.0：網頁管理以 HttpOnly Cookie 登入（docs/protocol.md §13.1）
  ['web/login', ['POST']],
  ['web/upgrade', ['POST']],
  ['session', ['GET']],
  ['unpair', ['POST']],
  ['snapshot', ['GET']],
  ['changes', ['GET']],
  ['events', ['POST']],
  ['locations', ['GET', 'POST']],
  ['admin/devices', ['GET']],
  ['admin/devices/*', ['PATCH', 'DELETE']],
  ['admin/pairing-codes', ['GET', 'POST']],
  ['admin/pairing-codes/*', ['DELETE']],
  ['admin/server', ['PATCH']],
  ['admin/audit', ['GET']],
  ['admin/history', ['GET']],
  // 1.2.0：網頁管理的資料查詢與受控修改（docs/protocol.md §7.2–7.6）
  ['admin/schema', ['GET']],
  ['admin/records', ['GET']],
  ['admin/records/*/*', ['GET', 'PATCH']],
  ['admin/records/*/*/impact', ['GET']],
  ['admin/records/*/*/delete', ['POST']],
  ['admin/requests/*/approve', ['POST']],
  ['admin/requests/*/reject', ['POST']],
  // 1.2.0：報表（docs/reports.md）
  ['admin/reports/summary', ['GET']],
  ['admin/reports/export', ['GET']],
];

function matchRoute(seg: string[]): [string, string[]] | null {
  for (const [pattern, methods] of ROUTES) {
    const parts = pattern.split('/');
    if (parts.length === seg.length && parts.every((p, i) => p === '*' || p === seg[i])) return [pattern, methods];
  }
  return null;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

/** CSV 下載（報表匯出）：檔名同時給 ASCII 版本與 RFC 5987 的 UTF-8 版本。 */
function csvResponse(r: { filename: string; body: string }): Response {
  const ascii = r.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(r.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // RFC 3986 的嚴格編碼（與 PHP 的 rawurlencode 相同）
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.filename).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const noContent = (extra: Record<string, string> = {}): Response =>
  new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });

function errorResponse(e: ApiError): Response {
  const extra: Record<string, string> = {};
  if (e.retryAfter !== undefined) extra['Retry-After'] = String(e.retryAfter);
  return json({ error: { code: e.code, message: e.message, ...(e.details ?? {}) } }, e.status, extra);
}

/** 取 `/api/v1/` 之後的路徑（支援基底路徑與 `/index.php/api/v1/`）。 */
export function apiPath(pathname: string): string | null {
  const i = pathname.indexOf('/api/v1/');
  if (i >= 0) return pathname.slice(i + '/api/v1/'.length).replace(/\/+$/, '');
  if (pathname.endsWith('/api/v1')) return '';
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > LIMITS.maxBodyBytes) throw new ApiError(413, 'payload_too_large', '請求本體超過 5 MB');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > LIMITS.maxBodyBytes) throw new ApiError(413, 'payload_too_large', '請求本體超過 5 MB');
  try {
    const v: unknown = JSON.parse(text);
    if (!isObject(v)) throw badRequest('請求本體必須是 JSON 物件');
    return v;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw badRequest('請求本體不是合法的 JSON');
  }
}

function bindingOf(row: { driver_uuid: string | null; driver_name: string | null }): DriverBinding | null {
  return row.driver_uuid ? { driverUuid: row.driver_uuid, driverName: row.driver_name ?? '' } : null;
}

function deviceJson(d: DeviceRow) {
  return {
    deviceId: d.device_id,
    name: d.name,
    platform: d.platform,
    role: d.role,
    driverBinding: bindingOf(d),
    pairedAt: Number(d.paired_at),
    lastSeenAt: d.last_seen_at === null ? null : Number(d.last_seen_at),
    tokenExpiresAt: d.token_expires_at === null || d.revoked_at !== null ? null : Number(d.token_expires_at),
    revokedAt: d.revoked_at === null ? null : Number(d.revoked_at),
    // 1.2.0：網頁管理的登入（`session` 不記住、`remember` 記住；App 與 1.1 的網頁權杖是 null）與登入期限
    webSession: webSessionKind(d.web_session),
    sessionUntil: webSessionKind(d.web_session) === null || d.session_until === null ? null : Number(d.session_until),
  };
}

/** 網頁登入與轉換（沒有登入 Cookie 的請求）：自訂標頭、同一個來源、JSON 本體。 */
function requireWebRequest(request: Request): void {
  if ((request.headers.get(CSRF_HEADER) ?? '').trim() === '' || crossSite(request)) {
    throw new ApiError(403, 'csrf_failed', '請求來源驗證失敗，請重新整理網頁後再試');
  }
  if (!isJsonContent(request)) throw new ApiError(415, 'unsupported_media_type', '請求本體必須是 JSON（Content-Type: application/json）');
}

export class Api {
  repo: Repo;
  config: ServerConfig;
  ip: string;

  constructor(ctx: RequestContext) {
    this.repo = new Repo(ctx.db);
    this.config = ctx.config;
    this.ip = ctx.clientIp;
  }

  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      // 網頁（不需要資料庫）：管理頁只在設定的管理網址出現；首頁是 App 介紹，瀏覽器開啟找不到的網址也顯示首頁（404）。
      const method = request.method.toUpperCase();
      const path = apiPath(url.pathname);
      if (method === 'GET' || method === 'HEAD') {
        if (this.config.adminPath !== null) {
          const hit = matchAdmin(url.pathname, this.config.adminPath);
          if (hit) return adminResponse(hit.kind, hit.base, this.config.adminPath, method);
        }
        if (path === null && isHome(url.pathname)) return homeResponse(200, method);
        if (path === null && acceptsHtml(request.headers.get('Accept'))) return homeResponse(404, method);
      }
      if (path === null) throw new ApiError(404, 'not_found', '找不到這個端點');
      await ensureInit(this.repo, this.config);
      return await this.route(request, url, path);
    } catch (e) {
      if (e instanceof ApiError) return errorResponse(e);
      // 不洩漏內部細節；部署環境自己的日誌可以看到。
      console.error('[fleetdispatch-server]', e);
      return errorResponse(new ApiError(500, 'server_error', '主機內部錯誤'));
    }
  }

  private async route(request: Request, url: URL, path: string): Promise<Response> {
    const m = request.method.toUpperCase();
    const seg = path.split('/');
    const route = matchRoute(seg);
    if (!route) throw new ApiError(404, 'not_found', '找不到這個端點');
    if (!route[1].includes(m)) throw new ApiError(405, 'method_not_allowed', '不支援這個方法');
    const is = (method: string, pattern: string) => m === method && route[0] === pattern;

    if (is('GET', 'info')) return json(await this.info());
    if (is('POST', 'pair')) return json(await this.pair(await readJson(request)));
    if (is('POST', 'web/login')) {
      requireWebRequest(request);
      return this.webLogin(request, await readJson(request));
    }
    if (is('POST', 'web/upgrade')) {
      requireWebRequest(request);
      return this.webUpgrade(request, await readJson(request));
    }

    // 以下需要權杖（App：Authorization 標頭；網頁管理：登入 Cookie）。
    const session = await this.authenticate(request);

    if (is('GET', 'session')) return json(await this.sessionJson(session));
    if (is('POST', 'unpair')) return this.unpairSelf(request, session);
    if (is('GET', 'snapshot')) return json(await this.snapshot(session));
    if (is('GET', 'changes')) return json(await this.changes(session, url));
    if (is('POST', 'events')) return json(await this.events(session, await readJson(request)));
    if (is('POST', 'locations')) return this.postLocation(session, await readJson(request));
    if (is('GET', 'locations')) return json(await this.locations(session));

    if (seg[0] === 'admin') {
      if (session.role !== 'admin') throw new ApiError(403, 'forbidden', '只有管理員可以使用');
      if (is('GET', 'admin/devices')) return json({ devices: (await this.repo.listDevices()).map(deviceJson) });
      if (is('PATCH', 'admin/devices/*')) return json(await this.patchDevice(seg[2], await readJson(request)));
      if (is('DELETE', 'admin/devices/*')) return this.deleteDevice(seg[2]);
      if (is('POST', 'admin/pairing-codes')) return json(await this.createCode(session, await readJson(request)));
      if (is('GET', 'admin/pairing-codes')) return json(await this.listCodes());
      if (is('DELETE', 'admin/pairing-codes/*')) return this.deleteCode(seg[2]);
      if (is('PATCH', 'admin/server')) return json(await this.rename(await readJson(request)));
      if (is('GET', 'admin/audit')) return json(await this.audit(url));
      if (is('GET', 'admin/history')) return json(await this.history(session, url));
      const admin = new AdminApi(this.repo, session);
      if (is('GET', 'admin/schema')) return json(admin.schema());
      if (is('GET', 'admin/records')) return json(await admin.list(url));
      if (is('GET', 'admin/records/*/*')) return json(await admin.detail(seg[2], seg[3]));
      if (is('PATCH', 'admin/records/*/*')) return json(await admin.edit(seg[2], seg[3], await readJson(request)));
      if (is('GET', 'admin/records/*/*/impact')) return json(await admin.impact(seg[2], seg[3]));
      if (is('POST', 'admin/records/*/*/delete')) return json(await admin.remove(seg[2], seg[3], await readJson(request)));
      if (is('POST', 'admin/requests/*/approve')) return json(await admin.decide(seg[2], 'approve', await readJson(request)));
      if (is('POST', 'admin/requests/*/reject')) return json(await admin.decide(seg[2], 'reject', await readJson(request)));
      if (is('GET', 'admin/reports/summary')) return json(await admin.reportSummary(url));
      if (is('GET', 'admin/reports/export')) return csvResponse(await admin.reportExport(url));
    }
    throw new ApiError(404, 'not_found', '找不到這個端點');
  }

  // ───────── 公開端點 ─────────

  async info() {
    const meta = await this.repo.meta();
    return {
      product: 'FleetDispatch Server',
      apiVersion: 1,
      serverVersion: SERVER_VERSION,
      variant: this.config.variant,
      serverId: meta.serverId,
      name: meta.name,
      time: nowMs(),
      setupRequired: (await this.repo.countActiveAdmins(nowMs())) === 0,
      setupConfigured: this.config.setupToken !== null,
      // 1.2.0：idempotency（重送同一個事件回傳第一次的結果）、revision（每筆資料的版本、expectedRevision 與 conflict）、
      // history（修改前後歷史）、webSession（網頁管理以 Cookie 登入）。舊版 App 不使用這些能力，照舊運作。
      features: ['liveLocations', 'audit', 'idempotency', 'revision', 'history', 'webSession'],
      schemaVersion: await this.repo.schemaVersion(),
      limits: { maxEventsPerRequest: LIMITS.maxEventsPerRequest, maxBodyBytes: LIMITS.maxBodyBytes },
    };
  }

  private async serverJson() {
    const meta = await this.repo.meta();
    return { id: meta.serverId, name: meta.name, time: nowMs() };
  }

  async pair(body: Record<string, unknown>) {
    const code = str(body.code);
    const deviceId = normalizeUuid(body.deviceId);
    const deviceName = cleanName(body.deviceName, 100);
    const platform = typeof body.platform === 'string' ? body.platform.trim().slice(0, 20) : '';
    if (!code || !deviceId || !deviceName) throw badRequest('需要 code、deviceId（UUID）與 deviceName');

    const now = nowMs();
    const grant = await this.checkCode(code, now);
    const existing = await this.repo.deviceById(deviceId);
    if (existing && existing.revoked_at === null && existing.token_hash !== null && Number(existing.token_expires_at ?? 0) > now) {
      throw new ApiError(409, 'device_conflict', '這台裝置已經配對；請由管理員先解除配對');
    }

    const token = newToken();
    const expiresAt = now + TOKEN_TTL_MS;
    const ok = await this.repo.pairDevice(
      { id: deviceId, name: deviceName, platform, role: grant.role, binding: grant.binding, tokenHash: await sha256Hex(token), expiresAt },
      now,
      grant.codeHash,
    );
    if (!ok) return this.failCode(now);
    return { token, deviceId, role: grant.role, driverBinding: grant.binding, server: await this.serverJson(), tokenExpiresAt: expiresAt };
  }

  /**
   * 檢查配對碼或設定碼（配對與網頁登入共用）：嘗試次數限制、沒有可以使用的管理員時比對設定碼、否則找可以使用的配對碼。
   * 錯誤時記一次失敗並回 401（還沒有用掉配對碼）。
   */
  private async checkCode(code: string, now: number): Promise<{ role: Role; binding: DriverBinding | null; codeHash: string | null }> {
    const f = await this.repo.failures(this.ip, now - ATTEMPT_WINDOW_MS);
    if (f.count >= MAX_FAILURES) {
      const retry = Math.max(1, Math.ceil(((f.oldest ?? now) + ATTEMPT_WINDOW_MS - now) / 1000));
      throw new ApiError(429, 'rate_limited', '嘗試太多次，請稍後再試', retry);
    }
    if ((await this.repo.countActiveAdmins(now)) === 0) {
      if (this.config.setupToken === null) throw new ApiError(409, 'setup_not_configured', '主機尚未設定設定碼（請依部署文件設定 FD_SETUP_TOKEN）');
      if (!constantTimeEqual(code.trim(), this.config.setupToken)) return this.failCode(now);
      return { role: 'admin', binding: null, codeHash: null };
    }
    const codeHash = await sha256Hex(normalizePairingCode(code));
    const row = await this.repo.findUsableCode(codeHash, now);
    if (!row) return this.failCode(now);
    return { role: row.role, binding: row.role === 'driver' ? bindingOf(row) : null, codeHash };
  }

  private async failCode(now: number): Promise<never> {
    await this.repo.recordFailure(this.ip, now);
    throw new ApiError(401, 'invalid_code', '配對碼錯誤、已使用或已過期');
  }

  // ───────── 網頁管理的登入（1.2.0） ─────────

  /**
   * 網頁管理登入：以管理員的配對碼（或沒有可以使用的管理員時的設定碼）建立一個網頁裝置，權杖只放在 HttpOnly Cookie。
   * 不是管理員的配對碼回 403 admin_only，配對碼不會被用掉。
   */
  private async webLogin(request: Request, body: Record<string, unknown>): Promise<Response> {
    const code = str(body.code);
    const deviceName = cleanName(body.deviceName, 100);
    if (!code || !deviceName) throw badRequest('需要 code 與 deviceName');
    if (body.remember !== undefined && typeof body.remember !== 'boolean') throw badRequest('remember 必須是 true 或 false');
    const kind: WebSessionKind = body.remember === true ? 'remember' : 'session';

    const now = nowMs();
    const grant = await this.checkCode(code, now);
    if (grant.role !== 'admin') throw new ApiError(403, 'admin_only', '網頁管理只能用「管理員」的配對碼登入');
    const deviceId = crypto.randomUUID().toUpperCase();
    const token = newToken();
    const until = now + WEB_SESSION_LIFETIME[kind].maxMs;
    const expiresAt = webExpiry(kind, now, until);
    const ok = await this.repo.pairDevice(
      { id: deviceId, name: deviceName, platform: 'web', role: 'admin', binding: null, tokenHash: await sha256Hex(token), expiresAt, web: { kind, until } },
      now,
      grant.codeHash,
    );
    if (!ok) return this.failCode(now);
    return this.webSessionResponse(request, token, deviceId, kind, until, now);
  }

  /**
   * 1.1 的網頁登入（瀏覽器保存的權杖，以 Authorization 標頭送來）換成 Cookie：同一台網頁裝置換新權杖，舊權杖立即失效。
   * 只接受網頁（platform 是 web）且還沒有轉換的權杖；App 的權杖回 403 not_web_session。
   */
  private async webUpgrade(request: Request, body: Record<string, unknown>): Promise<Response> {
    if (body.remember !== undefined && typeof body.remember !== 'boolean') throw badRequest('remember 必須是 true 或 false');
    const kind: WebSessionKind = body.remember === true ? 'remember' : 'session';
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec((request.headers.get('Authorization') ?? '').trim());
    if (!match) throw new ApiError(401, 'unauthorized', '需要權杖');
    const oldHash = await sha256Hex(match[1]);
    const device = await this.repo.deviceByTokenHash(oldHash);
    const now = nowMs();
    if (!device || device.token_expires_at === null || Number(device.token_expires_at) <= now || !device.identity
      || webSessionKind(device.web_session) !== null) {
      throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新登入');
    }
    if (device.platform !== 'web') throw new ApiError(403, 'not_web_session', '只有網頁管理的登入可以轉換');
    const token = newToken();
    const until = now + WEB_SESSION_LIFETIME[kind].maxMs;
    const expiresAt = webExpiry(kind, now, until);
    if (!(await this.repo.upgradeWebSession(device.device_id, oldHash, { tokenHash: await sha256Hex(token), kind, until, expiresAt }, now))) {
      throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新登入');
    }
    return this.webSessionResponse(request, token, device.device_id, kind, until, now);
  }

  /** 網頁登入成功：回應不含權杖（只在 Set-Cookie），附上這次登入的資訊與 CSRF 權杖。 */
  private async webSessionResponse(request: Request, token: string, deviceId: string, kind: WebSessionKind, until: number, now: number) {
    const device = (await this.repo.deviceById(deviceId))!;
    const role = (ROLES as readonly string[]).includes(device.role) ? device.role : 'viewer';
    const session: Session = {
      deviceId,
      identity: device.identity ?? '',
      deviceName: device.name,
      role,
      binding: role === 'driver' ? bindingOf(device) : null,
      tokenExpiresAt: Number(device.token_expires_at),
      web: { kind, until, csrf: await csrfToken(token) },
    };
    return json(await this.sessionJson(session), 200, { 'Set-Cookie': sessionCookie(request, token, kind, until, now) });
  }

  // ───────── 驗證 ─────────

  /** 有 Authorization 標頭時以權杖驗證（App）；否則以網頁管理的登入 Cookie 驗證。 */
  private async authenticate(request: Request): Promise<Session> {
    const header = (request.headers.get('Authorization') ?? '').trim();
    if (header === '') {
      const cookie = readSessionCookie(request);
      if (cookie !== null) return this.cookieSession(request, cookie);
    }
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header);
    if (!match) throw new ApiError(401, 'unauthorized', '需要權杖');
    const device = await this.repo.deviceByTokenHash(await sha256Hex(match[1]));
    const now = nowMs();
    // 網頁管理的 Cookie 權杖不能放在 Authorization 標頭使用（期限與 CSRF 檢查只在 Cookie 的路徑）
    if (!device || device.token_expires_at === null || Number(device.token_expires_at) <= now || webSessionKind(device.web_session) !== null) {
      throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新配對');
    }
    let expiresAt = Number(device.token_expires_at);
    if (device.last_seen_at === null || now - Number(device.last_seen_at) >= TOUCH_INTERVAL_MS) {
      // 1.1 的網頁權杖（存在瀏覽器）只更新最後使用時間、不再延長（docs/security-review.md §1）
      if (device.platform !== 'web') expiresAt = now + TOKEN_TTL_MS;
      await this.repo.touchDevice(device.device_id, now, expiresAt);
    }
    const role = (ROLES as readonly string[]).includes(device.role) ? device.role : 'viewer';
    if (!device.identity) throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新配對');
    return {
      deviceId: device.device_id,
      identity: device.identity,
      deviceName: device.name,
      role,
      binding: role === 'driver' ? bindingOf(device) : null,
      tokenExpiresAt: expiresAt,
      web: null,
    };
  }

  /**
   * 網頁管理的登入 Cookie：閒置期限與登入期限；非 GET 的請求檢查 CSRF 權杖、Sec-Fetch-Site 與 JSON 本體
   * （檢查不通過時不延長期限）。
   */
  private async cookieSession(request: Request, token: string): Promise<Session> {
    const device = await this.repo.deviceByTokenHash(await sha256Hex(token));
    const now = nowMs();
    const kind = device ? webSessionKind(device.web_session) : null;
    if (!device || kind === null || device.token_expires_at === null || Number(device.token_expires_at) <= now || !device.identity) {
      throw new ApiError(401, 'unauthorized', '登入已失效，請重新登入');
    }
    const csrf = await csrfToken(token);
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      if (!constantTimeEqual((request.headers.get(CSRF_HEADER) ?? '').trim(), csrf) || crossSite(request)) {
        throw new ApiError(403, 'csrf_failed', '請求來源驗證失敗，請重新整理網頁後再試');
      }
      const length = Number(request.headers.get('Content-Length') ?? '0');
      if (((request.headers.get('Content-Type') ?? '') !== '' || length > 0) && !isJsonContent(request)) {
        throw new ApiError(415, 'unsupported_media_type', '請求本體必須是 JSON（Content-Type: application/json）');
      }
    }
    const until = Number(device.session_until ?? 0);
    let expiresAt = Number(device.token_expires_at);
    if (device.last_seen_at === null || now - Number(device.last_seen_at) >= WEB_TOUCH_INTERVAL_MS) {
      expiresAt = webExpiry(kind, now, until);
      await this.repo.touchDevice(device.device_id, now, expiresAt);
    }
    const role = (ROLES as readonly string[]).includes(device.role) ? device.role : 'viewer';
    return {
      deviceId: device.device_id,
      identity: device.identity,
      deviceName: device.name,
      role,
      binding: role === 'driver' ? bindingOf(device) : null,
      tokenExpiresAt: expiresAt,
      web: { kind, until, csrf },
    };
  }

  private async sessionJson(s: Session) {
    return {
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      role: s.role,
      driverBinding: s.binding,
      server: await this.serverJson(),
      tokenExpiresAt: s.tokenExpiresAt,
      // 網頁管理的登入（1.2.0）：種類、登入期限與 CSRF 權杖；App 的回應沒有這個欄位
      ...(s.web ? { web: { remember: s.web.kind === 'remember', sessionUntil: s.web.until, csrfToken: s.web.csrf } } : {}),
    };
  }

  private async unpairSelf(request: Request, s: Session): Promise<Response> {
    if (!(await this.repo.revokeDevice(s.deviceId, nowMs()))) {
      throw new ApiError(409, 'last_admin', '最後一位可以使用的管理員不能解除配對');
    }
    // 網頁管理登出：同時刪除登入 Cookie
    return noContent(s.web ? { 'Set-Cookie': clearSessionCookie(request) } : {});
  }

  // ───────── 讀取 ─────────

  async snapshot(s: Session) {
    const cursor = await this.repo.currentSeq();
    const out: Record<string, unknown> = {};
    for (const e of ENTITIES) out[SNAPSHOT_KEYS[e]] = [];
    const revisions: Record<string, number> = {};
    for (const r of await this.repo.allLive()) {
      if (!r.payload || !visible(s, r)) continue;
      (out[SNAPSHOT_KEYS[r.entity]] as unknown[]).push(outgoingPayload(s, r.entity, r.id, r.payload));
      revisions[`${r.entity}:${r.id}`] = r.revision;
    }
    out.authoritative = true;
    // revisions（1.2.0）：每筆資料目前的版本（`<種類>:<UUID>`），用戶端修改時可帶 expectedRevision
    return { cursor, snapshot: out, revisions, session: await this.sessionJson(s) };
  }

  async changes(s: Session, url: URL) {
    const since = intParam(url, 'since', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(url, 'limit', 500, 1, 1000);
    const rows = await this.repo.changesSince(since, limit);
    const changes = [];
    for (const r of rows) {
      if (!visible(s, r)) continue;
      changes.push({
        seq: r.seq,
        entity: r.entity,
        id: r.id,
        deleted: r.deleted,
        modifiedAt: r.modifiedAt,
        revision: r.revision,
        payload: r.deleted || !r.payload ? null : outgoingPayload(s, r.entity, r.id, r.payload),
      });
    }
    const cursor = rows.length > 0 ? rows[rows.length - 1].seq : Math.min(since, await this.repo.currentSeq());
    return { changes, cursor, hasMore: rows.length === limit, session: await this.sessionJson(s) };
  }

  // ───────── 寫入 ─────────

  async events(s: Session, body: Record<string, unknown>) {
    const list = body.events;
    if (!Array.isArray(list)) throw badRequest('需要 events 陣列');
    if (list.length > LIMITS.maxEventsPerRequest) throw badRequest(`每次最多 ${LIMITS.maxEventsPerRequest} 筆事件`);
    await this.purgeProcessedOccasionally();
    const results: EventResult[] = [];
    for (const raw of list) results.push(await this.applyEvent(s, raw));
    return { results, cursor: await this.repo.currentSeq() };
  }

  /** 已處理事件保留 30 天；每個執行環境最多每小時清一次。 */
  private async purgeProcessedOccasionally(): Promise<void> {
    const now = nowMs();
    if (now - (lastPurge.get(this.repo.db) ?? 0) < 3600 * 1000) return;
    lastPurge.set(this.repo.db, now);
    await this.repo.purgeProcessed(now - PROCESSED_TTL_MS);
  }

  /**
   * 套用一筆事件。冪等（1.2.0）：同一台裝置重送同一個事件 ID 時回傳第一次的結果，不重複寫入、不重複稽核。
   * 沒有套用（拒絕、衝突、略過）時在修改前後歷史留下摘要（主機上的內容、送來的內容、原因）。
   */
  private async applyEvent(s: Session, raw: unknown): Promise<EventResult> {
    const v = validateEvent(raw);
    if (!v.ok) return { id: v.id, status: 'rejected', reason: v.reason };
    const eventId = v.id.trim().length > 0 && v.id.length <= 100 ? v.id : null;
    if (eventId) {
      const prior = await this.repo.processedResult(s.deviceId, eventId);
      if (prior) {
        try {
          return { ...(JSON.parse(prior) as EventResult), duplicate: true };
        } catch {
          // 紀錄壞掉時重新處理（寫入本身仍受最後寫入者勝保護）
        }
      }
    }
    const { result, existing } = await this.applyValidated(s, v, raw, eventId);
    if (result.status !== 'applied') await this.recordOutcome(s, v, eventId, result, existing);
    return result;
  }

  /** 沒有套用的事件的摘要與冪等紀錄（同一個交易）。 */
  private async recordOutcome(s: Session, v: ValidEvent, eventId: string | null, result: EventResult, existing: StoredRecord | null) {
    const live = existing && !existing.deleted && existing.payload ? existing.payload : null;
    const attempted = v.op === 'delete' || result.reason === 'payload-too-large' || v.payload === null ? null : v.payloadText;
    await this.repo.recordOutcome({
      at: nowMs(),
      entity: v.entity,
      id: v.entityId,
      eventId,
      operation: v.op,
      actor: { identity: s.identity, deviceId: s.deviceId, name: s.deviceName },
      beforeText: live ? JSON.stringify(live) : null,
      attemptedText: attempted,
      changedFields: attempted === null ? null : changedFields(live, v.payload),
      reason: result.reason ?? (v.op === 'delete' ? 'not-found' : 'stale'),
      revision: existing?.revision ?? 0,
      outcome: result.status as 'rejected' | 'conflict' | 'ignored',
      processed: eventId
        ? { deviceId: s.deviceId, eventId, status: result.status, reason: result.reason ?? null, resultJson: JSON.stringify(result) }
        : null,
    });
  }

  private async applyValidated(
    s: Session, v: ValidEvent, raw: unknown, eventId: string | null,
  ): Promise<{ result: EventResult; existing: StoredRecord | null }> {
    const done = (result: EventResult, existing: StoredRecord | null = null) => ({ result, existing });
    if (v.payloadText.length > LIMITS.maxPayloadBytes) return done({ id: v.id, status: 'rejected', reason: 'payload-too-large' });
    const expectedRevision = optionalRevision(raw);
    if (expectedRevision === undefined) return done({ id: v.id, status: 'rejected', reason: 'invalid-expected-revision' });
    const actor = { identity: s.identity, deviceId: s.deviceId, name: s.deviceName };

    // 樂觀並行控制：讀取 → 授權 → 以讀到的序號為條件寫入；期間被別的請求改過就重讀、重新授權（授權與寫入看到同一個版本）。
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.repo.getRecord(v.entity, v.entityId);
      const decision = authorize(s, v.entity, v.op, v.payload, existing);
      if (!decision.allow) return done({ id: v.id, status: 'rejected', reason: decision.reason }, existing);
      const live = existing && !existing.deleted ? existing : null;
      const currentRevision = existing?.revision ?? 0;
      if (expectedRevision !== null && expectedRevision !== currentRevision) {
        return done({
          id: v.id,
          status: 'conflict',
          reason: 'revision-mismatch',
          revision: currentRevision,
          current: existing ? { revision: existing.revision, modifiedAt: existing.modifiedAt, deleted: existing.deleted } : undefined,
        }, existing);
      }
      const now = nowMs();
      const nowApple = msToApple(now);
      const nextRevision = currentRevision + 1;
      const processed = (result: EventResult) => (eventId ? { deviceId: s.deviceId, eventId, resultJson: JSON.stringify(result) } : null);

      if (v.op === 'delete') {
        if (!live) return done({ id: v.id, status: 'ignored' }, existing);
        // 伺服器端的業務規則（1.2.0）：還有進行中車趟的車輛不能刪除（App 也有相同規則）。
        const plate = v.entity === 'vehicle' && live.vehiclePlate ? live.vehiclePlate : null;
        if (plate && (await this.repo.activeTripsOfPlate(plate)) > 0) {
          return done({ id: v.id, status: 'rejected', reason: 'vehicle-has-active-trips' }, existing);
        }
        const at = Math.min(v.timestamp, nowApple);
        const result: EventResult = { id: v.id, status: 'applied', revision: nextRevision };
        // 刪除、連鎖刪除（集合式）、歷史、稽核紀錄、即時位置、冪等紀錄在同一個交易：不會只刪一半。
        const ok = await this.repo.writeAll({
          expect: [{ entity: v.entity, id: v.entityId, seq: live.seq, live: true }],
          conditions: plate ? [Repo.noActiveTrips(plate)] : [],
          writes: [{
            entity: v.entity, id: v.entityId, operation: 'delete', payloadText: null, modifiedAt: at, fields: live, actor, source: 'app',
            eventId, reason: null, nextRevision, changedFields: null, auditSummary: '',
          }],
          cascade: plate ? { plate, entities: VEHICLE_CHILDREN, at, actor } : null,
          processed: processed(result),
          extra: v.entity === 'trip' ? [{ sql: 'DELETE FROM fd_locations WHERE trip_id = ?', params: [v.entityId] }] : [],
          now,
        });
        if (!ok) continue;
        return done(result, existing);
      }

      // 建立／修改：時間校正 → 最後寫入者勝（SQL 中的條件式寫入）。
      const payload = { ...v.payload! };
      let timestamp = v.timestamp;
      let payloadText = v.payloadText;
      let restamped = false;
      const modified = num(payload.lastModifiedAt)!;
      if (timestamp > nowApple || modified > nowApple) {
        timestamp = Math.min(timestamp, nowApple);
        payload.lastModifiedAt = Math.min(modified, nowApple);
        payloadText = JSON.stringify(payload);
        restamped = true;
      }
      // 最後寫入者勝：墓碑的修改時間是刪除的時間，比刪除舊的修改不會讓資料復活。
      if (existing && !(timestamp > existing.modifiedAt)) return done({ id: v.id, status: 'ignored' }, existing);
      const result: EventResult = { id: v.id, status: 'applied', revision: nextRevision };
      if (restamped) result.event = { ...(raw as SyncEvent), timestamp, payloadJSON: payloadText };
      const ok = await this.repo.writeRecord({
        entity: v.entity, id: v.entityId, operation: live ? 'update' : 'create', payloadText,
        modifiedAt: num(payload.lastModifiedAt)!, eventTime: timestamp, fields: scopeFields(v.entity, payload), actor, source: 'app',
        eventId, reason: null, expectedSeq: existing?.seq ?? null, nextRevision, changedFields: changedFields(live?.payload ?? null, payload),
        processed: processed(result), now,
      });
      if (!ok) continue;
      await this.logAudit(s, v.entity, v.entityId, live ? 'update' : 'create', payloadText, now);
      if (v.entity === 'trip' && payload.isCompleted === true) await this.repo.deleteLocation(v.entityId);
      return done(result, existing);
    }
    // 同一筆資料被連續改動：整批請求稍後重送（事件冪等，重送安全）
    throw new ApiError(503, 'busy', '主機忙碌，請稍後再試', 1);
  }

  private async logAudit(s: Session, entity: Entity, id: string, operation: string, payloadText: string, now: number) {
    await this.repo.addAudit({
      at: now,
      device_id: s.deviceId,
      device_name: s.deviceName,
      entity,
      entity_id: id,
      operation,
      // 駕駛人只留 UUID 與姓名（不把個資寫進稽核紀錄）
      summary: auditSummary(entity, payloadText),
    });
  }

  // ───────── 即時位置 ─────────

  private async postLocation(s: Session, body: Record<string, unknown>): Promise<Response> {
    if (s.role === 'viewer') throw new ApiError(403, 'forbidden', '檢視者不能回報位置');
    const tripId = normalizeUuid(body.tripUUID);
    const lat = num(body.latitude);
    const lon = num(body.longitude);
    const ts = num(body.timestamp);
    if (!tripId || lat === null || lon === null || ts === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw badRequest('需要 tripUUID、latitude、longitude、timestamp');
    }
    const trip = await this.repo.getRecord('trip', tripId);
    if (!trip || trip.deleted || !trip.payload || trip.payload.isCompleted === true || !visible(s, trip)) {
      throw new ApiError(403, 'forbidden', '車趟不存在、已完成或不在你的範圍');
    }
    const speed = num(body.speed);
    const course = num(body.course);
    await this.repo.upsertLocation({
      trip_id: tripId,
      device_id: s.deviceId,
      device_name: s.deviceName,
      plate: trip.vehiclePlate,
      latitude: lat,
      longitude: lon,
      speed: speed !== null && speed >= 0 ? speed : null,
      course: course !== null && course >= 0 ? course : null,
      ts,
      updated_at: nowMs(),
    });
    return noContent();
  }

  private async locations(s: Session) {
    const now = nowMs();
    const rows = await this.repo.listLocations(now - LOCATION_TTL_MS);
    const out = [];
    for (const r of rows) {
      if (s.role === 'driver') {
        const trip = await this.repo.getRecord('trip', r.trip_id);
        if (!trip || !visible(s, trip)) continue;
      }
      out.push({
        tripUUID: r.trip_id,
        deviceId: r.device_id,
        deviceName: r.device_name,
        plateNumber: r.plate,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        speed: r.speed === null ? null : Number(r.speed),
        course: r.course === null ? null : Number(r.course),
        timestamp: Number(r.ts),
        stale: now - Number(r.updated_at) > LOCATION_STALE_MS,
      });
    }
    return { locations: out };
  }

  // ───────── 管理 ─────────

  private async patchDevice(rawId: string, body: Record<string, unknown>) {
    const id = normalizeUuid(rawId);
    if (!id) throw badRequest('裝置 ID 必須是 UUID');
    const d = await this.repo.deviceById(id);
    if (!d) throw new ApiError(404, 'not_found', '找不到這台裝置');
    let role: Role = d.role;
    if (body.role !== undefined) {
      if (!(ROLES as readonly unknown[]).includes(body.role)) throw badRequest('role 必須是 admin、driver 或 viewer');
      role = body.role as Role;
    }
    let binding = bindingOf(d);
    if (body.driverBinding !== undefined) {
      const b = parseBinding(body.driverBinding);
      if (b === undefined) throw badRequest('driverBinding 必須是 {driverUuid, driverName} 或 null');
      binding = b;
    }
    if (role !== 'driver') binding = null;
    // 最後一位管理員的檢查在同一句 SQL（兩位管理員同時互相降級時不會一個都不剩）
    if (!(await this.repo.updateDevice(id, role, binding, nowMs()))) {
      throw new ApiError(409, 'last_admin', '最後一位可以使用的管理員不能降級');
    }
    return deviceJson((await this.repo.deviceById(id))!);
  }

  private async deleteDevice(rawId: string): Promise<Response> {
    const id = normalizeUuid(rawId);
    if (!id) throw badRequest('裝置 ID 必須是 UUID');
    const d = await this.repo.deviceById(id);
    if (!d) throw new ApiError(404, 'not_found', '找不到這台裝置');
    if (d.revoked_at === null && !(await this.repo.revokeDevice(id, nowMs()))) {
      throw new ApiError(409, 'last_admin', '最後一位可以使用的管理員不能解除配對');
    }
    return noContent();
  }

  private async createCode(s: Session, body: Record<string, unknown>) {
    if (!(ROLES as readonly unknown[]).includes(body.role)) throw badRequest('role 必須是 admin、driver 或 viewer');
    const role = body.role as Role;
    let binding: DriverBinding | null = null;
    if (body.driverBinding !== undefined && body.driverBinding !== null) {
      const b = parseBinding(body.driverBinding);
      if (!b) throw badRequest('driverBinding 必須是 {driverUuid, driverName}');
      binding = role === 'driver' ? b : null;
    }
    const ttl = body.ttlMinutes === undefined ? 1440 : num(body.ttlMinutes);
    if (ttl === null || !Number.isInteger(ttl) || ttl < 5 || ttl > 10080) throw badRequest('ttlMinutes 必須是 5–10080 的整數');
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 100) : '';
    const now = nowMs();
    const code = newPairingCode();
    const id = crypto.randomUUID().toUpperCase();
    const expiresAt = now + ttl * 60 * 1000;
    await this.repo.createCode({
      id,
      code_hash: await sha256Hex(normalizePairingCode(code)),
      role,
      driver_uuid: binding?.driverUuid ?? null,
      driver_name: binding?.driverName ?? null,
      label,
      created_by: s.deviceId,
      created_at: now,
      expires_at: expiresAt,
    });
    return { id, code, role, driverBinding: binding, label, expiresAt };
  }

  private async listCodes() {
    const rows = await this.repo.listCodes(nowMs());
    return {
      codes: rows.map((r) => ({
        id: r.id,
        label: r.label,
        role: r.role,
        driverBinding: r.role === 'driver' ? bindingOf(r) : null,
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
      })),
    };
  }

  private async deleteCode(rawId: string): Promise<Response> {
    const id = normalizeUuid(rawId);
    if (!id || (await this.repo.deleteCode(id)) === 0) throw new ApiError(404, 'not_found', '找不到這個配對碼');
    return noContent();
  }

  private async rename(body: Record<string, unknown>) {
    const name = cleanName(body.name, 100);
    if (!name) throw badRequest('name 必須是 1–100 個字元');
    await this.repo.setName(name);
    return this.info();
  }

  /**
   * 修改前後歷史（1.2.0；只有管理員）：依種類、資料 ID、套用結果、來源篩選，新到舊分頁。
   * 駕駛人的個資預設遮蔽；`pii=1` 顯示完整內容，並在稽核紀錄留下「檢視個資」。
   */
  private async history(s: Session, url: URL) {
    const limit = intParam(url, 'limit', 50, 1, 200);
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null || beforeRaw === '' ? null : intParam(url, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
    const entityRaw = url.searchParams.get('entity');
    if (entityRaw !== null && !(ENTITIES as readonly string[]).includes(entityRaw)) throw badRequest('entity 不正確');
    const idRaw = url.searchParams.get('id');
    const id = idRaw === null ? null : normalizeUuid(idRaw);
    if (idRaw !== null && id === null) throw badRequest('id 必須是 UUID');
    const outcome = url.searchParams.get('outcome');
    if (outcome !== null && outcome !== '' && outcome !== 'applied' && outcome !== 'notApplied') throw badRequest('outcome 必須是 applied 或 notApplied');
    const source = url.searchParams.get('source');
    if (source !== null && source !== '' && !['app', 'web', 'api', 'cascade'].includes(source)) throw badRequest('source 不正確');
    const pii = url.searchParams.get('pii') === '1';
    const rows = await this.repo.listHistory({
      entity: entityRaw as Entity | null, id, before, limit,
      outcome: outcome === 'applied' || outcome === 'notApplied' ? outcome : null,
      source: source === null || source === '' ? null : source,
    });
    if (pii) {
      await this.repo.addAudit({
        at: nowMs(), device_id: s.deviceId, device_name: s.deviceName, entity: entityRaw ?? 'history', entity_id: id ?? '',
        operation: 'view-pii', summary: '',
      });
    }
    return { entries: rows.map((r) => historyJson(r, pii)), next: rows.length === limit ? Number(rows[rows.length - 1].id) : null };
  }

  private async audit(url: URL) {
    const limit = intParam(url, 'limit', 100, 1, 500);
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null || beforeRaw === '' ? null : intParam(url, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = await this.repo.listAudit(before, limit);
    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        at: Number(r.at),
        deviceId: r.device_id,
        deviceName: r.device_name,
        entity: r.entity,
        entityId: r.entity_id,
        operation: r.operation,
        summary: r.summary,
      })),
      next: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
    };
  }
}

/** 部署環境的進入點：處理一個請求。 */
export function handleRequest(request: Request, ctx: RequestContext): Promise<Response> {
  return new Api(ctx).handle(request);
}
