import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/**
 * Prefix of every stored token: `enc:<iv>.<tag>.<data>`. The format carries no key id on purpose:
 * every build since encryption was added reads it, so a deploy can always be rolled back without
 * making stored tokens unreadable. Key rotation works without one: a token is tried with the active
 * key, then the previous one (see {@link decryptToken}).
 */
const ENC_PREFIX = 'enc:';
// encryptToken always writes a full 16-byte GCM tag. Pinning the length on decrypt makes Node
// reject a truncated tag (which would otherwise verify against only its first few bytes).
const AUTH_TAG_LENGTH = 16;

/**
 * Validates and decodes the AES-256 key.
 * @param secret - 64-character hex string.
 * @returns The 32-byte key.
 * @throws If `secret` isn't exactly 64 hex characters.
 */
function parseKey(secret: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error('EVENTSUB_TOKEN_SECRET must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(secret, 'hex');
}

/**
 * Encrypts a plaintext string under the given (active) key.
 * @param plaintext - Token to encrypt.
 * @param secret - `EVENTSUB_TOKEN_SECRET`: a 64-character hex AES-256 key.
 * @returns `enc:` followed by the base64 IV, auth tag and ciphertext joined with dots.
 */
export function encryptToken(plaintext: string, secret: string): string {
  const key = parseKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${data.toString('base64')}`;
}

/**
 * Decrypts the `<iv>.<tag>.<data>` body of a token with one key.
 * @param body - The token after its `enc:` prefix.
 * @param secret - 64-character hex AES-256 key to try.
 * @returns The decrypted plaintext.
 * @throws If the body is malformed or fails GCM authentication under this key.
 */
function decryptBody(body: string, secret: string): string {
  const key = parseKey(secret);
  const parts = body.split('.');
  const [ivB64, tagB64, dataB64] = parts;
  if (parts.length !== 3 || !ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted token format');
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'), { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Decrypts a token produced by {@link encryptToken} with the active key, falling back to the
 * previous key during a rotation (GCM authentication tells a wrong key apart from the right one).
 * Throws if a plaintext token is encountered — the EventSub OAuth flow must be re-run to produce
 * an encrypted token.
 * @param stored - Token as stored in the DB, expected to start with `enc:`.
 * @param secret - `EVENTSUB_TOKEN_SECRET`: the active 64-character hex AES-256 key.
 * @param previousSecret - `EVENTSUB_TOKEN_SECRET_PREVIOUS`: the decrypt-only key from before a
 *   rotation, or empty/omitted when there is none.
 * @returns The decrypted plaintext token.
 * @throws If the token is plaintext or malformed, or no configured key decrypts it.
 */
export function decryptToken(stored: string, secret: string, previousSecret = ''): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    throw new Error(
      'Stored token is not encrypted. Re-run the EventSub OAuth flow to re-encrypt it.',
    );
  }
  const body = stored.slice(ENC_PREFIX.length);
  try {
    return decryptBody(body, secret);
  } catch (err) {
    if (!previousSecret) throw err;
    try {
      return decryptBody(body, previousSecret);
    } catch {
      throw new Error('Token could not be decrypted with EVENTSUB_TOKEN_SECRET or EVENTSUB_TOKEN_SECRET_PREVIOUS', { cause: err });
    }
  }
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
