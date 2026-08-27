import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from './test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from './test-utils/accessLevelMock';

/** Mocks the shared logger so `db.ts`'s log calls don't produce real output during tests. */
vi.mock('./shared/logger', () => ({ createLogger: mockLogger }));
/** Mocks the DB connection pool so no real MySQL connection is attempted during tests. */
vi.mock('./db/pool', () => ({ getPool: vi.fn(), closePool: vi.fn() }));

vi.mock('./db/users', () => ({
  upsertUserRecord: vi.fn(),
  setTwitchBotEnabledRecord: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
  ACCESS_LEVEL_LABELS: {},
  findUser: vi.fn(),
  findUserByTwitchName: vi.fn(),
  findOwnerUser: vi.fn(),
  getAllUsers: vi.fn(),
  updateDiscordName: vi.fn(),
  getTwitchEnabledChannels: vi.fn(),
  getAllTwitchLinkedUsers: vi.fn(),
}));

vi.mock('./db/customCommandCache', () => ({
  invalidateCustomCommandLookupCache: vi.fn(),
  getCustomCommandForTwitchChannel: vi.fn(),
  getCustomCommandForDiscord: vi.fn(),
}));

vi.mock('./db/guildCommandOverrides', () => ({
  getOverridesForGuild: vi.fn(),
  getAllOverrides: vi.fn(),
  upsertOverride: vi.fn(),
  removeOverride: vi.fn(),
}));

vi.mock('./db/customCommands', () => ({
  getAllCustomCommandsWithAssignments: vi.fn(),
  getCustomCommandCount: vi.fn(),
  addCustomCommand: vi.fn(),
  updateCustomCommand: vi.fn(),
  removeCustomCommand: vi.fn(),
  assignUserToCommand: vi.fn(),
  assignUsersToCommand: vi.fn(),
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
  getCounterCount: vi.fn(),
  getCounterHistory: vi.fn(),
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
  getStreamersForGuild: vi.fn(),
  getAllStreamersWithGroups: vi.fn(),
  addStreamer: vi.fn(),
  removeStreamer: vi.fn(),
  removeStreamGroupAndStreamers: vi.fn(),
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
  getSfxTriggerCount: vi.fn(),
  getPublicSfxTriggers: vi.fn(),
  getAllCategories: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  deleteCategory: vi.fn(),
  getSfxFileById: vi.fn(),
  createSfxTrigger: vi.fn(),
  updateSfxTrigger: vi.fn(),
  deleteSfxTrigger: vi.fn(),
  addSfxFile: vi.fn(),
  updateSfxFile: vi.fn(),
  deleteSfxFile: vi.fn(),
}));

vi.mock('./db/sfxCache', () => ({
  invalidateSfxLookupCache: vi.fn(),
  findCachedSfxTrigger: vi.fn(),
}));

vi.mock('./db/alertConfig', () => ({
  ALERT_EVENT_TYPES: [],
  ALERT_TEXT_ANIMATIONS: [],
  getAlertConfigsForStreamer: vi.fn(),
  getAlertConfig: vi.fn(),
  getEnabledAlertEventTypesBatch: vi.fn(),
  initAlertConfigs: vi.fn(),
  saveAlertConfig: vi.fn(),
  setAlertImage: vi.fn(),
  setAlertSound: vi.fn(),
}));

vi.mock('./db/alertConfigCache', () => ({
  invalidateAlertConfigLookupCache: vi.fn(),
  findCachedAlertConfig: vi.fn(),
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
  findKeyByHash: vi.fn(),
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
  DEFAULT_CACHE_TTL_MS: 300_000,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS: 5_000,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS: 60_000,
}));

