// パスワードとトークンの処理（Web Crypto API のみ使用、外部サービス不要）
const ITER = 100_000;
const enc = new TextEncoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string): Promise<string> {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITER))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, iter, salt, hash] = (stored ?? "").split("$");
  if (kind !== "pbkdf2" || !salt || !hash) return false;
  const got = b64(await pbkdf2(password, unb64(salt), Number(iter)));
  return timingSafeEqual(got, hash);
}

// 文字列比較の所要時間から内容を推測されにくくする
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
