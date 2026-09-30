import { describe, it, expect } from 'vitest';
import { isCommandSelfManageableBy } from './commandSelfService';

const SELF = '111111111111111111';
const OTHER = '222222222222222222';
const TWITCH_ONLY = { is_discord_enabled: false, is_multi_twitch: false };

describe('isCommandSelfManageableBy', () => {
  it('is true for a Twitch-only command assigned to the streamer alone', () => {
    expect(isCommandSelfManageableBy(TWITCH_ONLY, [SELF], SELF)).toBe(true);
  });

  it('is false when the command is shared, belongs to someone else, or has no assignees', () => {
    expect(isCommandSelfManageableBy(TWITCH_ONLY, [SELF, OTHER], SELF)).toBe(false);
    expect(isCommandSelfManageableBy(TWITCH_ONLY, [OTHER], SELF)).toBe(false);
    expect(isCommandSelfManageableBy(TWITCH_ONLY, [], SELF)).toBe(false);
  });

  it('is false when the command is Discord-enabled or multi-Twitch', () => {
    expect(isCommandSelfManageableBy({ ...TWITCH_ONLY, is_discord_enabled: true }, [SELF], SELF)).toBe(false);
    expect(isCommandSelfManageableBy({ ...TWITCH_ONLY, is_multi_twitch: true }, [SELF], SELF)).toBe(false);
  });
});
