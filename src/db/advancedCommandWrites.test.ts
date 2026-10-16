import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./advancedCommands', () => ({
  addAdvancedCommand: vi.fn(),
  updateAdvancedCommand: vi.fn(),
  setAdvancedCommandEnabled: vi.fn(),
  removeAdvancedCommand: vi.fn(),
}));
vi.mock('./advancedCommandCache', () => ({ invalidateAdvancedCommandLookupCache: vi.fn() }));

import * as raw from './advancedCommands';
import { invalidateAdvancedCommandLookupCache } from './advancedCommandCache';
import { addAdvancedCommand, updateAdvancedCommand, setAdvancedCommandEnabled, removeAdvancedCommand } from './advancedCommandWrites';
import type { AdvancedCommandSettings } from './advancedCommandValidation';

const SETTINGS = { name: 'x' } as AdvancedCommandSettings;

beforeEach(() => vi.clearAllMocks());

describe('advanced command write wrappers', () => {
  it('invalidate the lookup cache after each successful write and pass results through', async () => {
    vi.mocked(raw.addAdvancedCommand).mockResolvedValue(5);
    vi.mocked(raw.updateAdvancedCommand).mockResolvedValue(true);
    vi.mocked(raw.setAdvancedCommandEnabled).mockResolvedValue(false);
    vi.mocked(raw.removeAdvancedCommand).mockResolvedValue(['a.png']);

    expect(await addAdvancedCommand(3, SETTINGS)).toBe(5);
    expect(await updateAdvancedCommand(3, 5, SETTINGS)).toBe(true);
    expect(await setAdvancedCommandEnabled(3, 5)).toBe(false);
    expect(await removeAdvancedCommand(3, 5)).toEqual(['a.png']);
    expect(invalidateAdvancedCommandLookupCache).toHaveBeenCalledTimes(4);
    expect(raw.setAdvancedCommandEnabled).toHaveBeenCalledWith(3, 5, undefined);
  });

  it('does not invalidate when the write fails', async () => {
    vi.mocked(raw.addAdvancedCommand).mockRejectedValue(new Error('boom'));
    await expect(addAdvancedCommand(3, SETTINGS)).rejects.toThrow('boom');
    expect(invalidateAdvancedCommandLookupCache).not.toHaveBeenCalled();
  });
});
