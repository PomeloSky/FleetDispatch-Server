// HTTP 處理：路由、驗證、各端點（規格：docs/protocol.md）。只用 Web 標準的 Request／Response，
// Cloudflare Workers 直接使用；Docker 版由 node:http 轉接。

import { constantTimeEqual, newPairingCode, newToken, normalizePairingCode, sha256Hex } from './crypto.ts';
import type { DeviceRow, SqlDb } from './db.ts';
import { Repo } from './db.ts';
import { authorize, outgoingPayload, parseBinding, scopeFields, validateEvent, visible } from './rules.ts';
import type { DriverBinding, Entity, EventResult, Role, ServerConfig, Session, SyncEvent } from './types.ts';
import { ApiError, ENTITIES, ROLES, SNAPSHOT_KEYS, VEHICLE_CHILDREN } from './types.ts';
import { badRequest, cleanName, intParam, isObject, msToApple, normalizeUuid, nowMs, num, str } from './util.ts';
import { SERVER_VERSION } from './version.ts';
import { acceptsHtml, adminResponse, homeResponse, isHome, matchAdmin } from './web.ts';

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

const noContent = (): Response =>
  new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function errorResponse(e: ApiError): Response {
  const extra: Record<string, string> = {};
  if (e.retryAfter !== undefined) extra['Retry-After'] = String(e.retryAfter);
  return json({ error: { code: e.code, message: e.message } }, e.status, extra);
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
  };
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

    // 以下需要權杖。
    const session = await this.authenticate(request);

    if (is('GET', 'session')) return json(await this.sessionJson(session));
    if (is('POST', 'unpair')) return this.unpairSelf(session);
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
      setupRequired: (await this.repo.countActiveAdmins()) === 0,
      setupConfigured: this.config.setupToken !== null,
      features: ['liveLocations', 'audit'],
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
    const f = await this.repo.failures(this.ip, now - ATTEMPT_WINDOW_MS);
    if (f.count >= MAX_FAILURES) {
      const retry = Math.max(1, Math.ceil(((f.oldest ?? now) + ATTEMPT_WINDOW_MS - now) / 1000));
      throw new ApiError(429, 'rate_limited', '嘗試太多次，請稍後再試', retry);
    }
    const fail = async (): Promise<never> => {
      await this.repo.recordFailure(this.ip, now);
      throw new ApiError(401, 'invalid_code', '配對碼錯誤、已使用或已過期');
    };

    let role: Role;
    let binding: DriverBinding | null = null;
    let codeHash: string | null = null;
    if ((await this.repo.countActiveAdmins()) === 0) {
      if (this.config.setupToken === null) throw new ApiError(409, 'setup_not_configured', '主機尚未設定設定碼（請依部署文件設定 FD_SETUP_TOKEN）');
      if (!constantTimeEqual(code.trim(), this.config.setupToken)) return fail();
      role = 'admin';
    } else {
      codeHash = await sha256Hex(normalizePairingCode(code));
      const row = await this.repo.findUsableCode(codeHash, now);
      if (!row) return fail();
      role = row.role;
      binding = role === 'driver' ? bindingOf(row) : null;
    }

    const existing = await this.repo.deviceById(deviceId);
    if (existing && existing.revoked_at === null && existing.token_hash !== null && Number(existing.token_expires_at ?? 0) > now) {
      throw new ApiError(409, 'device_conflict', '這台裝置已經配對；請由管理員先解除配對');
    }

    const token = newToken();
    const expiresAt = now + TOKEN_TTL_MS;
    const ok = await this.repo.pairDevice(
      { id: deviceId, name: deviceName, platform, role, binding, tokenHash: await sha256Hex(token), expiresAt },
      now,
      codeHash,
    );
    if (!ok) return fail();
    return { token, deviceId, role, driverBinding: binding, server: await this.serverJson(), tokenExpiresAt: expiresAt };
  }

  // ───────── 驗證 ─────────

  private async authenticate(request: Request): Promise<Session> {
    const header = request.headers.get('Authorization') ?? '';
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header.trim());
    if (!match) throw new ApiError(401, 'unauthorized', '需要權杖');
    const device = await this.repo.deviceByTokenHash(await sha256Hex(match[1]));
    const now = nowMs();
    if (!device || device.token_expires_at === null || Number(device.token_expires_at) <= now) {
      throw new ApiError(401, 'unauthorized', '權杖無效或已過期，請重新配對');
    }
    let expiresAt = Number(device.token_expires_at);
    if (device.last_seen_at === null || now - Number(device.last_seen_at) >= TOUCH_INTERVAL_MS) {
      expiresAt = now + TOKEN_TTL_MS;
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
    };
  }

  private async unpairSelf(s: Session): Promise<Response> {
    if (s.role === 'admin' && (await this.repo.countActiveAdmins()) <= 1) {
      throw new ApiError(409, 'last_admin', '最後一位管理員不能解除配對');
    }
    await this.repo.revokeDevice(s.deviceId, nowMs());
    return noContent();
  }

  // ───────── 讀取 ─────────

  async snapshot(s: Session) {
    const cursor = await this.repo.currentSeq();
    const out: Record<string, unknown> = {};
    for (const e of ENTITIES) out[SNAPSHOT_KEYS[e]] = [];
    for (const r of await this.repo.allLive()) {
      if (!r.payload || !visible(s, r)) continue;
      (out[SNAPSHOT_KEYS[r.entity]] as unknown[]).push(outgoingPayload(s, r.entity, r.id, r.payload));
    }
    out.authoritative = true;
    return { cursor, snapshot: out, session: await this.sessionJson(s) };
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
    const results: EventResult[] = [];
    for (const raw of list) results.push(await this.applyEvent(s, raw));
    return { results, cursor: await this.repo.currentSeq() };
  }

  private async applyEvent(s: Session, raw: unknown): Promise<EventResult> {
    const v = validateEvent(raw);
    if (!v.ok) return { id: v.id, status: 'rejected', reason: v.reason };
    if (v.payloadText.length > LIMITS.maxPayloadBytes) return { id: v.id, status: 'rejected', reason: 'payload-too-large' };
    const existing = await this.repo.getRecord(v.entity, v.entityId);
    const decision = authorize(s, v.entity, v.op, v.payload, existing);
    if (!decision.allow) return { id: v.id, status: 'rejected', reason: decision.reason };

    const now = nowMs();
    const nowApple = msToApple(now);

    if (v.op === 'delete') {
      const at = Math.min(v.timestamp, nowApple);
      if (!(await this.repo.tombstone(v.entity, v.entityId, at, s.deviceId, now))) return { id: v.id, status: 'ignored' };
      await this.logAudit(s, v.entity, v.entityId, 'delete', '', now);
      if (v.entity === 'trip') await this.repo.deleteLocation(v.entityId);
      if (v.entity === 'vehicle' && existing?.vehiclePlate) await this.cascadeVehicle(s, existing.vehiclePlate, at, now);
      return { id: v.id, status: 'applied' };
    }

    // 建立／修改：時間校正 → 最後寫入者勝（SQL 中的條件式寫入）。
    const payload = v.payload!;
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
    if (existing && !(timestamp > existing.modifiedAt)) return { id: v.id, status: 'ignored' };
    const live = existing && !existing.deleted ? existing : null;
    const applied = await this.repo.upsertRecord(
      v.entity,
      v.entityId,
      payloadText,
      num(payload.lastModifiedAt)!,
      timestamp,
      scopeFields(v.entity, payload),
      { identity: s.identity, deviceId: s.deviceId },
      now,
    );
    if (!applied) return { id: v.id, status: 'ignored' };
    await this.logAudit(s, v.entity, v.entityId, live ? 'update' : 'create', payloadText, now);
    if (v.entity === 'trip' && payload.isCompleted === true) await this.repo.deleteLocation(v.entityId);
    const result: EventResult = { id: v.id, status: 'applied' };
    if (restamped) {
      const ev = raw as SyncEvent;
      result.event = { ...ev, timestamp, payloadJSON: payloadText };
    }
    return result;
  }

  private async cascadeVehicle(s: Session, plate: string, at: number, now: number): Promise<void> {
    for (const child of await this.repo.liveChildrenOfPlate(plate, VEHICLE_CHILDREN)) {
      if (await this.repo.tombstone(child.entity, child.id, at, s.deviceId, now)) {
        await this.logAudit(s, child.entity, child.id, 'delete', '', now);
        if (child.entity === 'trip') await this.repo.deleteLocation(child.id);
      }
    }
  }

  private async logAudit(s: Session, entity: Entity, id: string, operation: string, payloadText: string, now: number) {
    await this.repo.addAudit({
      at: now,
      device_id: s.deviceId,
      device_name: s.deviceName,
      entity,
      entity_id: id,
      operation,
      summary: [...payloadText].slice(0, 2000).join(''),
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
    if (d.role === 'admin' && role !== 'admin' && d.revoked_at === null && (await this.repo.countActiveAdmins()) <= 1) {
      throw new ApiError(409, 'last_admin', '最後一位管理員不能降級');
    }
    await this.repo.updateDevice(id, role, binding);
    return deviceJson((await this.repo.deviceById(id))!);
  }

  private async deleteDevice(rawId: string): Promise<Response> {
    const id = normalizeUuid(rawId);
    if (!id) throw badRequest('裝置 ID 必須是 UUID');
    const d = await this.repo.deviceById(id);
    if (!d) throw new ApiError(404, 'not_found', '找不到這台裝置');
    if (d.role === 'admin' && d.revoked_at === null && (await this.repo.countActiveAdmins()) <= 1) {
      throw new ApiError(409, 'last_admin', '最後一位管理員不能解除配對');
    }
    await this.repo.revokeDevice(id, nowMs());
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
