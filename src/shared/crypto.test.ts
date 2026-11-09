import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('./logger', () => ({ createLogger: mockLogger }));

import { encryptToken, decryptToken, generateSecretAndHash } from './crypto';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VALID_SECRET = 'a'.repeat(64); // 64 hex chars = 32 bytes

describe('encryptToken', () => {
  it('returns a string starting with enc:', () => {
    const token = encryptToken('hello', VALID_SECRET);
    expect(token).toMatch(/^enc:/);
  });

  it('produces three dot-separated base64 segments after the prefix (no key id, so every build reads it)', () => {
    const token = encryptToken('hello', VALID_SECRET);
    const parts = token.slice('enc:'.length).split('.');
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
    expect(() => decryptToken('enc:a.b.c.d', VALID_SECRET)).toThrow('Invalid encrypted token format');
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
    const [iv, tag, data] = token.slice('enc:'.length).split('.');
    const shortTag = Buffer.from(tag!, 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptToken(`enc:${iv}.${shortTag}.${data}`, VALID_SECRET)).toThrow();
    // Still rejected when a previous key is configured too.
    expect(() => decryptToken(`enc:${iv}.${shortTag}.${data}`, VALID_SECRET, 'b'.repeat(64))).toThrow();
  });
});

/**
 * Encrypts the way the code before key rotation did, to pin that its tokens still decrypt (and
 * that what is written now is the same format, so an older build can read it after a rollback).
 */
function preRotationEncrypt(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

/** Decrypts the way the code before key rotation did: one key, no fallback. */
function preRotationDecrypt(stored: string, secret: string): string {
  const [iv, tag, data] = stored.slice('enc:'.length).split('.');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), Buffer.from(iv!, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tag!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data!, 'base64')), decipher.final()]).toString('utf8');
}

describe('key rotation', () => {
  const OLD_KEY = 'b'.repeat(64);
  const NEW_KEY = 'c'.repeat(64);

  it('still decrypts a token written before key rotation existed', () => {
    expect(decryptToken(preRotationEncrypt('legacy', NEW_KEY), NEW_KEY)).toBe('legacy');
  });

  it('writes tokens an older build can still read, so a rollback keeps them usable', () => {
    expect(preRotationDecrypt(encryptToken('current', NEW_KEY), NEW_KEY)).toBe('current');
  });

  it('decrypts a token written under the previous key while it is configured', () => {
    expect(decryptToken(encryptToken('rotated', OLD_KEY), NEW_KEY, OLD_KEY)).toBe('rotated');
  });

  it('prefers the active key when both are configured', () => {
    expect(decryptToken(encryptToken('current', NEW_KEY), NEW_KEY, OLD_KEY)).toBe('current');
  });

  it('fails clearly once the previous key is removed or when neither key fits', () => {
    const token = encryptToken('rotated', OLD_KEY);
    expect(() => decryptToken(token, NEW_KEY)).toThrow();
    expect(() => decryptToken(token, NEW_KEY, 'd'.repeat(64))).toThrow(
      'Token could not be decrypted with EVENTSUB_TOKEN_SECRET or EVENTSUB_TOKEN_SECRET_PREVIOUS',
    );
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
