// 由 web/ 的網頁管理原始檔產生各實作使用的檔案：
//   core/src/web-assets.ts（Cloudflare Workers 與 Docker／Node 版）、php/web/（PHP 版）。
// 用法：node scripts/build-web.mjs        產生
//       node scripts/build-web.mjs --check 只檢查產生的檔案是否與原始檔一致（CI 使用）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const html = read('web/admin.html');
const js = read('web/admin.js');
const home = read('web/home.html');

const outputs = {
  'core/src/web-assets.ts':
    '// 由 scripts/build-web.mjs 從 web/ 的 admin.html、admin.js、home.html 產生，請不要直接修改；\n' +
    '// 修改 web/ 底下的檔案後執行 npm run build:web。\n\n' +
    `export const ADMIN_HTML = ${JSON.stringify(html)};\n\n` +
    `export const ADMIN_JS = ${JSON.stringify(js)};\n\n` +
    `export const HOME_HTML = ${JSON.stringify(home)};\n`,
  'php/web/admin.html': html,
  'php/web/admin.js': js,
  'php/web/home.html': home,
};

const check = process.argv.includes('--check');
let stale = 0;
for (const [path, content] of Object.entries(outputs)) {
  const file = join(root, path);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (current === content) continue;
  if (check) {
    console.error(`${path} 與 web/ 的原始檔不一致，請執行 npm run build:web 後一起提交。`);
    stale++;
  } else {
    writeFileSync(file, content);
    console.log(`已產生 ${path}`);
  }
}
if (check && stale > 0) process.exit(1);
if (check) console.log('網頁的產生檔案與原始檔一致。');
