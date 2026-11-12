import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/config', () => ({ OVERLAY_FOLDER: '/data/overlay' }));
import { resolveSharedVideoPath, SHARED_FOLDER } from './sharedOverlayVideoFiles';

describe('resolveSharedVideoPath', () => {
  it('resolves a plain filename inside the shared folder', () => {
    expect(resolveSharedVideoPath('a.webm')).toBe(`/data/overlay/${SHARED_FOLDER}/a.webm`);
  });

  it.each(['', '../x.webm', 'a/b.webm', '..'])('refuses %j', (name) => {
    expect(resolveSharedVideoPath(name)).toBeNull();
  });
});
