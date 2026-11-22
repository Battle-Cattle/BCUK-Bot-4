import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guildMembers', () => ({ setMemberAccessLevel: vi.fn(), removeGuildMember: vi.fn() }));
vi.mock('./guildInfoEvents', () => ({ notifyGuildInfoChanged: vi.fn() }));

import { setMemberAccessLevel as setRecord, removeGuildMember as removeRecord } from './guildMembers';
import { notifyGuildInfoChanged } from './guildInfoEvents';
import { setMemberAccessLevel, removeGuildMember } from './guildMemberWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setRecord).mockResolvedValue(undefined);
  vi.mocked(removeRecord).mockResolvedValue(undefined);
});

describe('setMemberAccessLevel', () => {
  it('writes, then tells listeners which guild changed', async () => {
    await setMemberAccessLevel('guild-1', 'user-1', 2);
    expect(setRecord).toHaveBeenCalledWith('guild-1', 'user-1', 2);
    expect(notifyGuildInfoChanged).toHaveBeenCalledExactlyOnceWith('guild-1');
  });

  it('does not notify when the write fails, and passes the error on', async () => {
    vi.mocked(setRecord).mockRejectedValue(new Error('DB error'));
    await expect(setMemberAccessLevel('guild-1', 'user-1', 9)).rejects.toThrow('DB error');
    expect(notifyGuildInfoChanged).not.toHaveBeenCalled();
  });
});

describe('removeGuildMember', () => {
  it('deletes, then tells listeners which guild changed', async () => {
    await removeGuildMember('guild-1', 'user-1');
    expect(removeRecord).toHaveBeenCalledWith('guild-1', 'user-1');
    expect(notifyGuildInfoChanged).toHaveBeenCalledExactlyOnceWith('guild-1');
  });

  it('does not notify when the delete fails, and passes the error on', async () => {
    vi.mocked(removeRecord).mockRejectedValue(new Error('DB error'));
    await expect(removeGuildMember('guild-1', 'user-1')).rejects.toThrow('DB error');
    expect(notifyGuildInfoChanged).not.toHaveBeenCalled();
  });
});
