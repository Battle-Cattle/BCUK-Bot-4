import { describe, it, expect, vi } from 'vitest';
import { createRuntimeRegistry, type TwitchSendRuntime } from './twitchRuntime';

describe('createRuntimeRegistry', () => {
  it('returns null from get() before anything is registered', () => {
    const registry = createRuntimeRegistry<TwitchSendRuntime>();
    expect(registry.get()).toBeNull();
  });

  it('returns the registered runtime from get()', () => {
    const registry = createRuntimeRegistry<TwitchSendRuntime>();
    const runtime = { send: vi.fn().mockResolvedValue(undefined) };

    registry.register(runtime);

    expect(registry.get()).toBe(runtime);
  });

  it('replaces a previously-registered runtime on re-register', () => {
    const registry = createRuntimeRegistry<TwitchSendRuntime>();
    const first = { send: vi.fn().mockResolvedValue(undefined) };
    const second = { send: vi.fn().mockResolvedValue(undefined) };

    registry.register(first);
    registry.register(second);

    expect(registry.get()).toBe(second);
  });

  it('supports runtimes with extra fields beyond send', () => {
    interface RichRuntime extends TwitchSendRuntime {
      getActiveChannels: () => ReadonlySet<string>;
    }
    const registry = createRuntimeRegistry<RichRuntime>();
    const runtime: RichRuntime = {
      send: vi.fn().mockResolvedValue(undefined),
      getActiveChannels: () => new Set(['#a']),
    };

    registry.register(runtime);

    expect(registry.get()).toBe(runtime);
    expect(registry.get()?.getActiveChannels()).toEqual(new Set(['#a']));
  });

  it('keeps independent state across separate registry instances', () => {
    const registryA = createRuntimeRegistry<TwitchSendRuntime>();
    const registryB = createRuntimeRegistry<TwitchSendRuntime>();
    const runtime = { send: vi.fn().mockResolvedValue(undefined) };

    registryA.register(runtime);

    expect(registryA.get()).toBe(runtime);
    expect(registryB.get()).toBeNull();
  });
});