import { upsertUserRecord, setTwitchBotEnabledRecord } from './db/users';
import { invalidateCustomCommandLookupCache } from './db/customCommandCache';
import { upsertOverride as upsertOverrideRecord, removeOverride as removeOverrideRecord } from './db/guildCommandOverrides';
import {
  addCustomCommand as addCustomCommandRecord,
  updateCustomCommand as updateCustomCommandRecord,
  removeCustomCommand as removeCustomCommandRecord,
  assignUserToCommand as assignUserToCommandRecord,
  assignUsersToCommand as assignUsersToCommandRecord,
  unassignUserFromCommand as unassignUserFromCommandRecord,
} from './db/customCommands';
import { invalidateCounterLookupCache } from './db/counterCache';
import {
  addCounter as addCounterRecord,
  updateCounter as updateCounterRecord,
  removeCounter as removeCounterRecord,
  resetCounterCurrentValue as resetCounterCurrentValueRecord,
  incrementCounter as incrementCounterRecord,
  archiveAndResetYearlyCounters as archiveAndResetYearlyCountersRecord,
} from './db/counters';
import { invalidateAlertConfigLookupCache } from './db/alertConfigCache';
import {
  initAlertConfigs as initAlertConfigsRecord,
  saveAlertConfig as saveAlertConfigRecord,
  setAlertImage as setAlertImageRecord,
  setAlertSound as setAlertSoundRecord,
} from './db/alertConfig';
import { invalidateSfxLookupCache } from './db/sfxCache';
import {
  createSfxTrigger as createSfxTriggerRecord,
  updateSfxTrigger as updateSfxTriggerRecord,
  deleteSfxTrigger as deleteSfxTriggerRecord,
  addSfxFile as addSfxFileRecord,
  updateSfxFile as updateSfxFileRecord,
  deleteSfxFile as deleteSfxFileRecord,
} from './db/sfx';
import {
  upsertUser, updateTwitchBotEnabled, upsertOverride, removeOverride,
  addCustomCommand, updateCustomCommand, removeCustomCommand,
  assignUserToCommand, assignUsersToCommand, unassignUserFromCommand,
  addCounter, updateCounter, removeCounter, resetCounterCurrentValue,
  incrementCounter, archiveAndResetYearlyCounters,
  initAlertConfigs, saveAlertConfig, setAlertImage, setAlertSound,
  createSfxTrigger, updateSfxTrigger, deleteSfxTrigger,
  addSfxFile, updateSfxFile, deleteSfxFile,
  pingDb,
} from './db';
import { getPool } from './db/pool';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertUserRecord).mockResolvedValue(false);
  vi.mocked(setTwitchBotEnabledRecord).mockResolvedValue(undefined);
  vi.mocked(upsertOverrideRecord).mockResolvedValue(undefined);
  vi.mocked(removeOverrideRecord).mockResolvedValue(undefined);
  vi.mocked(addCustomCommandRecord).mockResolvedValue(1);
  vi.mocked(updateCustomCommandRecord).mockResolvedValue(undefined);
  vi.mocked(removeCustomCommandRecord).mockResolvedValue(undefined);
  vi.mocked(assignUserToCommandRecord).mockResolvedValue(undefined);
  vi.mocked(assignUsersToCommandRecord).mockResolvedValue(undefined);
  vi.mocked(unassignUserFromCommandRecord).mockResolvedValue(undefined);
  vi.mocked(addCounterRecord).mockResolvedValue(undefined);
  vi.mocked(updateCounterRecord).mockResolvedValue(undefined);
  vi.mocked(removeCounterRecord).mockResolvedValue(undefined);
  vi.mocked(resetCounterCurrentValueRecord).mockResolvedValue(undefined);
  vi.mocked(incrementCounterRecord).mockResolvedValue(1);
  vi.mocked(archiveAndResetYearlyCountersRecord).mockResolvedValue(0);
  vi.mocked(initAlertConfigsRecord).mockResolvedValue(undefined);
  vi.mocked(saveAlertConfigRecord).mockResolvedValue(undefined);
  vi.mocked(setAlertImageRecord).mockResolvedValue(null);
  vi.mocked(setAlertSoundRecord).mockResolvedValue(null);
  vi.mocked(createSfxTriggerRecord).mockResolvedValue(1n);
  vi.mocked(updateSfxTriggerRecord).mockResolvedValue(true);
  vi.mocked(deleteSfxTriggerRecord).mockResolvedValue({ files: [] });
  vi.mocked(addSfxFileRecord).mockResolvedValue(1);
  vi.mocked(updateSfxFileRecord).mockResolvedValue(true);
  vi.mocked(deleteSfxFileRecord).mockResolvedValue('file.mp3');
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

// ─── upsertOverride ─────────────────────────────────────────────────────────

