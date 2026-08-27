import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../db', () => ({
  findOwnerUser: vi.fn(),
}));

import { findOwnerUser } from '../db';
import * as healthStore from '../shared/healthStore';
import {
  registerOwnerAlertRuntime,
  startOwnerAlertWatcher,
  __resetOwnerAlertsForTests,
} from './ownerAlerts';

const OWNER_ID = '111222333444555666';
const OWNER_ROW = {
  discord_id: OWNER_ID,
  discord_name: 'Owner',
  is_twitch_bot_enabled: false,
  twitch_name: null,
  access_level: 3,
  is_owner: true,
};

/**
 * Waits enough microtask ticks for the fire-and-forget `sendOwnerAlert` promise chain
 * (resolveOwnerDiscordId's own await chain, then `runtime.send`) to fully settle before
 * assertions run.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('ownerAlerts', () => {
  let send: ReturnType<typeof vi.fn<(discordId: string, message: string) => Promise<void>>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetOwnerAlertsForTests();
    send = vi.fn().mockResolvedValue(undefined);
    registerOwnerAlertRuntime({ send });
    vi.mocked(findOwnerUser).mockResolvedValue(OWNER_ROW as any);
    // Baseline every other tracked component healthy first, so each test below can isolate
    // a single component's ok→fail/fail→ok transition without discordConnected/
    // twitchChatConnected's own false-by-default starting state (or `db`'s state left over
    // from a previous test — healthStore itself is a real, un-reset module singleton here)
    // also counting as a (never-seen-before or edge-triggering) transition that sends its
    // own alert. `startOwnerAlertWatcher()`'s listener registration also persists across
    // tests (healthStore.onHealthChanged has no "off"), so these baseline calls are already
    // observed live once a prior test has started the watcher — `flush()` below drains any
    // alert they trigger before `send.mockClear()`, so a late-resolving baseline alert can't
    // land in the mock's call history after it's been cleared.
    healthStore.recordDiscordConnected(true);
    healthStore.recordTwitchChatConnected(true);
    healthStore.recordDbPing(true);
    await flush();
    send.mockClear();
    startOwnerAlertWatcher();
  });

  it('sends exactly one alert on an ok→fail transition', async () => {
    healthStore.recordDbPing(false, 'connection refused');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('🔴'));
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('connection refused'));
  });

  it('does not resend while still failing within the cooldown window', async () => {
    healthStore.recordDbPing(false, 'boom');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    healthStore.recordDbPing(false, 'boom again');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a recovery alert on a fail→ok transition', async () => {
    healthStore.recordDbPing(false, 'boom');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    healthStore.recordDbPing(true);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(OWNER_ID, expect.stringContaining('✅'));
  });

  it('falls back to the last cached owner ID when findOwnerUser rejects', async () => {
    // First alert resolves normally and populates the cache.
    healthStore.recordDbPing(false, 'boom');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(OWNER_ID, expect.any(String));

    // Recover, then fail again after findOwnerUser starts rejecting (e.g. DB is down).
    healthStore.recordDbPing(true);
    await flush();

    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));
    healthStore.recordDbPing(false, 'boom again');
    await flush();

    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(OWNER_ID, expect.any(String));
  });

  it('skips the alert (does not throw) when findOwnerUser rejects with no cached ID yet', async () => {
    // A previous test's own db-recovery alert (during ITS baseline) can have already
    // populated the module's owner-ID cache — reset it again here (componentStates too,
    // harmlessly, since discord/twitchChat/db are all still healthy) so this test starts
    // from a genuinely never-resolved cache, matching its name.
    __resetOwnerAlertsForTests();
    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));
    healthStore.recordDbPing(false, 'boom');
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the runtime send itself rejects', async () => {
    send.mockRejectedValue(new Error('DM failed — user has DMs disabled'));
    healthStore.recordDbPing(false, 'boom');
    await expect(flush()).resolves.toBeUndefined();
  });
});
