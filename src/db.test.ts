import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('./db/pool', () => ({ getPool: vi.fn(), closePool: vi.fn() }));

vi.mock('./db/users', () => ({
  upsertUserRecord: vi.fn(),
  setTwitchBotEnabledRecord: vi.fn(),
  removeUserRecord: vi.fn(),
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
  ACCESS_LEVEL_LABELS: {},
  findUser: vi.fn(),
  findUserByTwitchName: vi.fn(),
  getAllUsers: vi.fn(),
  updateDiscordName: vi.fn(),
  getTwitchEnabledChannels: vi.fn(),
  updateAccessLevel: vi.fn(),
}));

vi.mock('./db/customCommandCache', () => ({
  invalidateCustomCommandLookupCache: vi.fn(),
  getCustomCommandForTwitchChannel: vi.fn(),
  getCustomCommandForDiscord: vi.fn(),
}));

vi.mock('./db/customCommands', () => ({
  getAllCustomCommandsWithAssignments: vi.fn(),
  addCustomCommand: vi.fn(),
  updateCustomCommand: vi.fn(),
  removeCustomCommand: vi.fn(),
  assignUserToCommand: vi.fn(),
  unassignUserFromCommand: vi.fn(),
}));

vi.mock('./db/commandLocks', () => ({
  CommandNotFoundError: class extends Error {},
  CommandConflictError: class extends Error {},
  isMysqlDuplicateEntryError: vi.fn(),
  isCustomCommandTriggerTaken: vi.fn(),
}));

vi.mock('./db/reservedCommands', () => ({
  ReservedCommandError: class extends Error {},
  RESERVED_BUILT_IN_COMMANDS: [],
}));

vi.mock('./db/counters', () => ({
  CounterNotFoundError: class extends Error {},
  getAllCounters: vi.fn(),
  addCounter: vi.fn(),
  updateCounter: vi.fn(),
  removeCounter: vi.fn(),
  resetCounterCurrentValue: vi.fn(),
  incrementCounter: vi.fn(),
  archiveAndResetYearlyCounters: vi.fn(),
}));

vi.mock('./db/counterCache', () => ({
  invalidateCounterLookupCache: vi.fn(),
  findCounterByCommand: vi.fn(),
  isCounterCommandTaken: vi.fn(),
}));

vi.mock('./db/streamMonitor', () => ({
  getStreamGroupsForGuild: vi.fn(),
  addStreamGroup: vi.fn(),
  updateStreamGroup: vi.fn(),
  removeStreamGroup: vi.fn(),
  getStreamersForGuild: vi.fn(),
  getAllStreamersWithGroups: vi.fn(),
  addStreamer: vi.fn(),
  removeStreamer: vi.fn(),
  removeStreamersByGroup: vi.fn(),
  setStreamerLive: vi.fn(),
  clearStreamerLive: vi.fn(),
}));

vi.mock('./db/eventSub', () => ({
  getAllEventSubStreamers: vi.fn(),
  getStreamerByDiscordId: vi.fn(),
  getStreamerById: vi.fn(),
  saveStreamerToken: vi.fn(),
  clearStreamerToken: vi.fn(),
  initEventConfig: vi.fn(),
  saveEventConfig: vi.fn(),
}));

vi.mock('./db/sfx', () => ({
  findTrigger: vi.fn(),
  findSoundFiles: vi.fn(),
  getAllSfxTriggers: vi.fn(),
  getPublicSfxTriggers: vi.fn(),
}));

vi.mock('./db/overlayVideos', () => ({
  getVideosForStreamer: vi.fn(),
  addVideo: vi.fn(),
  getVideoById: vi.fn(),
  deleteVideo: vi.fn(),
  getRewardsForStreamer: vi.fn(),
  upsertReward: vi.fn(),
  setRewardVideos: vi.fn(),
  deleteReward: vi.fn(),
  getVideosForReward: vi.fn(),
}));

vi.mock('./db/streamdeckKeys', () => ({
  hasApiKey: vi.fn(),
  createApiKeyAndRequestGuildAccess: vi.fn(),
  requestGuildAccessForExistingKey: vi.fn(),
  rotateApiKey: vi.fn(),
  findApprovedKeyByHash: vi.fn(),
  isKeyApprovedForGuild: vi.fn(),
  getApprovedGuildIdsForKey: vi.fn(),
  getGuildStatusForKey: vi.fn(),
  approveApiKey: vi.fn(),
  denyApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  getPendingRequests: vi.fn(),
  getAllApiKeys: vi.fn(),
}));

vi.mock('./db/lookupCache', () => ({
  createManagedLookupCache: vi.fn(),
}));

import { upsertUserRecord, setTwitchBotEnabledRecord, removeUserRecord } from './db/users';
import { invalidateCustomCommandLookupCache } from './db/customCommandCache';
import { upsertUser, updateTwitchBotEnabled, removeUser } from './db';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertUserRecord).mockResolvedValue(false);
  vi.mocked(setTwitchBotEnabledRecord).mockResolvedValue(undefined);
  vi.mocked(removeUserRecord).mockResolvedValue(undefined);
});

// ─── upsertUser ───────────────────────────────────────────────────────────────

describe('upsertUser', () => {
  it('calls invalidateCustomCommandLookupCache when twitchName is a non-null string', async () => {
    vi.mocked(upsertUserRecord).mockResolvedValue(true);
    await upsertUser('1', 'Alice', 0, 'alice_chan');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('calls invalidateCustomCommandLookupCache when twitchName is explicitly null', async () => {
    vi.mocked(upsertUserRecord).mockResolvedValue(true);
    await upsertUser('1', 'Alice', 0, null);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT call invalidateCustomCommandLookupCache when twitchName is omitted (undefined)', async () => {
    vi.mocked(upsertUserRecord).mockResolvedValue(false);
    await upsertUser('1', 'Alice', 0);
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });

  it('propagates errors from upsertUserRecord without calling invalidate', async () => {
    vi.mocked(upsertUserRecord).mockRejectedValue(new Error('DB error'));
    await expect(upsertUser('1', 'Alice', 0, 'alice')).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

// ─── updateTwitchBotEnabled ───────────────────────────────────────────────────

describe('updateTwitchBotEnabled', () => {
  it('always calls invalidateCustomCommandLookupCache on success', async () => {
    await updateTwitchBotEnabled('1', true);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('also calls invalidate when disabling', async () => {
    await updateTwitchBotEnabled('1', false);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors from setTwitchBotEnabledRecord', async () => {
    vi.mocked(setTwitchBotEnabledRecord).mockRejectedValue(new Error('DB error'));
    await expect(updateTwitchBotEnabled('1', true)).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

// ─── removeUser ───────────────────────────────────────────────────────────────

describe('removeUser', () => {
  it('always calls invalidateCustomCommandLookupCache on success', async () => {
    await removeUser('1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors from removeUserRecord', async () => {
    vi.mocked(removeUserRecord).mockRejectedValue(new Error('DB error'));
    await expect(removeUser('1')).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});
