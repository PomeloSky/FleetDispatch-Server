// FleetDispatch Server（Docker）的維護工具：備份資料庫、恢復第一次設定（管理員裝置遺失時）。
//
//   docker compose exec fleetdispatch node docker/src/admin-tools.ts backup
//   docker compose exec fleetdispatch node docker/src/admin-tools.ts reset-admins
//   docker compose exec fleetdispatch node docker/src/admin-tools.ts setup-token
//   docker compose run --rm fleetdispatch node docker/src/admin-tools.ts restore backups/<檔名>.sqlite   （主機必須先停止）
//
// 本機開發時以 FD_DATA_DIR 指定資料夾。

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.FD_DATA_DIR ?? '/data';
const dbPath = join(dataDir, 'fleetdispatch.sqlite');
const command = process.argv[2] ?? '';

function open(): DatabaseSync {
  if (!existsSync(dbPath)) {
    console.error(`找不到資料庫：${dbPath}（主機至少要啟動過一次）`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

switch (command) {
  case 'backup': {
    // VACUUM INTO 產生一致的完整副本，主機執行中也可以使用。
    const dir = join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const file = join(dir, `fleetdispatch-${stamp}.sqlite`);
    const db = open();
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    db.close();
    console.log(`已備份：${file}`);
    break;
  }
  case 'reset-admins': {
    // 撤銷所有管理員裝置；之後設定碼重新生效，可以讓新的裝置成為管理員。資料不受影響。
    const db = open();
    const result = db.prepare(`UPDATE fd_devices SET revoked_at = ?, token_hash = NULL WHERE role = 'admin' AND revoked_at IS NULL`).run(Date.now());
    db.close();
    console.log(`已撤銷 ${Number(result.changes)} 台管理員裝置。請在 App 以設定碼重新連線，成為管理員。`);
    break;
  }
  case 'restore': {
    // 以備份取代資料庫（主機必須停止）：先檢查備份檔可以開啟，再刪除舊的 -wal／-shm 並複製。
    const arg = process.argv[3];
    if (!arg) {
      console.error('用法：node docker/src/admin-tools.ts restore backups/<檔名>.sqlite');
      process.exit(1);
    }
    const source = isAbsolute(arg) ? arg : join(dataDir, arg);
    if (!existsSync(source)) {
      console.error(`找不到備份檔：${source}`);
      process.exit(1);
    }
    const check = new DatabaseSync(source, { readOnly: true });
    const ok = check.prepare(`PRAGMA integrity_check`).get() as { integrity_check?: string } | undefined;
    check.close();
    if (ok?.integrity_check !== 'ok') {
      console.error('備份檔損毀，沒有還原。');
      process.exit(1);
    }
    if (existsSync(dbPath)) copyFileSync(dbPath, join(dataDir, `fleetdispatch.before-restore-${Date.now()}.sqlite`));
    for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    copyFileSync(source, dbPath);
    console.log(`已從 ${source} 還原。原本的資料庫另存為 fleetdispatch.before-restore-*.sqlite。`);
    break;
  }
  case 'setup-token': {
    if (process.env.FD_SETUP_TOKEN) {
      console.log('設定碼由環境變數 FD_SETUP_TOKEN 提供（請查看 compose.yaml）。');
      break;
    }
    const file = join(dataDir, 'setup-token.txt');
    console.log(existsSync(file) ? readFileSync(file, 'utf8').trim() : '尚未產生設定碼（主機至少要啟動過一次）。');
    break;
  }
  default:
    console.log('用法：node docker/src/admin-tools.ts <backup|restore <檔案>|reset-admins|setup-token>');
    process.exit(command ? 1 : 0);
}
