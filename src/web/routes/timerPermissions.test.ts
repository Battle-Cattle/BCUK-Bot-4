import { describe, it, expect, vi } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', async () => ({
  AccessLevel: ACCESS_LEVEL_MOCK,
  // The real rule, so these tests pin the page-side wrapper to it.
  isTimerSelfManageableBy: (await vi.importActual<typeof import('../../db/timerSelfService')>('../../db/timerSelfService')).isTimerSelfManageableBy,
}));

import { isTimerSelfManageable } from './timerPermissions';

const SELF = '111111111111111111';
const OTHER = '222222222222222222';

function timer(assignedIds: string[]): any {
  return { id: 1, name: 'Plug', assigned_users: assignedIds.map((discord_id) => ({ discord_id })) };
}

describe('isTimerSelfManageable', () => {
  it('is true only when the timer is assigned to the streamer alone', () => {
    expect(isTimerSelfManageable(timer([SELF]), SELF)).toBe(true);
    expect(isTimerSelfManageable(timer([SELF, OTHER]), SELF)).toBe(false);
    expect(isTimerSelfManageable(timer([OTHER]), SELF)).toBe(false);
  });
});
