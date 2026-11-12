import path from 'path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/config', () => ({ OVERLAY_FOLDER: '/data/overlay' }));

import { resolveSharedVideoPath, SHARED_FOLDER } from './sharedOverlayVideoFiles';

describe('resolveSharedVideoPath', () => {
  it('resolves a plain filename inside the shared folder', () => {
    // path.resolve gives the platform's separators (and a drive letter on Windows).
    expect(resolveSharedVideoPath('a.webm')).toBe(path.resolve('/data/overlay', SHARED_FOLDER, 'a.webm'));
  });

  it.each(['', '../x.webm', 'a/b.webm', '..'])('refuses %j', (name) => {
    expect(resolveSharedVideoPath(name)).toBeNull();
  });
});
