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
