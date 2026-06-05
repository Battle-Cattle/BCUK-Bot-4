import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));

import { encryptToken, decryptToken } from './crypto';

const VALID_SECRET = 'a'.repeat(64); // 64 hex chars = 32 bytes

describe('encryptToken', () => {
  it('returns a string starting with enc:', () => {
    const token = encryptToken('hello', VALID_SECRET);
    expect(token).toMatch(/^enc:/);
  });

  it('produces three dot-separated base64 segments after the prefix', () => {
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
});
