// RelayBox core lib — pure Web Crypto AES-GCM helpers for encrypting storage pool secrets.
// Zero Node dependencies; works identically on Cloudflare Workers and Node.js >= 20.

const PREFIX = 'enc:v1:';

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password) {
  const seed = new TextEncoder().encode(String(password || '') + ':relaybox-pool-secret-v1');
  const hash = await crypto.subtle.digest('SHA-256', seed);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext, password) {
  const text = String(plaintext || '');
  if (!text) return '';
  if (!password) return text;
  const key = await deriveKey(password);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text),
  ));
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return PREFIX + bytesToBase64(combined);
}

export async function decryptSecret(stored, password) {
  const raw = String(stored || '');
  if (!raw) return '';
  if (!raw.startsWith(PREFIX)) return raw;
  if (!password) throw new Error('SECRET_DECRYPT_KEY_MISSING');
  const combined = base64ToBytes(raw.slice(PREFIX.length));
  if (combined.length < 13) throw new Error('SECRET_CORRUPTED');
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const key = await deriveKey(password);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function maskAccessKey(ak) {
  const s = String(ak || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '****';
  return s.slice(0, 4) + '…' + s.slice(-4);
}
