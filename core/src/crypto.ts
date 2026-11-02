// 權杖、配對碼與雜湊（Web Crypto：Cloudflare Workers 與 Node 24 都內建 globalThis.crypto）。

const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 位元組隨機權杖（base64url，無 padding）。 */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 8 個字元的配對碼（顯示為 XXXX-XXXX）；以拒絕取樣避免偏差。 */
export function newPairingCode(): string {
  const out: string[] = [];
  const limit = 256 - (256 % PAIRING_ALPHABET.length);
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < 8) out.push(PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]);
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4).join('')}`;
}

/** 比對用的配對碼：去除空白與連字號、轉大寫。 */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/** 常數時間比較（長度不同也走完整個迴圈）。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
