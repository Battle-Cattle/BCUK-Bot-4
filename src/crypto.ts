import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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

/** Decrypts a token produced by encryptToken. Returns plaintext values unchanged (migration path). */
export function decryptToken(stored: string, secret: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const key = parseKey(secret);
  const [ivB64, tagB64, dataB64] = stored.slice(ENC_PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted token format');
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
