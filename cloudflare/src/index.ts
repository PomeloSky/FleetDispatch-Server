// FleetDispatch Server — Cloudflare Workers＋D1 版。設定見 docs/setup-cloudflare.md。

import type { SqlDb, SqlStatement } from '../../core/src/db.ts';
import { handleRequest } from '../../core/src/handler.ts';
import type { ServerConfig } from '../../core/src/types.ts';
import { parseRetentionDays } from '../../core/src/util.ts';
import { parseAdminPath } from '../../core/src/web.ts';

interface Env {
  DB: D1Database;
  /** 以 `wrangler secret put FD_SETUP_TOKEN` 設定（至少 16 個字元）。 */
  FD_SETUP_TOKEN?: string;
  FD_SERVER_NAME?: string;
  /** 網頁管理的網址路徑（預設 /admin；空字串或 off 關閉）。 */
  FD_ADMIN_PATH?: string;
  /** 修改前後歷史保留的天數（預設不自動刪除；至少 30 天）。 */
  FD_HISTORY_RETENTION_DAYS?: string;
}

class D1Db implements SqlDb {
  d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  private prepare(sql: string, params: unknown[]): D1PreparedStatement {
    const s = this.d1.prepare(sql);
    return params.length > 0 ? s.bind(...params) : s;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.prepare(sql, params).all<T>();
    return r.results ?? [];
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.prepare(sql, params).first<T>()) ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const r = await this.prepare(sql, params).run();
    return { changes: Number(r.meta?.changes ?? 0) };
  }

  /** D1 的 batch 是一個交易：任何一句失敗就全部回滾。 */
  async batch(statements: SqlStatement[]): Promise<{ changes: number }[]> {
    const results = await this.d1.batch(statements.map((s) => this.prepare(s.sql, s.params ?? [])));
    return results.map((r) => ({ changes: Number(r.meta?.changes ?? 0) }));
  }
}

/** 同一個 isolate 共用同一個轉接器（資料表只在第一次請求時建立）。 */
const adapters = new WeakMap<D1Database, D1Db>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let db = adapters.get(env.DB);
    if (!db) {
      db = new D1Db(env.DB);
      adapters.set(env.DB, db);
    }
    const token = env.FD_SETUP_TOKEN?.trim() ?? '';
    const admin = parseAdminPath(env.FD_ADMIN_PATH);
    if (admin.error) console.error('[fleetdispatch-server]', admin.error);
    const retention = parseRetentionDays(env.FD_HISTORY_RETENTION_DAYS);
    if (retention.error) console.error('[fleetdispatch-server]', retention.error);
    const config: ServerConfig = {
      variant: 'cloudflare',
      setupToken: token.length >= 16 ? token : null,
      defaultName: env.FD_SERVER_NAME?.trim() || 'FleetDispatch Server',
      adminPath: admin.path,
      historyRetentionDays: retention.days,
    };
    return handleRequest(request, { db, config, clientIp: request.headers.get('CF-Connecting-IP') ?? '' });
  },
} satisfies ExportedHandler<Env>;
