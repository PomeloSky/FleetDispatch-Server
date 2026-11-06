import { ApiError } from './types.ts';

/** 2001-01-01 UTC 與 1970-01-01 UTC 相差的秒數。 */
export const APPLE_EPOCH_OFFSET = 978307200;

export const nowMs = (): number => Date.now();
export const msToApple = (ms: number): number => ms / 1000 - APPLE_EPOCH_OFFSET;

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** 合法的 UUID 轉大寫；不合法回傳 null。 */
export const normalizeUuid = (v: unknown): string | null => (isUuid(v) ? v.toUpperCase() : null);

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function badRequest(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

/** 解析 JSON 字串成物件；失敗回傳 null。 */
export function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** 名稱類欄位：去除前後空白，長度 1–max。 */
export function cleanName(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

export function intParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw badRequest(`${key} 必須是非負整數`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw badRequest(`${key} 太大`);
  return Math.min(Math.max(n, min), max);
}

/**
 * JSON 的巢狀層數上限（陣列與物件）：與 PHP 版 json_decode 的 depth 512 相同（最多 511 層），三種實作對同一份內容的判斷一致；
 * 也避免極深的內容讓之後的處理耗盡堆疊（docs/security-review.md §4.7）。
 */
export const MAX_JSON_NESTING = 511;

/** JSON 文字的陣列／物件巢狀層數不超過 max（逐字掃描、不遞迴；字串裡的括號不算）。格式是否正確交給 JSON.parse。 */
export function withinJsonNesting(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // 反斜線：略過被跳脫的字元
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) return false;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return true;
}

/** 字串的字元（Unicode 碼位）數。 */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** IPv6 位址的 8 個 16 位元群組；不是 IPv6 時回傳 null。接受 `[…]`、zone（`%eth0`）與結尾的 IPv4（`::ffff:1.2.3.4`）。 */
function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  const last = halves.length === 2 ? tail : head;
  if (last.length > 0 && last[last.length - 1].includes('.')) {
    const parts = last[last.length - 1].split('.');
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
    const b = parts.map(Number);
    last.splice(last.length - 1, 1, ((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16));
  }
  const count = head.length + tail.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? 8 - count : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * 配對嘗試次數限制的來源：IPv6 以 /64 網段計算（同一個網段的位址通常屬於同一個使用者、可以任意更換）；
 * IPv4 對應的 IPv6（`::ffff:a.b.c.d`）視為 IPv4；其他照原樣（最多 64 個字元）。
 */
export function rateLimitKey(ip: string): string {
  const g = parseIPv6(ip);
  if (g === null) return ip.slice(0, 64);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
