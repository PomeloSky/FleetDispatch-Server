// FleetDispatch Server — Docker／Node 版（Node 24 內建 node:sqlite，沒有原生相依套件）。
// 執行：node docker/src/server.ts（Node 24 直接執行 TypeScript）。設定見 docs/setup-docker.md。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

import type { SqlDb, SqlStatement } from '../../core/src/db.ts';
import { handleRequest, LIMITS } from '../../core/src/handler.ts';
import type { ServerConfig } from '../../core/src/types.ts';
import { SERVER_VERSION } from '../../core/src/version.ts';
import { parseAdminPath } from '../../core/src/web.ts';

class NodeSqliteDb implements SqlDb {
  db: DatabaseSync;
  cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.stmt(sql).all(...(params as never[])) as T[];
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.stmt(sql).get(...(params as never[])) as T | undefined) ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return { changes: Number(this.stmt(sql).run(...(params as never[])).changes) };
  }

  /** 同步執行整個交易：Node 的事件迴圈不會在中途插入其他請求。 */
  async batch(statements: SqlStatement[]): Promise<{ changes: number }[]> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map((s) => ({ changes: Number(this.stmt(s.sql).run(...((s.params ?? []) as never[])).changes) }));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}

const dataDir = process.env.FD_DATA_DIR ?? '/data';
const port = Number(process.env.FD_PORT ?? '8080');
const host = process.env.FD_HOST ?? '0.0.0.0';
/** 信任的反向代理層數（0＝不採信 X-Forwarded-For；1＝前面有一層反向代理，最常見）。 */
const trustedHops = Math.max(0, Math.floor(Number(process.env.FD_TRUST_PROXY ?? '0')) || 0);

mkdirSync(dataDir, { recursive: true });

/** 設定碼：環境變數 FD_SETUP_TOKEN；沒有時產生一組存在資料夾（不寫進日誌）。 */
function setupToken(): string {
  const env = process.env.FD_SETUP_TOKEN?.trim();
  if (env) {
    if (env.length < 16) {
      console.error('FD_SETUP_TOKEN 至少要 16 個字元。');
      process.exit(1);
    }
    return env;
  }
  const file = join(dataDir, 'setup-token.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(18).toString('base64url');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

const admin = parseAdminPath(process.env.FD_ADMIN_PATH);
if (admin.error) console.error(admin.error);

const config: ServerConfig = {
  variant: 'docker',
  setupToken: setupToken(),
  defaultName: process.env.FD_SERVER_NAME?.trim() || 'FleetDispatch Server',
  adminPath: admin.path,
};
const db = new NodeSqliteDb(join(dataDir, 'fleetdispatch.sqlite'));

/** 來源 IP：X-Forwarded-For 最左邊的值由用戶端自己填、可以偽造，只採用信任的代理在右邊附加的值。 */
function clientIp(req: IncomingMessage): string {
  if (trustedHops > 0) {
    const raw = req.headers['x-forwarded-for'];
    const entries = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const ip = entries[entries.length - trustedHops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? '';
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.maxBodyBytes) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const method = (req.method ?? 'GET').toUpperCase();
  let status = 500;
  try {
    const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
    if (body === null && method !== 'GET' && method !== 'HEAD') {
      status = 413;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'payload_too_large', message: '請求本體超過 5 MB' } }));
      req.destroy();
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
    const request = new Request(url, { method, headers, body: body && body.length > 0 ? body : undefined });
    const response = await handleRequest(request, { db, config, clientIp: clientIp(req) });
    status = response.status;
    const out: Record<string, string> = {};
    response.headers.forEach((v, k) => (out[k] = v));
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('[fleetdispatch-server]', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'server_error', message: '主機內部錯誤' } }));
  } finally {
    // 只記方法、路徑（不含查詢字串）、狀態與耗時；不記任何標頭（權杖在 Authorization）。
    const path = (req.url ?? '').split('?')[0];
    console.log(`${new Date().toISOString()} ${method} ${path} ${status} ${Date.now() - started}ms`);
  }
}

const server = createServer((req, res) => {
  void onRequest(req, res);
});
server.requestTimeout = 60_000;
server.listen(port, host, () => {
  console.log(`FleetDispatch Server ${SERVER_VERSION}（Docker）在 http://${host}:${port}，資料：${dataDir}`);
  console.log(config.adminPath ? `網頁管理：<主機網址>${config.adminPath}（首頁是 App 介紹）` : '網頁管理已關閉（FD_ADMIN_PATH）。');
  if (!process.env.FD_SETUP_TOKEN) {
    console.log(`沒有設定 FD_SETUP_TOKEN：第一次設定用的設定碼已存在 ${join(dataDir, 'setup-token.txt')}（docker compose exec 後以 cat 查看）。`);
  }
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
