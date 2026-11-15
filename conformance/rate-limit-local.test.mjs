// 配對嘗試次數限制的來源（1.2.0，docs/security-review.md §4.5）：IPv6 以 /64 網段計算、IPv4 對應的 IPv6 視為 IPv4。
// 需要以 X-Forwarded-For 模擬不同的來源，所以在本機的暫存資料夾啟動「信任一層反向代理」的主機執行
// （Docker／Node 與 PHP＋SQLite；不連任何正式主機）：
//   node --test conformance/rate-limit-local.test.mjs（PHP 版需要 php 與 pdo_sqlite；沒有 php 時略過）
//   FD_LOCAL_VARIANTS=node 或 php：只執行其中一種
// Cloudflare 版的來源是 CF-Connecting-IP（無法在本機偽造），計算方式是同一個函式（core/src/util.ts 的 rateLimitKey）。

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const SETUP = 'rate-limit-test-setup-token';
const uuid = () => crypto.randomUUID().toUpperCase();

const VARIANTS = {
  node(dir, port) {
    return spawn(process.execPath, ['docker/src/server.ts'], {
      env: { ...process.env, FD_DATA_DIR: dir, FD_HOST: '127.0.0.1', FD_PORT: String(port), FD_SETUP_TOKEN: SETUP, FD_TRUST_PROXY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  },
  php(dir, port) {
    const config = join(dir, 'config.php');
    writeFileSync(config, `<?php\nreturn ['setup_token' => '${SETUP}', 'db' => ['dsn' => 'sqlite:${join(dir, 'fleetdispatch.sqlite')}', 'user' => '', 'password' => ''], 'server_name' => 'x', 'admin_path' => '/admin', 'trust_proxy' => 1];\n`);
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

for (const [variant, start] of Object.entries(VARIANTS)) {
  test(`配對嘗試次數限制：IPv6 以 /64 計算、IPv4 對應的位址視為 IPv4（${variant}）`, { skip: skipReason(variant) }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fd-ratelimit-'));
    const port = 20200 + Math.floor(Math.random() * 400);
    const base = `http://127.0.0.1:${port}`;
    const child = start(dir, port);
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    try {
      await waitReady(base);
      const attempt = async (from) => (await fetch(`${base}/api/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
        body: JSON.stringify({ code: 'wrong-setup-token-000', deviceId: uuid(), deviceName: '猜測' }),
      })).status;

      // 同一個 /64 的不同位址共用次數
      for (let i = 1; i <= 10; i++) assert.equal(await attempt(`2001:db8:1:2::${i.toString(16)}`), 401, `第 ${i} 次`);
      assert.equal(await attempt('2001:0db8:0001:0002:ffff::1'), 429, '同一個 /64（不同寫法）');
      assert.equal(await attempt('2001:db8:1:3::1'), 401, '不同的 /64');

      // IPv4 與對應的 IPv6 共用次數
      for (let i = 1; i <= 10; i++) assert.equal(await attempt('198.51.100.7'), 401);
      assert.equal(await attempt('::ffff:198.51.100.7'), 429);
      assert.equal(await attempt('198.51.100.8'), 401);

      const db = new DatabaseSync(join(dir, 'fleetdispatch.sqlite'), { readOnly: true });
      const keys = db.prepare('SELECT DISTINCT ip FROM fd_attempts ORDER BY ip').all().map((r) => r.ip);
      db.close();
      assert.deepEqual(keys, ['198.51.100.7', '198.51.100.8', '2001:db8:1:2::/64', '2001:db8:1:3::/64']);
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
