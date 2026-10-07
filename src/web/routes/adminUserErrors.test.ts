import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
  getEffectiveAccessLevelForUser: vi.fn(),
  getGuildsForMember: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((name: string) => (name ? name.toLowerCase() : null)),
}));
vi.mock('./adminUserMutations', () => ({
  isLockWaitTimeoutDbError: vi.fn().mockReturnValue(false),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import { isLockWaitTimeoutDbError } from './adminUserMutations';
import {
  handleDbError,
} from './adminUserErrors';
import type { Response } from 'express';

// ─── discordIdError ──────────────────────────────────────────────────────────

describe('handleDbError', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  it('redirects to db_busy for a lock-wait-timeout error', () => {
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(true);
    const { res, redirect } = mockRes();
    handleDbError(new Error('lock'), res, 'upsert_failed', 'test context');
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=db_busy');
  });

  it('redirects to the failCode for other errors', () => {
    vi.mocked(isLockWaitTimeoutDbError).mockReturnValue(false);
    const { res, redirect } = mockRes();
    handleDbError(new Error('generic'), res, 'upsert_failed', 'test context');
    expect(redirect).toHaveBeenCalledWith('/admin/users?error=upsert_failed');
  });
});