describe('upsertOverride', () => {
  it('always calls invalidateCustomCommandLookupCache on success', async () => {
    await upsertOverride('1', 5, { isDisabled: false, output: null });
    expect(upsertOverrideRecord).toHaveBeenCalledWith('1', 5, { isDisabled: false, output: null });
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors from upsertOverrideRecord without calling invalidate', async () => {
    vi.mocked(upsertOverrideRecord).mockRejectedValue(new Error('DB error'));
    await expect(upsertOverride('1', 5, { isDisabled: true, output: 'hi' })).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

// ─── removeOverride ─────────────────────────────────────────────────────────

describe('removeOverride', () => {
  it('always calls invalidateCustomCommandLookupCache on success', async () => {
    await removeOverride('1', 5);
    expect(removeOverrideRecord).toHaveBeenCalledWith('1', 5);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors from removeOverrideRecord without calling invalidate', async () => {
    vi.mocked(removeOverrideRecord).mockRejectedValue(new Error('DB error'));
    await expect(removeOverride('1', 5)).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

// ─── addCustomCommand / updateCustomCommand / removeCustomCommand ─────────────
// ─── assignUserToCommand / assignUsersToCommand / unassignUserFromCommand ─────
//
// customCommands.ts is a pure DB layer with no cache knowledge (see comment above
// its wrappers in db.ts); these tests verify db.ts's wrappers invalidate the
// custom-command lookup cache after each write.

describe('addCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    const id = await addCustomCommand('!clap', 'Clap!', true, false);
    expect(id).toBe(1);
    expect(addCustomCommandRecord).toHaveBeenCalledWith('!clap', 'Clap!', true, false);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without calling invalidate', async () => {
    vi.mocked(addCustomCommandRecord).mockRejectedValue(new Error('DB error'));
    await expect(addCustomCommand('!clap', 'Clap!', true, false)).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

describe('updateCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await updateCustomCommand(1, '!clap', 'Clap!', true, false);
    expect(updateCustomCommandRecord).toHaveBeenCalledWith(1, '!clap', 'Clap!', true, false);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

describe('removeCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await removeCustomCommand(1);
    expect(removeCustomCommandRecord).toHaveBeenCalledWith(1);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

describe('assignUserToCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await assignUserToCommand(1, 'user1');
    expect(assignUserToCommandRecord).toHaveBeenCalledWith(1, 'user1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

describe('assignUsersToCommand', () => {
  it('calls the record function and invalidates the cache once, even for an empty array', async () => {
    await assignUsersToCommand(1, []);
    expect(assignUsersToCommandRecord).toHaveBeenCalledWith(1, []);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

describe('unassignUserFromCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await unassignUserFromCommand(1, 'user1');
    expect(unassignUserFromCommandRecord).toHaveBeenCalledWith(1, 'user1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

// ─── Counter write wrappers ────────────────────────────────────────────────────
//
// counters.ts is a pure DB layer with no cache knowledge; these tests verify
// db.ts's wrappers invalidate the counter lookup cache after each write.

describe('addCounter', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await addCounter('!hits', '!checkhits', 'msg', 'inc', false);
    expect(addCounterRecord).toHaveBeenCalledWith('!hits', '!checkhits', 'msg', 'inc', false);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without calling invalidate', async () => {
    vi.mocked(addCounterRecord).mockRejectedValue(new Error('DB error'));
    await expect(addCounter('!hits', '!checkhits', 'msg', 'inc', false)).rejects.toThrow('DB error');
    expect(invalidateCounterLookupCache).not.toHaveBeenCalled();
  });
});

describe('updateCounter', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    const input = { id: 1, triggerCommand: '!hits', checkCommand: '!checkhits', message: 'm', incrementMessage: 'i', resetYearly: false };
    await updateCounter(input);
    expect(updateCounterRecord).toHaveBeenCalledWith(input);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

describe('removeCounter', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await removeCounter(1);
    expect(removeCounterRecord).toHaveBeenCalledWith(1);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

describe('resetCounterCurrentValue', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await resetCounterCurrentValue(1);
    expect(resetCounterCurrentValueRecord).toHaveBeenCalledWith(1);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

describe('incrementCounter', () => {
  it('calls the record function, returns its value, and invalidates the cache on success', async () => {
    vi.mocked(incrementCounterRecord).mockResolvedValue(7);
    const result = await incrementCounter(1);
    expect(result).toBe(7);
    expect(incrementCounterRecord).toHaveBeenCalledWith(1);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

describe('archiveAndResetYearlyCounters', () => {
  it('calls the record function, returns its value, and invalidates the cache on success', async () => {
    vi.mocked(archiveAndResetYearlyCountersRecord).mockResolvedValue(3);
    const result = await archiveAndResetYearlyCounters(2024);
    expect(result).toBe(3);
    expect(archiveAndResetYearlyCountersRecord).toHaveBeenCalledWith(2024);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

// ─── Alert config write wrappers ───────────────────────────────────────────────
//
// alertConfig.ts is a pure DB layer with no cache knowledge; these tests verify
// db.ts's wrappers invalidate the alert config lookup cache after each write.

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

// ─── SFX write wrappers ─────────────────────────────────────────────────────────
//
// sfx.ts is a pure DB layer with no cache knowledge; these tests verify db.ts's
// wrappers invalidate the SFX lookup cache after each write — unconditionally for
// createSfxTrigger/addSfxFile, and only when the record function reports a match
// for updateSfxTrigger/deleteSfxTrigger/updateSfxFile/deleteSfxFile.

describe('createSfxTrigger', () => {
  it('calls the record function, returns its id, and invalidates the cache', async () => {
    vi.mocked(createSfxTriggerRecord).mockResolvedValue(42n);
    const id = await createSfxTrigger('!clap', 3, 'Clap', true);
    expect(id).toBe(42n);
    expect(createSfxTriggerRecord).toHaveBeenCalledWith('!clap', 3, 'Clap', true);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('updateSfxTrigger', () => {
  it('invalidates the cache when the record function reports a match', async () => {
    vi.mocked(updateSfxTriggerRecord).mockResolvedValue(true);
    const result = await updateSfxTrigger(5n, '!clap', 2, 'desc', false);
    expect(result).toBe(true);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no row matched', async () => {
    vi.mocked(updateSfxTriggerRecord).mockResolvedValue(false);
    const result = await updateSfxTrigger(999n, '!clap', null, null, false);
    expect(result).toBe(false);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('deleteSfxTrigger', () => {
  it('invalidates the cache when a trigger was deleted', async () => {
    vi.mocked(deleteSfxTriggerRecord).mockResolvedValue({ files: ['a.mp3'] });
    const result = await deleteSfxTrigger(7n);
    expect(result).toEqual({ files: ['a.mp3'] });
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no trigger existed', async () => {
    vi.mocked(deleteSfxTriggerRecord).mockResolvedValue(null);
    const result = await deleteSfxTrigger(999n);
    expect(result).toBeNull();
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('addSfxFile', () => {
  it('calls the record function, returns its id, and invalidates the cache', async () => {
    vi.mocked(addSfxFileRecord).mockResolvedValue(100);
    const id = await addSfxFile(7n, 'clap.mp3', 2, false);
    expect(id).toBe(100);
    expect(addSfxFileRecord).toHaveBeenCalledWith(7n, 'clap.mp3', 2, false);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });
});

describe('updateSfxFile', () => {
  it('invalidates the cache when the record function reports a match', async () => {
    vi.mocked(updateSfxFileRecord).mockResolvedValue(true);
    const result = await updateSfxFile(11, 3, true);
    expect(result).toBe(true);
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no row matched', async () => {
    vi.mocked(updateSfxFileRecord).mockResolvedValue(false);
    const result = await updateSfxFile(999, 3, true);
    expect(result).toBe(false);
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('deleteSfxFile', () => {
  it('invalidates the cache when a file was deleted', async () => {
    vi.mocked(deleteSfxFileRecord).mockResolvedValue('clap.mp3');
    const result = await deleteSfxFile(11);
    expect(result).toBe('clap.mp3');
    expect(invalidateSfxLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT invalidate the cache when no file existed', async () => {
    vi.mocked(deleteSfxFileRecord).mockResolvedValue(null);
    const result = await deleteSfxFile(999);
    expect(result).toBeNull();
    expect(invalidateSfxLookupCache).not.toHaveBeenCalled();
  });
});

describe('pingDb', () => {
  it('returns true when a connection can be acquired and pinged', async () => {
    const conn = { ping: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
    expect(await pingDb()).toBe(true);
    expect(conn.ping).toHaveBeenCalledOnce();
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('returns false when acquiring a connection fails', async () => {
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockRejectedValue(new Error('down')) } as any);
    expect(await pingDb()).toBe(false);
  });

  it('returns false when the ping itself fails', async () => {
    const conn = { ping: vi.fn().mockRejectedValue(new Error('timeout')), release: vi.fn() };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
    expect(await pingDb()).toBe(false);
  });

  it('still releases the connection back to the pool when the ping rejects', async () => {
    const conn = { ping: vi.fn().mockRejectedValue(new Error('timeout')), release: vi.fn() };
    vi.mocked(getPool).mockReturnValue({ getConnection: vi.fn().mockResolvedValue(conn) } as any);
    expect(await pingDb()).toBe(false);
    expect(conn.release).toHaveBeenCalledOnce();
  });
});
