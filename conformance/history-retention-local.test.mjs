// 修改前後歷史的保留天數（1.2.0，docs/audit-history.md §4）：需要在資料庫放入舊的歷史，只在本機的暫存資料夾執行
// （Docker／Node 與 PHP＋SQLite；不連任何正式主機）：
//   node --test conformance/history-retention-local.test.mjs（PHP 版需要 php 與 pdo_sqlite；沒有 php 時略過）
//   FD_LOCAL_VARIANTS=node 或 php：只執行其中一種
// - 設定 30 天：送出事件時刪除 30 天前的歷史，較新的保留；稽核紀錄不刪除；GET /admin/history 回報 retentionDays
// - 沒有設定（預設）：不刪除任何歷史

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const SETUP = 'retention-test-setup-token';
const DAY = 24 * 3600 * 1000;
const uuid = () => crypto.randomUUID().toUpperCase();
const nowApple = () => Date.now() / 1000 - 978307200;

const VARIANTS = {
  node(dir, port, days) {
    return spawn(process.execPath, ['docker/src/server.ts'], {
      env: {
        ...process.env, FD_DATA_DIR: dir, FD_HOST: '127.0.0.1', FD_PORT: String(port), FD_SETUP_TOKEN: SETUP,
        ...(days === null ? {} : { FD_HISTORY_RETENTION_DAYS: String(days) }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  },
  php(dir, port, days) {
    const config = join(dir, 'config.php');
    const retention = days === null ? '' : `, 'history_retention_days' => ${days}`;
    writeFileSync(config, `<?php\nreturn ['setup_token' => '${SETUP}', 'db' => ['dsn' => 'sqlite:${join(dir, 'fleetdispatch.sqlite')}', 'user' => '', 'password' => ''], 'server_name' => 'x', 'admin_path' => '/admin'${retention}];\n`);
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
      if (r.ok) return;
    } catch {
      // 還在啟動
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('主機沒有啟動');
}

/** 啟動一台主機（保留天數 days；null 是沒有設定），配對管理員，在資料庫放入 40 天前與 10 天前的歷史與稽核，再送出一筆事件。 */
async function scenario(variant, days) {
  const dir = mkdtempSync(join(tmpdir(), 'fd-retention-'));
  const port = 20600 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const child = VARIANTS[variant](dir, port, days);
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  try {
    await waitReady(base);
    const call = async (method, path, { token, body } = {}) => {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${base}/api/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    const admin = await call('POST', 'pair', { body: { code: SETUP, deviceId: uuid(), deviceName: '管理員', platform: 'macos' } });
    assert.equal(admin.status, 200);
    const token = admin.json.token;

    const db = new DatabaseSync(join(dir, 'fleetdispatch.sqlite'));
    db.exec('PRAGMA busy_timeout = 5000');
    const history = db.prepare(`INSERT INTO fd_record_history (at, entity, entity_id, event_id, operation, source, actor_device, actor_identity, actor_name,
      before_json, after_json, changed_fields, reason, seq, revision, outcome) VALUES (?, 'part', ?, NULL, 'create', 'app', NULL, NULL, '舊裝置', NULL, '{}', '[]', NULL, 0, 1, 'applied')`);
    const oldId = uuid();
    const recentId = uuid();
    history.run(Date.now() - 40 * DAY, oldId);
    history.run(Date.now() - 10 * DAY, recentId);
    db.prepare(`INSERT INTO fd_audit (at, device_id, device_name, entity, entity_id, operation, summary) VALUES (?, 'X', '舊裝置', 'part', ?, 'create', '')`)
      .run(Date.now() - 40 * DAY, oldId);

    // 送出事件時清理（每個執行環境最多每小時一次；這是啟動後第一次）
    const id = uuid();
    const at = nowApple();
    const r = await call('POST', 'events', {
      token,
      body: { events: [{ id: uuid(), timestamp: at, actor: 't', entity: 'part', operation: 'create', entityID: id, payloadJSON: JSON.stringify({ entityUUID: id, name: '新零件', lastModifiedAt: at }) }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].status, 'applied');

    const ids = db.prepare('SELECT entity_id FROM fd_record_history ORDER BY id').all().map((x) => x.entity_id);
    const audits = db.prepare('SELECT COUNT(*) AS n FROM fd_audit WHERE entity_id = ?').get(oldId).n;
    db.close();
    const listed = await call('GET', 'admin/history?limit=5', { token });
    return { ids, audits, retentionDays: listed.json.retentionDays, ids_: { oldId, recentId, id } };
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
}

for (const variant of Object.keys(VARIANTS)) {
  test(`修改前後歷史的保留天數（${variant}）`, { skip: skipReason(variant) }, async () => {
    const kept = await scenario(variant, 30);
    assert.deepEqual(kept.ids, [kept.ids_.recentId, kept.ids_.id], '30 天前的歷史已刪除，較新的保留');
    assert.equal(kept.audits, 1, '稽核紀錄不刪除');
    assert.equal(kept.retentionDays, 30);

    const forever = await scenario(variant, null);
    assert.deepEqual(forever.ids, [forever.ids_.oldId, forever.ids_.recentId, forever.ids_.id], '沒有設定時不刪除');
    assert.equal(forever.retentionDays, 0);
  });
}
