import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  AccessLevel: ACCESS_LEVEL_MOCK,
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
}));

import { canManageCatalog, isAssignedTo, resolveNewAssignees } from './selfServiceAccess';
import { findUser, getMemberAccessLevel } from '../../db';

const SELF = '111111111111111111';
const OTHER = '222222222222222222';
const STREAMER_ID = SELF;
const OTHER_ID = OTHER;
const THIRD_ID = '333333333333333333';
const GUILD_ID = '900000000000000001';

function entry(overrides: Record<string, unknown> = {}): any {
  return { assigned_users: [{ discord_id: SELF }], ...overrides };
}

function reqWithLevel(accessLevel?: number): any {
  return { session: { user: accessLevel === undefined ? undefined : { discordId: SELF, accessLevel } } };
}

function req(accessLevel: number, body: Record<string, unknown> = {}): any {
  return { body, session: { user: { discordId: STREAMER_ID, accessLevel, currentGuildId: GUILD_ID } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
});

describe('canManageCatalog', () => {
  it('is true for Mod and above', () => {
    expect(canManageCatalog(reqWithLevel(ACCESS_LEVEL_MOCK.MOD))).toBe(true);
    expect(canManageCatalog(reqWithLevel(ACCESS_LEVEL_MOCK.ADMIN))).toBe(true);
  });

  it('is false for a plain user or no session user', () => {
    expect(canManageCatalog(reqWithLevel(ACCESS_LEVEL_MOCK.USER))).toBe(false);
    expect(canManageCatalog(reqWithLevel())).toBe(false);
  });
});

describe('isAssignedTo', () => {
  it('is true only when the user is among the assignees', () => {
    const shared = entry({ assigned_users: [{ discord_id: OTHER }, { discord_id: SELF }] });
    expect(isAssignedTo(shared, SELF)).toBe(true);
    expect(isAssignedTo(entry({ assigned_users: [{ discord_id: OTHER }] }), SELF)).toBe(false);
  });
});

describe('resolveNewAssignees', () => {
  it('checks every submitted discord_id for membership of the current guild', async () => {
    await expect(resolveNewAssignees(req(ACCESS_LEVEL_MOCK.MOD, { discord_ids: [OTHER_ID, THIRD_ID] })))
      .resolves.toEqual({ discordIds: [OTHER_ID, THIRD_ID] });
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, OTHER_ID);
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, THIRD_ID);
  });

  it('returns assignee_not_in_guild when a Mod submits a discord_id outside the current guild', async () => {
    vi.mocked(getMemberAccessLevel).mockImplementation(async (_guildId, id) => (id === THIRD_ID ? null : 0));
    await expect(resolveNewAssignees(req(ACCESS_LEVEL_MOCK.MOD, { discord_ids: [OTHER_ID, THIRD_ID] })))
      .resolves.toEqual({ error: 'assignee_not_in_guild' });
  });

  it('skips the membership lookup when a Mod submits no discord_ids', async () => {
    await expect(resolveNewAssignees(req(ACCESS_LEVEL_MOCK.MOD))).resolves.toEqual({ discordIds: [] });
    expect(getMemberAccessLevel).not.toHaveBeenCalled();
  });

  it('uses the submitted discord_ids for a Mod', async () => {
    expect(await resolveNewAssignees(req(ACCESS_LEVEL_MOCK.MOD, { discord_ids: [OTHER_ID] }))).toEqual({ discordIds: [OTHER_ID] });
    expect(findUser).not.toHaveBeenCalled();
  });

  it("assigns a streamer's new entry to themselves only, ignoring discord_ids", async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: 'streamer' } as any);
    expect(await resolveNewAssignees(req(ACCESS_LEVEL_MOCK.USER, { discord_ids: [OTHER_ID] }))).toEqual({ discordIds: [STREAMER_ID] });
  });

  it('returns twitch_not_linked for a streamer without a Twitch account', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: null } as any);
    expect(await resolveNewAssignees(req(ACCESS_LEVEL_MOCK.USER))).toEqual({ error: 'twitch_not_linked' });
  });
});
