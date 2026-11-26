// RelayBox core lib — pure Web Crypto helpers (AES-GCM for pool secrets, PBKDF2-SHA256 for user passwords).
// Zero Node dependencies; works identically on Cloudflare Workers and Node.js >= 20.

const PREFIX = 'enc:v1:';
const PBKDF2_ITERATIONS = 100000;

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

function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
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

/** Hash a user password using Web Crypto PBKDF2-SHA256 with 16-byte random salt. */
export async function hashPassword(plain) {
  const pw = String(plain || '');
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

/** Verify a plaintext password against a stored pbkdf2$<iter>$<salt_b64>$<hash_b64> hash. */
export async function verifyPassword(plain, stored) {
  const raw = String(stored || '');
  const parts = raw.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 500000) return false;
  let salt, expected;
  try {
    salt = base64ToBytes(parts[2]);
    expected = base64ToBytes(parts[3]);
  } catch {
    return false;
  }
  if (!salt.length || expected.length !== 32) return false;
  try {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(String(plain || '')),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      baseKey,
      256,
    );
    return constantTimeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}
