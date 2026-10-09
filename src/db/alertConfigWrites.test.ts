import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./alertConfig', () => ({
  initAlertConfigs: vi.fn(),
  saveAlertConfig: vi.fn(),
  setAlertImage: vi.fn(),
  setAlertSound: vi.fn(),
}));
vi.mock('./alertConfigCache', () => ({ invalidateAlertConfigLookupCache: vi.fn() }));

import {
  initAlertConfigs as initAlertConfigsRecord,
  saveAlertConfig as saveAlertConfigRecord,
  setAlertImage as setAlertImageRecord,
  setAlertSound as setAlertSoundRecord,
} from './alertConfig';
import { invalidateAlertConfigLookupCache } from './alertConfigCache';
import { initAlertConfigs, saveAlertConfig, setAlertImage, setAlertSound } from './alertConfigWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(initAlertConfigsRecord).mockResolvedValue(undefined);
  vi.mocked(saveAlertConfigRecord).mockResolvedValue(undefined);
  vi.mocked(setAlertImageRecord).mockResolvedValue(null);
  vi.mocked(setAlertSoundRecord).mockResolvedValue(null);
});

// ─── Alert config write wrappers ───────────────────────────────────────────────
//
// alertConfig.ts is a pure DB layer with no cache knowledge; these tests verify
// these wrappers invalidate the alert config lookup cache after each write.

describe('initAlertConfigs', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await initAlertConfigs(3);
    expect(initAlertConfigsRecord).toHaveBeenCalledWith(3);
    expect(invalidateAlertConfigLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without calling invalidate', async () => {
    vi.mocked(initAlertConfigsRecord).mockRejectedValue(new Error('DB error'));
    await expect(initAlertConfigs(3)).rejects.toThrow('DB error');
    expect(invalidateAlertConfigLookupCache).not.toHaveBeenCalled();
  });
});

describe('saveAlertConfig', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    const config = { enabled: true, message_template: 'hi', duration_ms: 5000, text_animation: 'none' as const };
    await saveAlertConfig(1, 'follow', config);
    expect(saveAlertConfigRecord).toHaveBeenCalledWith(1, 'follow', config);
    expect(invalidateAlertConfigLookupCache).toHaveBeenCalledOnce();
  });
});

describe('setAlertImage', () => {
  it('calls the record function, returns its value, and invalidates the cache on success', async () => {
    vi.mocked(setAlertImageRecord).mockResolvedValue('old.png');
    const result = await setAlertImage(1, 'follow', 'new.png');
    expect(result).toBe('old.png');
    expect(setAlertImageRecord).toHaveBeenCalledWith(1, 'follow', 'new.png');
    expect(invalidateAlertConfigLookupCache).toHaveBeenCalledOnce();
  });
});

describe('setAlertSound', () => {
  it('calls the record function, returns its value, and invalidates the cache on success', async () => {
    vi.mocked(setAlertSoundRecord).mockResolvedValue('old.mp3');
    const result = await setAlertSound(1, 'follow', 'new.mp3');
    expect(result).toBe('old.mp3');
    expect(setAlertSoundRecord).toHaveBeenCalledWith(1, 'follow', 'new.mp3');
    expect(invalidateAlertConfigLookupCache).toHaveBeenCalledOnce();
  });
});
