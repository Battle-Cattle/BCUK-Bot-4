import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

// The module pulls in config at import time; stub the surrounding deps so
// the pure helpers can be imported in isolation.
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ UPLOAD_INCOMING_FOLDER: '/app/upload-incoming', SFX_FOLDER: '/app/sfx', SFX_MAX_FILE_MB: 10 }));
vi.mock('../csrf', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
vi.mock('../middleware', () => ({ requireMod: (_req: any, _res: any, next: any) => next() }));
vi.mock('../../db', () => ({ addSfxFile: vi.fn(), updateSfxFile: vi.fn(), deleteSfxFile: vi.fn() }));

import { buildStoredName } from './sfxFileUpload';

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
