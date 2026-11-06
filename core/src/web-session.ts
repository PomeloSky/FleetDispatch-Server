// 網頁管理的登入（1.2.0，docs/security-review.md §1）：權杖由主機以 HttpOnly Cookie 保存，網頁的程式讀不到，
// 也不會因為網頁被插入惡意程式而被帶走。App 照舊以 Authorization: Bearer 傳送權杖（不受影響）。
//
// - Cookie：HttpOnly、SameSite=Strict、只送到 API 的路徑（`<基底路徑>/api/v1`）；HTTPS 時加 Secure 並以 `__Secure-` 開頭。
// - CSRF：非 GET 的請求要帶 X-FleetDispatch-CSRF（由登入權杖推導、以 GET /session 取得），瀏覽器的 Sec-Fetch-Site
//   有送時必須是 same-origin，有本體時必須是 JSON。自訂標頭讓跨站請求一定要先經過 CORS 預檢，而主機不回應 CORS。
// - 期限：不記住這個瀏覽器時閒置 2 小時或登入 12 小時後失效；記住時閒置 30 天或登入 90 天後失效。

import { sha256Hex } from './crypto.ts';

export type WebSessionKind = 'session' | 'remember';

export const WEB_SESSION_LIFETIME: Record<WebSessionKind, { idleMs: number; maxMs: number }> = {
  session: { idleMs: 2 * 3600 * 1000, maxMs: 12 * 3600 * 1000 },
  remember: { idleMs: 30 * 24 * 3600 * 1000, maxMs: 90 * 24 * 3600 * 1000 },
};

/** 網頁登入的最後使用時間與閒置期限最多每 5 分鐘更新一次（App 的權杖是每小時）。 */
export const WEB_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 1.0–1.1 的網頁管理把權杖存在瀏覽器（localStorage／sessionStorage）。升級後這些權杖不再延長、最多再用 30 天；
 * 期間內開啟網頁管理會自動換成 Cookie（POST /web/upgrade），之後舊權杖失效。
 */
export const LEGACY_WEB_TTL_MS = 30 * 24 * 3600 * 1000;

export const CSRF_HEADER = 'X-FleetDispatch-CSRF';
const COOKIE = 'fd_admin';
const SECURE_COOKIE = '__Secure-fd_admin';
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const BASE = /^(\/[A-Za-z0-9._~-]+)*$/;

/** 資料庫的 web_session 欄位：`session`（不記住）、`remember`（記住）；其他值（App 與 1.1 的網頁權杖是 NULL）回傳 null。 */
export function webSessionKind(v: unknown): WebSessionKind | null {
  return v === 'session' || v === 'remember' ? v : null;
}

/** 這次登入現在的有效期限：閒置期限與登入期限（until）中較早的。 */
export function webExpiry(kind: WebSessionKind, now: number, until: number): number {
  return Math.min(now + WEB_SESSION_LIFETIME[kind].idleMs, until);
}

/** 請求是不是 HTTPS：網址本身，或前面的反向代理以 X-Forwarded-Proto 告知（只決定 Cookie 的 Secure 屬性；偽造只影響偽造的人自己）。 */
export function isSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === 'https:') return true;
  const proto = (request.headers.get('X-Forwarded-Proto') ?? '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/** Cookie 的路徑：`<基底路徑>/api/v1`（網頁管理的頁面與其他路徑收不到）。基底路徑有其他字元時只用 `/api/v1`。 */
export function cookiePath(pathname: string): string {
  const i = pathname.indexOf('/api/v1');
  const base = i >= 0 ? pathname.slice(0, i) : '';
  return (BASE.test(base) ? base : '') + '/api/v1';
}

/** 請求帶的登入 Cookie（`__Secure-` 優先）；沒有或格式不對時回傳 null。 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  let plain: string | null = null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!TOKEN.test(value)) continue;
    if (name === SECURE_COOKIE) return value;
    if (name === COOKIE && plain === null) plain = value;
  }
  return plain;
}

/** 設定登入 Cookie 的 Set-Cookie 值。不記住時不給 Max-Age（瀏覽器關閉時刪除）。 */
export function sessionCookie(request: Request, token: string, kind: WebSessionKind, until: number, now: number): string {
  const secure = isSecureRequest(request);
  const parts = [`${secure ? SECURE_COOKIE : COOKIE}=${token}`, `Path=${cookiePath(new URL(request.url).pathname)}`, 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  if (kind === 'remember') parts.push(`Max-Age=${Math.max(0, Math.floor((until - now) / 1000))}`);
  return parts.join('; ');
}

/** 刪除登入 Cookie（登出）。 */
export function clearSessionCookie(request: Request): string {
  const secure = isSecureRequest(request);
  const parts = [`${secure ? SECURE_COOKIE : COOKIE}=`, `Path=${cookiePath(new URL(request.url).pathname)}`, 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  parts.push('Max-Age=0');
  return parts.join('; ');
}

/** CSRF 權杖：由登入權杖推導（不另外保存；推不回權杖）。 */
export async function csrfToken(token: string): Promise<string> {
  return (await sha256Hex('fd-csrf:' + token)).slice(0, 32);
}

/** 瀏覽器告知這是跨站或跨來源的請求（Sec-Fetch-Site 有送且不是 same-origin）。 */
export function crossSite(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  return site !== null && site.trim().toLowerCase() !== 'same-origin';
}

/** Content-Type 是 JSON（可以帶 charset）。 */
export function isJsonContent(request: Request): boolean {
  return (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}
