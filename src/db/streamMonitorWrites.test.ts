import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./streamMonitor', () => ({
  addStreamer: vi.fn(),
  removeStreamer: vi.fn(),
  removeStreamGroupAndStreamers: vi.fn(),
}));
vi.mock('./streamerIdCache', () => ({ invalidateStreamerIdLookupCache: vi.fn() }));

import {
  addStreamer as addStreamerRecord,
  removeStreamer as removeStreamerRecord,
  removeStreamGroupAndStreamers as removeStreamGroupAndStreamersRecord,
} from './streamMonitor';
import { invalidateStreamerIdLookupCache } from './streamerIdCache';
import { addStreamer, removeStreamer, removeStreamGroupAndStreamers } from './streamMonitorWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(addStreamerRecord).mockResolvedValue(undefined);
  vi.mocked(removeStreamerRecord).mockResolvedValue(true);
  vi.mocked(removeStreamGroupAndStreamersRecord).mockResolvedValue(true);
});

describe('addStreamer', () => {
  it('inserts the streamer and invalidates the streamer-ID cache', async () => {
    await addStreamer('111', 5, 'guild-1');
    expect(addStreamerRecord).toHaveBeenCalledWith('111', 5, 'guild-1');
    expect(invalidateStreamerIdLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without invalidating', async () => {
    vi.mocked(addStreamerRecord).mockRejectedValue(new Error('Stream group 5 does not belong to guild guild-1'));
    await expect(addStreamer('111', 5, 'guild-1')).rejects.toThrow('does not belong');
    expect(invalidateStreamerIdLookupCache).not.toHaveBeenCalled();
  });
});

describe.each([
  ['removeStreamer', removeStreamer, removeStreamerRecord],
  ['removeStreamGroupAndStreamers', removeStreamGroupAndStreamers, removeStreamGroupAndStreamersRecord],
])('%s', (_name, wrapper, record) => {
  it('deletes, invalidates the streamer-ID cache and returns the underlying result', async () => {
    vi.mocked(record).mockResolvedValue(false);
    expect(await wrapper(3, 'guild-1')).toBe(false);
    expect(record).toHaveBeenCalledWith(3, 'guild-1');
    expect(invalidateStreamerIdLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without invalidating', async () => {
    vi.mocked(record).mockRejectedValue(new Error('DB error'));
    await expect(wrapper(3, 'guild-1')).rejects.toThrow('DB error');
    expect(invalidateStreamerIdLookupCache).not.toHaveBeenCalled();
  });
});
