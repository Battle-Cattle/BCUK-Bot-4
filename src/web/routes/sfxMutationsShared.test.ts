import { describe, it, expect, vi, beforeEach } from 'vitest';

// A single shared logger instance (rather than test-utils/loggerMock's per-call factory) so the
// test can capture the same `log` reference that sfxMutationsShared.ts's module-level
// `const log = createLogger('Web')` receives, and assert on it.
vi.mock('../../shared/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { createLogger: () => logger };
});

vi.mock('../../shared/config', () => ({
  SFX_FOLDER: '/app/sfx',
}));

vi.mock('fs', () => ({
  default: {
    promises: {
      rm: vi.fn(),
    },
  },
}));

import fs from 'fs';
import { createLogger } from '../../shared/logger';
import { removeSfxFiles } from './sfxMutationsShared';

const sharedLog = createLogger('Web');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
});

describe('removeSfxFiles', () => {
  it('removes every file when all succeed', async () => {
    await removeSfxFiles(['a.mp3', 'b.mp3']);

    expect(fs.promises.rm).toHaveBeenCalledTimes(2);
    expect(fs.promises.rm).toHaveBeenCalledWith('/app/sfx/a.mp3', { force: true });
    expect(fs.promises.rm).toHaveBeenCalledWith('/app/sfx/b.mp3', { force: true });
    expect(sharedLog.error).not.toHaveBeenCalled();
  });

  it('still removes the other files and logs when one removal fails', async () => {
    vi.mocked(fs.promises.rm)
      .mockRejectedValueOnce(new Error('disk error'))
      .mockResolvedValueOnce(undefined);

    await removeSfxFiles(['bad.mp3', 'good.mp3']);

    expect(fs.promises.rm).toHaveBeenCalledTimes(2);
    expect(sharedLog.error).toHaveBeenCalledWith('Failed to remove SFX file bad.mp3:', expect.any(Error));
  });

  it('resolves without throwing even when every removal fails', async () => {
    vi.mocked(fs.promises.rm).mockRejectedValue(new Error('disk error'));

    await expect(removeSfxFiles(['a.mp3', 'b.mp3'])).resolves.toBeUndefined();
    expect(sharedLog.error).toHaveBeenCalledTimes(2);
  });

  it('skips an unsafe (path-traversal) filename without calling rm or logging', async () => {
    await removeSfxFiles(['../../etc/passwd']);

    expect(fs.promises.rm).not.toHaveBeenCalled();
    expect(sharedLog.error).not.toHaveBeenCalled();
  });

  it('runs removals concurrently rather than one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(fs.promises.rm).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
    });

    await removeSfxFiles(['a.mp3', 'b.mp3', 'c.mp3']);

    expect(maxInFlight).toBeGreaterThan(1);
  });
});
