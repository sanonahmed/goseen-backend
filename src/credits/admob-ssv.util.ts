import { createPublicKey, verify as verifySignature } from 'crypto';

interface VerifierKey {
  keyId: number;
  pem: string;
}

const KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // Google rotates these infrequently; 1h is safe.

let cachedKeys: VerifierKey[] = [];
let cachedAt = 0;

async function getVerifierKeys(): Promise<VerifierKey[]> {
  if (cachedKeys.length && Date.now() - cachedAt < CACHE_TTL_MS) return cachedKeys;
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new Error(`Failed to fetch AdMob verifier keys: ${res.status}`);
  const data = (await res.json()) as { keys: VerifierKey[] };
  cachedKeys = data.keys;
  cachedAt = Date.now();
  return cachedKeys;
}

/**
 * Verifies an AdMob rewarded-ad Server-Side Verification (SSV) callback.
 *
 * `queryString` must be the raw, still URL-encoded query string exactly as
 * received (everything after '?', params in Google's original order) —
 * the signature covers that exact byte sequence, so re-serializing the
 * parsed params would break verification.
 *
 * https://developers.google.com/admob/android/rewarded-video-ssv
 */
export async function verifyAdMobSsvSignature(queryString: string): Promise<boolean> {
  const sigParamIndex = queryString.indexOf('&signature=');
  if (sigParamIndex === -1) return false;
  const signedContent = queryString.slice(0, sigParamIndex);

  const params = new URLSearchParams(queryString);
  const signatureB64Url = params.get('signature');
  const keyIdStr = params.get('key_id');
  if (!signatureB64Url || !keyIdStr) return false;

  const keys = await getVerifierKeys();
  const match = keys.find((k) => k.keyId === Number(keyIdStr));
  if (!match) return false;

  const signature = Buffer.from(
    signatureB64Url.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  const publicKey = createPublicKey(match.pem);
  return verifySignature('sha256', Buffer.from(signedContent, 'utf8'), publicKey, signature);
}
