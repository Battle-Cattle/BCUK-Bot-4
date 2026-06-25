import { describe, it, expect, vi } from 'vitest';

// The module pulls in multer/config at import time; stub the surrounding deps so
// the pure helpers can be imported in isolation.
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../../shared/config', () => ({ SFX_FOLDER: '/app/sfx', SFX_MAX_FILE_MB: 10 }));
vi.mock('../csrf', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
vi.mock('../middleware', () => ({ requireMod: (_req: any, _res: any, next: any) => next() }));
vi.mock('../../db', () => ({ addSfxFile: vi.fn(), updateSfxFile: vi.fn(), deleteSfxFile: vi.fn() }));

import multer from 'multer';
import { detectAudioType, buildStoredName, handleUploadError } from './sfxFileUpload';

/** Minimal res stub capturing the redirect target. */
function makeRes() {
  return { redirect: vi.fn() } as any;
}

// ── detectAudioType ────────────────────────────────────────────────────────────

describe('detectAudioType', () => {
  it('detects MP3 by ID3 tag', () => {
    expect(detectAudioType(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]))).toBe('mp3');
  });

  it('detects MP3 by MPEG frame sync', () => {
    expect(detectAudioType(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
  });

  it('detects OGG by OggS signature', () => {
    expect(detectAudioType(Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00]))).toBe('ogg');
  });

  it('detects WAV by RIFF/WAVE signature', () => {
    expect(detectAudioType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]))).toBe('wav');
  });

  it('returns null for a RIFF container that is not WAVE', () => {
    const riffAvi = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
    expect(detectAudioType(riffAvi)).toBeNull();
  });

  it('returns null for unrecognised bytes', () => {
    expect(detectAudioType(Buffer.from('not audio at all'))).toBeNull();
  });

  it('returns null for a buffer that is too short', () => {
    expect(detectAudioType(Buffer.from([0x49]))).toBeNull();
  });
});

// ── buildStoredName ─────────────────────────────────────────────────────────────

describe('buildStoredName', () => {
  it('preserves a clean filename', () => {
    expect(buildStoredName('airhorn.mp3', 'mp3')).toBe('airhorn.mp3');
  });

  it('sanitises unsafe characters', () => {
    expect(buildStoredName('My Clap!.mp3', 'mp3')).toBe('My_Clap_.mp3');
  });

  it('strips any directory component (path traversal)', () => {
    expect(buildStoredName('../../etc/passwd.mp3', 'mp3')).toBe('passwd.mp3');
  });

  it('forces the extension to match the detected type', () => {
    expect(buildStoredName('clip.wav', 'mp3')).toBe('clip.mp3');
  });

  it('falls back to a default stem when nothing usable remains', () => {
    expect(buildStoredName('...', 'mp3')).toBe('sound.mp3');
  });
});

// ── handleUploadError ───────────────────────────────────────────────────────────

describe('handleUploadError', () => {
  it('returns false and does not redirect when there is no error', () => {
    const res = makeRes();
    expect(handleUploadError(null, res)).toBe(false);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects oversized files to file_too_large', () => {
    const res = makeRes();
    const err = new multer.MulterError('LIMIT_FILE_SIZE', 'sound');
    expect(handleUploadError(err, res)).toBe(true);
    expect(res.redirect).toHaveBeenCalledWith('/sfx?error=file_too_large');
  });

  it('redirects other multer/unknown errors to upload_failed', () => {
    const res = makeRes();
    expect(handleUploadError(new Error('boom'), res)).toBe(true);
    expect(res.redirect).toHaveBeenCalledWith('/sfx?error=upload_failed');
  });
});
