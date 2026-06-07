import { describe, it, expect } from 'vitest';
import path from 'path';
import { safeResolve } from './pathUtils';

const posix = path.posix;

describe('safeResolve', () => {
  const base = '/srv/files';

  it('returns the resolved path for a safe single segment', () => {
    expect(safeResolve(base, 'audio.mp3')).toBe('/srv/files/audio.mp3');
  });

  it('returns the resolved path for a safe nested path', () => {
    expect(safeResolve(base, 'sfx', 'effects', 'bang.wav')).toBe('/srv/files/sfx/effects/bang.wav');
  });

  it('returns null for a path that escapes base via ..', () => {
    expect(safeResolve(base, '../secret.txt')).toBeNull();
  });

  it('returns null for a deeply nested traversal', () => {
    expect(safeResolve(base, 'a', '../../etc/passwd')).toBeNull();
  });

  it('returns the base path itself when no parts given', () => {
    expect(safeResolve(base)).toBe(posix.resolve(base));
  });

  it('returns null for an absolute path that is outside base', () => {
    expect(safeResolve(base, '/etc/passwd')).toBeNull();
  });

  it('returns the path when it exactly equals the base', () => {
    // path.relative(base, base) is '' which does not start with '..'
    const result = safeResolve(base, '.');
    expect(result).toBe(posix.resolve(base));
  });

  it('handles a base without trailing slash', () => {
    expect(safeResolve('/srv/files', 'ok.mp3')).toBe('/srv/files/ok.mp3');
  });

  it('handles a base with a trailing slash', () => {
    expect(safeResolve('/srv/files/', 'ok.mp3')).toBe('/srv/files/ok.mp3');
  });

  it('returns the correct path for a file with spaces in name', () => {
    expect(safeResolve(base, 'my sound.mp3')).toBe('/srv/files/my sound.mp3');
  });

  it('returns null when joining results in a sibling directory', () => {
    // /srv/files + ../otherfolder/x would be /srv/otherfolder/x — outside base
    expect(safeResolve('/srv/files', '../otherfolder/x')).toBeNull();
  });
});
