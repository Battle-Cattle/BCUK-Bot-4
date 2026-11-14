import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../commands/commandRouter', () => ({ handleCommand: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../commands/customCommandHandler', () => ({ executeCustomCommandForDiscord: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../commands/counterHandler', () => ({ executeCounterCommandForDiscord: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../commands/healthCommandHandler', () => ({ executeHealthCommandForDiscord: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./guildRegistry', () => ({
  // Only the legacy configured guild is registered in these tests.
  isRegisteredGuild: vi.fn((id: string) => id === 'guild-id'),
}));
vi.mock('../shared/logger', () => ({ createLogger: vi.fn(mockLogger) }));

import { handleCommand } from '../commands/commandRouter';
import { executeCustomCommandForDiscord } from '../commands/customCommandHandler';
import { executeCounterCommandForDiscord } from '../commands/counterHandler';
import { executeHealthCommandForDiscord } from '../commands/healthCommandHandler';
import { registerMessageCreateHandler } from './discordMessageDispatch';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerMessageCreateHandler', () => {
  function getMessageCreateCb() {
    const client = { on: vi.fn() };
    registerMessageCreateHandler(client as any);
    return client.on.mock.calls.find(([event]: string[]) => event === 'messageCreate')?.[1] as (...args: any[]) => unknown;
  }

  it('skips bot messages without calling command handlers', () => {
    const cb = getMessageCreateCb();
    cb({ author: { bot: true }, guildId: 'guild-id', content: '!test', member: null });
    expect(vi.mocked(handleCommand)).not.toHaveBeenCalled();
  });

  it('skips messages from an unregistered guild', () => {
    const cb = getMessageCreateCb();
    cb({ author: { bot: false, username: 'Alice' }, guildId: 'other-guild', content: '!test', member: null });
    expect(vi.mocked(handleCommand)).not.toHaveBeenCalled();
  });

  it('skips guild-gated handlers for DMs (no guildId)', () => {
    const cb = getMessageCreateCb();
    cb({ author: { bot: false, username: 'Alice' }, guildId: null, content: '!test', member: null });
    expect(vi.mocked(handleCommand)).not.toHaveBeenCalled();
    expect(vi.mocked(executeCustomCommandForDiscord)).not.toHaveBeenCalled();
    expect(vi.mocked(executeCounterCommandForDiscord)).not.toHaveBeenCalled();
  });

  it('still dispatches DMs to the health command handler', () => {
    const cb = getMessageCreateCb();
    const msg = { author: { bot: false, username: 'Alice' }, guildId: null, content: '!health', member: null };
    cb(msg);
    expect(vi.mocked(executeHealthCommandForDiscord)).toHaveBeenCalledWith(msg);
  });

  it('dispatches to command handlers for registered guild messages', () => {
    const cb = getMessageCreateCb();
    const msg = { author: { bot: false, username: 'Alice' }, guildId: 'guild-id', content: '!test', member: { displayName: 'Alice' } };
    cb(msg);
    expect(vi.mocked(handleCommand)).toHaveBeenCalledWith('!test', 'discord', 'guild-id', '!test');
    expect(vi.mocked(executeCustomCommandForDiscord)).toHaveBeenCalledWith(msg, 'Alice', 'guild-id', '!test');
  });

  it('dispatches to the health command handler for registered guild messages', () => {
    const cb = getMessageCreateCb();
    const msg = { author: { bot: false, username: 'Alice' }, guildId: 'guild-id', content: '!health', member: { displayName: 'Alice' } };
    cb(msg);
    expect(vi.mocked(executeHealthCommandForDiscord)).toHaveBeenCalledWith(msg, '!health');
  });
});
