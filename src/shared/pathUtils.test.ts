import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { safeResolve, realPathWithin } from './pathUtils';

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

describe('realPathWithin', () => {
  // Real temp dirs: this is about how the filesystem resolves links. Directory links use the
  // 'junction' type, which Windows allows without elevated privileges (ignored on POSIX).
  let root: string;
  let base: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'realpath-within-')));
    base = path.join(root, 'assets');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(base, '5'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(base, '5', 'clip.png'), 'x');
    fs.writeFileSync(path.join(outside, 'clip.png'), 'secret');
    fs.symlinkSync(outside, path.join(base, '6'), 'junction'); // escapes base
    fs.symlinkSync(path.join(base, '5'), path.join(base, '7'), 'junction'); // stays inside base
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the real path of a regular file inside base', async () => {
    await expect(realPathWithin(base, path.join(base, '5', 'clip.png'))).resolves.toBe(path.join(base, '5', 'clip.png'));
  });

  it('returns null when a directory link under base points outside it', async () => {
    await expect(realPathWithin(base, path.join(base, '6', 'clip.png'))).resolves.toBeNull();
  });

  it('follows a link that stays inside base and returns its real target', async () => {
    await expect(realPathWithin(base, path.join(base, '7', 'clip.png'))).resolves.toBe(path.join(base, '5', 'clip.png'));
  });

  it('returns null for a missing file', async () => {
    await expect(realPathWithin(base, path.join(base, '5', 'missing.png'))).resolves.toBeNull();
  });

  it('returns null when base itself does not exist', async () => {
    await expect(realPathWithin(path.join(root, 'nope'), path.join(root, 'nope', 'clip.png'))).resolves.toBeNull();
  });

  it('returns null when the candidate is base itself', async () => {
    await expect(realPathWithin(base, base)).resolves.toBeNull();
  });

  it('rethrows filesystem errors other than a missing path', async () => {
    const err = Object.assign(new Error('denied'), { code: 'EACCES' });
    const spy = vi.spyOn(fs.promises, 'realpath').mockRejectedValueOnce(err);
    try {
      await expect(realPathWithin(base, path.join(base, '5', 'clip.png'))).rejects.toBe(err);
    } finally {
      spy.mockRestore();
    }
  });
});
