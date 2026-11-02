// 網頁（docs/protocol.md「網頁」）：首頁是 FleetDispatch App 的介紹與下載連結；管理頁只在設定的管理網址出現。
// 頁面本身沒有任何機密；管理頁的登入與所有操作都經過公開的 API v1（以配對碼或設定碼配對取得權杖）。

import { ADMIN_HTML, ADMIN_JS, HOME_HTML } from './web-assets.ts';
import { SERVER_VERSION } from './version.ts';

/** 沒有設定時的管理網址。對外服務時建議改成不容易猜到的路徑。 */
export const DEFAULT_ADMIN_PATH = '/admin';

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * 解析管理網址設定。沒有設定時用預設值；空字串或 `off` 表示關閉網頁管理。
 * 回傳 `{ path }`（`null` 是關閉），格式不正確時另外帶 `error`（同時視為關閉）。
 */
export function parseAdminPath(raw: string | undefined | null): { path: string | null; error?: string } {
  if (raw === undefined || raw === null) return { path: DEFAULT_ADMIN_PATH };
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'off') return { path: null };
  const segments = v.split('/').filter((s) => s !== '');
  const ok =
    segments.length > 0 &&
    v.length <= 100 &&
    segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..') &&
    segments[0].toLowerCase() !== 'api' &&
    segments[0].toLowerCase() !== 'index.php';
  if (!ok) return { path: null, error: `管理網址 ${JSON.stringify(v)} 格式不正確（例如 /admin；只能用英數字與 . _ ~ -，不能以 /api 開頭），網頁管理已關閉` };
  return { path: '/' + segments.join('/') };
}

/** 基底路徑（部署在子資料夾或沒有網址改寫的 `/index.php`）只能是一般的路徑段。 */
const BASE = /^(\/[A-Za-z0-9._~-]+)*$/;

/** 這個路徑是不是管理頁（`page`）或它的程式（`script`）；`base` 是管理網址前面的基底路徑。 */
export function matchAdmin(pathname: string, adminPath: string): { kind: 'page' | 'script'; base: string } | null {
  let p = pathname;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  let kind: 'page' | 'script';
  let base: string;
  if (p.endsWith(adminPath + '/app.js')) {
    kind = 'script';
    base = p.slice(0, p.length - adminPath.length - '/app.js'.length);
  } else if (p.endsWith(adminPath)) {
    kind = 'page';
    base = p.slice(0, p.length - adminPath.length);
  } else {
    return null;
  }
  if (!BASE.test(base)) return null;
  const parts = base.split('/');
  if (parts.some((s) => s === '.' || s === '..') || base.includes('/api/v1')) return null;
  return { kind, base };
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 管理頁的安全標頭：只允許同一個來源的程式與 API，不能被嵌入其他網站。 */
export const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const COMMON_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

/** 管理頁的內容（基底路徑與管理網址填進 HTML，頁面的程式依此呼叫 API）。 */
export function adminHtml(base: string, adminPath: string): string {
  return ADMIN_HTML.replaceAll('{{BASE}}', escapeAttr(base)).replaceAll('{{ADMIN}}', escapeAttr(adminPath));
}

/** 首頁：基底路徑本身（`/`），或 `…/index.php`、`…/index.html`。 */
export function isHome(pathname: string): boolean {
  let p = pathname;
  while (p.length > 0 && p.endsWith('/')) p = p.slice(0, -1);
  return p === '' || /^(\/[A-Za-z0-9._~-]+)*\/index\.(php|html)$/.test(p);
}

/** 瀏覽器開啟的請求（Accept 有 text/html）：找不到的網址也顯示首頁，而不是 JSON 錯誤。 */
export const acceptsHtml = (accept: string | null): boolean => (accept ?? '').toLowerCase().includes('text/html');

/** 首頁不需要程式：只允許內嵌樣式與圖片。 */
export const HOME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** 首頁（App 介紹與下載連結）。找不到的網址以 404 狀態回應同樣的內容。 */
export function homeResponse(status: 200 | 404, method: string): Response {
  return new Response(method === 'HEAD' ? null : HOME_HTML.replaceAll('{{VERSION}}', SERVER_VERSION), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': HOME_CSP,
      'X-Frame-Options': 'DENY',
    },
  });
}

export function adminResponse(kind: 'page' | 'script', base: string, adminPath: string, method: string): Response {
  const head = method === 'HEAD';
  if (kind === 'script') {
    return new Response(head ? null : ADMIN_JS, {
      status: 200,
      headers: { ...COMMON_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' },
    });
  }
  return new Response(head ? null : adminHtml(base, adminPath), {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': ADMIN_CSP,
      'X-Frame-Options': 'DENY',
    },
  });
}
