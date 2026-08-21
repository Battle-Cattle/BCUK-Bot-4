import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const ENC_PREFIX = 'enc:';

function parseKey(secret: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error('EVENTSUB_TOKEN_SECRET must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(secret, 'hex');
}

/** Encrypts a plaintext string and returns a prefixed `enc:iv.tag.data` token. */
export function encryptToken(plaintext: string, secret: string): string {
  const key = parseKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${data.toString('base64')}`;
}

/**
 * Decrypts a token produced by encryptToken.
 * Throws if a plaintext token is encountered when a secret is available — the EventSub
 * OAuth flow must be re-run to produce an encrypted token.
 */
export function decryptToken(stored: string, secret: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    throw new Error(
      'Stored token is not encrypted. Re-run the EventSub OAuth flow to re-encrypt it.',
    );
  }
  const key = parseKey(secret);
  const [ivB64, tagB64, dataB64] = stored.slice(ENC_PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted token format');
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Generates a random hex secret and its SHA-256 hash, for the "store only the hash,
 * return the plaintext exactly once" pattern used by API keys, companion tokens, and
 * companion OAuth codes.
 * @param byteLength - Number of random bytes to generate before hex-encoding (default 32).
 * @returns The plaintext secret (hex-encoded) and its SHA-256 hash (hex-encoded).
 */
export function generateSecretAndHash(byteLength = 32): { secret: string; hash: string } {
  const secret = randomBytes(byteLength).toString('hex');
  const hash = createHash('sha256').update(secret).digest('hex');
  return { secret, hash };
}
