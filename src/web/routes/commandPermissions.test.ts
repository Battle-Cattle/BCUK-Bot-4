import { describe, it, expect, vi } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', async () => ({
  AccessLevel: ACCESS_LEVEL_MOCK,
  // The real rule, so these tests pin the page-side wrapper to it.
  isCommandSelfManageableBy: (await vi.importActual<typeof import('../../db/commandSelfService')>('../../db/commandSelfService')).isCommandSelfManageableBy,
}));

import { isCommandSelfManageable } from './commandPermissions';

const SELF = '111111111111111111';
const OTHER = '222222222222222222';

function command(overrides: Record<string, unknown> = {}): any {
  return {
    command_id: 1,
    trigger_string: '!hi',
    output: 'hi',
    is_discord_enabled: false,
    is_multi_twitch: false,
    assigned_users: [{ discord_id: SELF }],
    ...overrides,
  };
}

describe('isCommandSelfManageable', () => {
  it('is true for a Twitch-only command assigned to the streamer alone', () => {
    expect(isCommandSelfManageable(command(), SELF)).toBe(true);
  });

  it('is false when the command is shared with another channel', () => {
    expect(isCommandSelfManageable(command({ assigned_users: [{ discord_id: SELF }, { discord_id: OTHER }] }), SELF)).toBe(false);
  });

  it('is false when the command belongs to someone else or nobody', () => {
    expect(isCommandSelfManageable(command({ assigned_users: [{ discord_id: OTHER }] }), SELF)).toBe(false);
    expect(isCommandSelfManageable(command({ assigned_users: [] }), SELF)).toBe(false);
  });

  it('is false when the command is Discord-enabled or multi-Twitch', () => {
    expect(isCommandSelfManageable(command({ is_discord_enabled: true }), SELF)).toBe(false);
    expect(isCommandSelfManageable(command({ is_multi_twitch: true }), SELF)).toBe(false);
  });
});
