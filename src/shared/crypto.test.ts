import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('./logger', () => ({ createLogger: mockLogger }));

import { encryptToken, decryptToken, generateSecretAndHash, needsReencryption, tokenKeyId } from './crypto';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const VALID_SECRET = 'a'.repeat(64); // 64 hex chars = 32 bytes

describe('encryptToken', () => {
  it('returns a string starting with enc:', () => {
    const token = encryptToken('hello', VALID_SECRET);
    expect(token).toMatch(/^enc:/);
  });

  it("writes the v2 format: the key's id, then three dot-separated base64 segments", () => {
    const token = encryptToken('hello', VALID_SECRET);
    expect(token.startsWith(`enc:v2:${tokenKeyId(VALID_SECRET)}.`)).toBe(true);
    const parts = token.slice(`enc:v2:${tokenKeyId(VALID_SECRET)}.`.length).split('.');
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(p.length).toBeGreaterThan(0));
  });

  it('produces different ciphertexts on repeated calls (random IV)', () => {
    const a = encryptToken('same-plaintext', VALID_SECRET);
    const b = encryptToken('same-plaintext', VALID_SECRET);
    expect(a).not.toBe(b);
  });

  it('throws when the secret is not 64 hex characters', () => {
    expect(() => encryptToken('x', 'tooshort')).toThrow('EVENTSUB_TOKEN_SECRET');
    expect(() => encryptToken('x', 'z'.repeat(64))).toThrow('EVENTSUB_TOKEN_SECRET');
  });
});

describe('decryptToken', () => {
  it('round-trips: decrypt(encrypt(x)) === x', () => {
    const plaintext = 'super-secret-oauth-token';
    const token = encryptToken(plaintext, VALID_SECRET);
    expect(decryptToken(token, VALID_SECRET)).toBe(plaintext);
  });

  it('handles unicode plaintext', () => {
    const plaintext = '日本語テスト🎉';
    const token = encryptToken(plaintext, VALID_SECRET);
    expect(decryptToken(token, VALID_SECRET)).toBe(plaintext);
  });

  it('throws on plaintext tokens (migration path removed — re-auth required)', () => {
    expect(() => decryptToken('plaintext-token', VALID_SECRET)).toThrow(
      'Stored token is not encrypted',
    );
  });

  it('throws on malformed encrypted token (missing parts)', () => {
    expect(() => decryptToken('enc:onlyonepart', VALID_SECRET)).toThrow('Invalid encrypted token format');
    expect(() => decryptToken('enc:v2:nodots', VALID_SECRET)).toThrow('Invalid encrypted token format');
    expect(() => decryptToken(`enc:v2:${tokenKeyId(VALID_SECRET)}.a.b`, VALID_SECRET)).toThrow('Invalid encrypted token format');
  });

  it('throws when decrypting with the wrong key (auth tag mismatch)', () => {
    const token = encryptToken('secret', VALID_SECRET);
    const wrongSecret = 'b'.repeat(64);
    expect(() => decryptToken(token, wrongSecret)).toThrow();
  });

  it('throws when the ciphertext is tampered', () => {
    const token = encryptToken('secret', VALID_SECRET);
    // Flip a character in the data segment
    const parts = token.split('.');
    parts[2] = parts[2]!.split('').reverse().join('');
    expect(() => decryptToken(parts.join('.'), VALID_SECRET)).toThrow();
  });
  it('rejects a truncated auth tag instead of verifying only its prefix', () => {
    const token = encryptToken('hello', VALID_SECRET);
    const [keyId, iv, tag, data] = token.slice('enc:v2:'.length).split('.');
    const shortTag = Buffer.from(tag!, 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptToken(`enc:v2:${keyId}.${iv}.${shortTag}.${data}`, VALID_SECRET)).toThrow();
    const legacy = legacyEncrypt('hello', VALID_SECRET);
    const [lIv, lTag, lData] = legacy.slice('enc:'.length).split('.');
    const lShort = Buffer.from(lTag!, 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptToken(`enc:${lIv}.${lShort}.${lData}`, VALID_SECRET)).toThrow();
  });
});

/** Encrypts in the legacy `enc:<iv>.<tag>.<data>` format, written before tokens carried a key id. */
function legacyEncrypt(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

describe('key rotation', () => {
  const OLD_KEY = 'b'.repeat(64);
  const NEW_KEY = 'c'.repeat(64);

  it('still decrypts a legacy enc: token with the key that wrote it', () => {
    expect(decryptToken(legacyEncrypt('legacy', NEW_KEY), NEW_KEY)).toBe('legacy');
  });

  it('decrypts a legacy token written under the previous key while it is configured', () => {
    expect(decryptToken(legacyEncrypt('legacy', OLD_KEY), NEW_KEY, OLD_KEY)).toBe('legacy');
    expect(() => decryptToken(legacyEncrypt('legacy', OLD_KEY), NEW_KEY)).toThrow();
  });

  it('decrypts a token written under the previous key while it is configured', () => {
    const token = encryptToken('rotated', OLD_KEY);
    expect(decryptToken(token, NEW_KEY, OLD_KEY)).toBe('rotated');
  });

  it("fails clearly once the previous key is removed, naming the token's key id", () => {
    const token = encryptToken('rotated', OLD_KEY);
    expect(() => decryptToken(token, NEW_KEY)).toThrow(`unknown key (id ${tokenKeyId(OLD_KEY)})`);
  });

  it('picks the key by id rather than trying each one', () => {
    const token = encryptToken('current', NEW_KEY);
    expect(decryptToken(token, NEW_KEY, OLD_KEY)).toBe('current');
    // Listing the keys the other way round still finds the right one.
    expect(decryptToken(token, OLD_KEY, NEW_KEY)).toBe('current');
  });

  it('gives each key a distinct, stable, short id that is not the key itself', () => {
    expect(tokenKeyId(OLD_KEY)).toBe(tokenKeyId(OLD_KEY));
    expect(tokenKeyId(OLD_KEY)).not.toBe(tokenKeyId(NEW_KEY));
    expect(tokenKeyId(OLD_KEY)).toMatch(/^[0-9a-f]{16}$/);
    expect(OLD_KEY).not.toContain(tokenKeyId(OLD_KEY));
  });

  it('flags legacy tokens and tokens under another key for re-encryption, not current ones', () => {
    expect(needsReencryption(encryptToken('x', NEW_KEY), NEW_KEY)).toBe(false);
    expect(needsReencryption(encryptToken('x', OLD_KEY), NEW_KEY)).toBe(true);
    expect(needsReencryption(legacyEncrypt('x', NEW_KEY), NEW_KEY)).toBe(true);
  });
});

describe('generateSecretAndHash', () => {
  it('returns a hex secret matching its SHA-256 hash', () => {
    const { secret, hash } = generateSecretAndHash();
    expect(secret).toMatch(/^[0-9a-f]+$/);
    expect(hash).toBe(createHash('sha256').update(secret).digest('hex'));
  });

  it('defaults to 32 bytes (64 hex characters)', () => {
    const { secret } = generateSecretAndHash();
    expect(secret).toHaveLength(64);
  });

  it('honors a custom byte length', () => {
    const { secret } = generateSecretAndHash(24);
    expect(secret).toHaveLength(48);
  });

  it('produces different secrets on repeated calls', () => {
    const a = generateSecretAndHash();
    const b = generateSecretAndHash();
    expect(a.secret).not.toBe(b.secret);
  });
});
