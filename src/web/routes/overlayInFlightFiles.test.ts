import { describe, it, expect } from 'vitest';
import { isVideoFileInFlight, withInFlightVideoFile } from './overlayInFlightFiles';

describe('withInFlightVideoFile', () => {
  const location = { folder: '5', filename: 'a.webm' };

  it('marks the file in flight while the write runs and clears it once it resolves', async () => {
    let during = false;
    const result = await withInFlightVideoFile(location, async () => {
      during = isVideoFileInFlight(location);
      return 'done';
    });
    expect(result).toBe('done');
    expect(during).toBe(true);
    expect(isVideoFileInFlight(location)).toBe(false);
  });

  it('clears the mark when the write throws, and rethrows', async () => {
    await expect(withInFlightVideoFile(location, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(isVideoFileInFlight(location)).toBe(false);
  });

  it('keys by folder and filename together', async () => {
    await withInFlightVideoFile(location, async () => {
      expect(isVideoFileInFlight({ folder: 'library', filename: 'a.webm' })).toBe(false);
      expect(isVideoFileInFlight({ folder: '5', filename: 'b.webm' })).toBe(false);
    });
  });
});
