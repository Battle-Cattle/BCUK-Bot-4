import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerTwitchGuildResolutionRuntime, resolveGuildIdForDiscordId } from './twitchGuildResolutionRuntime';

describe('resolveGuildIdForDiscordId', () => {
  beforeEach(() => {
    registerTwitchGuildResolutionRuntime({ resolveGuildIdForDiscordId: vi.fn().mockReturnValue(null) });
  });

  it('returns null without calling the runtime when discordId is null', () => {
    const runtimeResolve = vi.fn();
    registerTwitchGuildResolutionRuntime({ resolveGuildIdForDiscordId: runtimeResolve });

    expect(resolveGuildIdForDiscordId(null)).toBeNull();
    expect(runtimeResolve).not.toHaveBeenCalled();
  });

  it('delegates to the registered runtime for a non-null discordId', () => {
    const runtimeResolve = vi.fn().mockReturnValue('guild-1');
    registerTwitchGuildResolutionRuntime({ resolveGuildIdForDiscordId: runtimeResolve });

    expect(resolveGuildIdForDiscordId('user-1')).toBe('guild-1');
    expect(runtimeResolve).toHaveBeenCalledWith('user-1');
  });
});
