import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const ENC_PREFIX = 'enc:';
/**
 * Prefix of the current format, `enc:v2:<keyId>.<iv>.<tag>.<data>`. The key id says which key
 * wrote the token, so `EVENTSUB_TOKEN_SECRET` can be rotated: tokens written under the previous key
 * keep decrypting (with `EVENTSUB_TOKEN_SECRET_PREVIOUS`) until they are re-encrypted. A bare
 * `enc:<iv>.<tag>.<data>` is the legacy format, written before key ids existed.
 */
const ENC_V2_PREFIX = 'enc:v2:';
// encryptToken always writes a full 16-byte GCM tag. Pinning the length on decrypt makes Node
// reject a truncated tag (which would otherwise verify against only its first few bytes).
const AUTH_TAG_LENGTH = 16;
/** Hex characters of the key's hash kept as its id: enough to tell keys apart, nothing more. */
const KEY_ID_LENGTH = 16;

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
 * Derives the short id stored with every token a key encrypts: a truncated SHA-256 of the key
 * bytes, so no extra config is needed and the id reveals nothing usable about the key.
 * @param secret - 64-character hex AES-256 key.
 * @returns The key's id, {@link KEY_ID_LENGTH} hex characters.
 */
export function tokenKeyId(secret: string): string {
  return createHash('sha256').update(parseKey(secret)).digest('hex').slice(0, KEY_ID_LENGTH);
}

/**
 * Encrypts a plaintext string under the given (active) key.
 * @param plaintext - Token to encrypt.
 * @param secret - `EVENTSUB_TOKEN_SECRET`: a 64-character hex AES-256 key.
 * @returns `enc:v2:` followed by the key id and the base64 IV, auth tag and ciphertext, joined with dots.
 */
export function encryptToken(plaintext: string, secret: string): string {
  const key = parseKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_V2_PREFIX}${tokenKeyId(secret)}.${iv.toString('base64')}.${tag.toString('base64')}.${data.toString('base64')}`;
}

/**
 * Decrypts the `<iv>.<tag>.<data>` body of a token with one key.
 * @param body - The token after its prefix (and key id, for the v2 format).
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
 * Decrypts a token produced by {@link encryptToken}, choosing the key by the token's key id. A
 * legacy `enc:` token (no key id) is tried with the active key, then the previous one.
 * Throws if a plaintext token is encountered — the EventSub OAuth flow must be re-run to produce
 * an encrypted token.
 * @param stored - Token as stored in the DB, expected to start with `enc:`.
 * @param secret - `EVENTSUB_TOKEN_SECRET`: the active 64-character hex AES-256 key.
 * @param previousSecret - `EVENTSUB_TOKEN_SECRET_PREVIOUS`: the decrypt-only key from before a
 *   rotation, or empty/omitted when there is none.
 * @returns The decrypted plaintext token.
 * @throws If the token is plaintext or malformed, names a key that isn't configured, or fails
 *   authentication.
 */
export function decryptToken(stored: string, secret: string, previousSecret = ''): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    throw new Error(
      'Stored token is not encrypted. Re-run the EventSub OAuth flow to re-encrypt it.',
    );
  }
  const secrets = previousSecret ? [secret, previousSecret] : [secret];
  if (stored.startsWith(ENC_V2_PREFIX)) {
    const rest = stored.slice(ENC_V2_PREFIX.length);
    const dot = rest.indexOf('.');
    if (dot === -1) throw new Error('Invalid encrypted token format');
    const keyId = rest.slice(0, dot);
    const match = secrets.find((candidate) => tokenKeyId(candidate) === keyId);
    if (!match) {
      throw new Error(`Token was encrypted with an unknown key (id ${keyId}); set it as EVENTSUB_TOKEN_SECRET_PREVIOUS or reconnect`);
    }
    return decryptBody(rest.slice(dot + 1), match);
  }
  return decryptLegacy(stored.slice(ENC_PREFIX.length), secrets);
}

/**
 * Decrypts a legacy (key-id-less) token body by trying each configured key in turn.
 * @param body - The token after its `enc:` prefix.
 * @param secrets - Active key first, then the previous one if configured.
 * @returns The decrypted plaintext.
 * @throws The last key's error if no key decrypts it.
 */
function decryptLegacy(body: string, secrets: readonly string[]): string {
  let lastError: unknown;
  for (const candidate of secrets) {
    try {
      return decryptBody(body, candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Tells whether a stored token should be rewritten under the active key: true for a legacy `enc:`
 * token and for a v2 token written under any other key. Doesn't decrypt or validate it.
 * @param stored - Token as stored in the DB.
 * @param secret - `EVENTSUB_TOKEN_SECRET`: the active 64-character hex AES-256 key.
 * @returns Whether the token isn't already in the v2 format under `secret`.
 */
export function needsReencryption(stored: string, secret: string): boolean {
  return !stored.startsWith(`${ENC_V2_PREFIX}${tokenKeyId(secret)}.`);
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
