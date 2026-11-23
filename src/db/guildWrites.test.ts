import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guilds', () => ({ upsertGuild: vi.fn() }));
vi.mock('./guildInfoEvents', () => ({ notifyGuildInfoChanged: vi.fn() }));

import { upsertGuild as upsertRecord } from './guilds';
import { notifyGuildInfoChanged } from './guildInfoEvents';
import { upsertGuild } from './guildWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertRecord).mockResolvedValue(undefined);
});

describe('upsertGuild', () => {
  it('writes, then tells listeners which guild changed', async () => {
    await upsertGuild('guild-1', 'Our Guild');
    expect(upsertRecord).toHaveBeenCalledWith('guild-1', 'Our Guild');
    expect(notifyGuildInfoChanged).toHaveBeenCalledExactlyOnceWith('guild-1');
  });

  it('does not notify when the write fails, and passes the error on', async () => {
    vi.mocked(upsertRecord).mockRejectedValue(new Error('DB error'));
    await expect(upsertGuild('guild-1', 'Our Guild')).rejects.toThrow('DB error');
    expect(notifyGuildInfoChanged).not.toHaveBeenCalled();
  });
});
