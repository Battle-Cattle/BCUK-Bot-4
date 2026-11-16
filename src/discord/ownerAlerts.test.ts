import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));

vi.mock('../db', () => ({
  findOwnerUser: vi.fn(),
}));

import { findOwnerUser } from '../db';
import {
  registerOwnerAlertRuntime,
  sendOwnerAlert,
  announceShutdown,
  announceStartup,
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

describe('sendOwnerAlert with no runtime registered', () => {
  it('logs and returns without throwing when no runtime has ever been registered', async () => {
    // Uses a fresh module instance (via vi.resetModules() + dynamic import) rather than the
    // file's shared/top-level-imported one, so this test can exercise the "never registered"
    // path without needing to un-register the runtime the other describe blocks depend on —
    // there's no unregister API, and runtimeRegistry has no reset hook of its own.
    vi.resetModules();
    const fresh = await import('./ownerAlerts.js');
    mockLog.warn.mockClear();

    await expect(fresh.sendOwnerAlert('🔴 db is down: boom')).resolves.toBe(false);

    expect(mockLog.warn).toHaveBeenCalledWith('No owner-alert runtime registered — skipping alert:', expect.stringContaining('boom'));
  });
});

describe('sendOwnerAlert', () => {
  let send: ReturnType<typeof vi.fn<(discordId: string, message: string) => Promise<void>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetOwnerAlertsForTests();
    send = vi.fn().mockResolvedValue(undefined);
    registerOwnerAlertRuntime({ send });
    vi.mocked(findOwnerUser).mockResolvedValue(OWNER_ROW as any);
  });

  it('DMs the owner and reports delivery', async () => {
    await expect(sendOwnerAlert('hello')).resolves.toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(OWNER_ID, 'hello');
  });

  it('falls back to the last cached owner ID when the owner lookup rejects', async () => {
    await sendOwnerAlert('first');
    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));

    await expect(sendOwnerAlert('second')).resolves.toBe(true);
    expect(send).toHaveBeenLastCalledWith(OWNER_ID, 'second');
  });

  it('skips the alert when the owner lookup rejects with no cached ID yet', async () => {
    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));

    await expect(sendOwnerAlert('hello')).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a lookup that finds no owner as authoritative, clearing the cached ID', async () => {
    await sendOwnerAlert('first');
    vi.mocked(findOwnerUser).mockResolvedValueOnce(null).mockRejectedValue(new Error('db down'));

    await expect(sendOwnerAlert('no owner')).resolves.toBe(false);
    await expect(sendOwnerAlert('db down, nothing cached')).resolves.toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });

  it('drops the alert when it is no longer relevant by the time it would be sent', async () => {
    await expect(sendOwnerAlert('stale', () => false)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a rejected send as not delivered, without throwing', async () => {
    send.mockRejectedValue(new Error('DM failed — user has DMs disabled'));
    await expect(sendOwnerAlert('hello')).resolves.toBe(false);
  });
});

describe('announceShutdown / announceStartup', () => {
  let send: ReturnType<typeof vi.fn<(discordId: string, message: string) => Promise<void>>>;

  beforeEach(() => {
    __resetOwnerAlertsForTests();
    send = vi.fn().mockResolvedValue(undefined);
    registerOwnerAlertRuntime({ send });
    vi.mocked(findOwnerUser).mockResolvedValue(OWNER_ROW as any);
  });

  it('sends an explicit shutdown DM', async () => {
    await announceShutdown();
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('Shutting down'));
  });

  it('sends an explicit back-online DM', async () => {
    await announceStartup();
    expect(send).toHaveBeenCalledWith(OWNER_ID, expect.stringContaining('Back online'));
  });

  it('never throws when the runtime send itself rejects', async () => {
    send.mockRejectedValue(new Error('DM failed — user has DMs disabled'));
    await expect(announceShutdown()).resolves.toBeUndefined();
    await expect(announceStartup()).resolves.toBeUndefined();
  });

  it('skips the alert without throwing when the runtime never becomes ready', async () => {
    registerOwnerAlertRuntime({ send, waitUntilReady: () => Promise.reject(new Error('Discord ready timed out after 30000ms')) });

    await expect(announceStartup()).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
