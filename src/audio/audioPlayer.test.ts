import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../shared/config', () => ({ DISCORD_VOICE_CHANNEL_ID: 'default-vc' }));
vi.mock('../shared/statusStore', () => ({
  setVoiceConnected: vi.fn(),
  setVoiceDisconnected: vi.fn(),
  setVoiceIdle: vi.fn(),
}));
vi.mock('../discord/discordUtils', () => ({
  isPermanentVoiceMisconfigurationError: vi.fn(() => false),
}));
vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('discord.js', () => ({
  Client: vi.fn(),
  ChannelType: { GuildVoice: 2 },
}));

// Each joinVoiceChannel call returns a fresh fake connection so per-guild
// state can be asserted independently.
function makeConnection() {
  return {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn(),
    destroy: vi.fn(),
    state: { status: 'ready' },
  };
}
const createdConnections: ReturnType<typeof makeConnection>[] = [];

vi.mock('@discordjs/voice', () => ({
  createAudioPlayer: vi.fn(() => ({ on: vi.fn(), stop: vi.fn(), play: vi.fn() })),
  joinVoiceChannel: vi.fn(() => {
    const conn = makeConnection();
    createdConnections.push(conn);
    return conn;
  }),
  entersState: vi.fn().mockResolvedValue(undefined),
  AudioPlayerStatus: { Idle: 'idle' },
  VoiceConnectionStatus: { Ready: 'ready', Signalling: 'signalling', Connecting: 'connecting', Disconnected: 'disconnected', Destroyed: 'destroyed' },
  NoSubscriberBehavior: { Pause: 'pause' },
}));

type AudioPlayerModule = typeof import('./audioPlayer');

let mod: AudioPlayerModule;

// A fake Discord client whose channel lookups succeed for any guild/channel by
// default; individual tests override channels.fetch to exercise failure paths.
function makeClient(channelType: number = 2) {
  const channelsFetch = vi.fn(async (channelId: string) => ({
    id: channelId,
    type: channelType,
    name: `vc-${channelId}`,
    client: { on: vi.fn(), off: vi.fn(), getMaxListeners: () => 10, setMaxListeners: vi.fn() },
    guild: { shard: { send: vi.fn() } },
  }));
  const client = {
    guilds: {
      fetch: vi.fn(async (guildId: string) => ({ id: guildId, channels: { fetch: channelsFetch } })),
    },
  };
  return { client, channelsFetch };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  createdConnections.length = 0;
  mod = await import('./audioPlayer.js') as AudioPlayerModule;
});

describe('connect', () => {
  it('joins the requested channel in the requested guild', async () => {
    const { client } = makeClient();
    const voice = await import('@discordjs/voice');
    const status = await import('../shared/statusStore.js');

    await mod.connect(client as never, 'guild-A', 'chan-1');

    expect(vi.mocked(voice.joinVoiceChannel)).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'guild-A', channelId: 'chan-1' }),
    );
    expect(mod.isConnected('guild-A')).toBe(true);
    expect(mod.getCurrentChannelId('guild-A')).toBe('chan-1');
    expect(vi.mocked(status.setVoiceConnected)).toHaveBeenCalledWith('vc-chan-1');
  });

  it('falls back to the default channel when none is given', async () => {
    const { client } = makeClient();
    const voice = await import('@discordjs/voice');

    await mod.connect(client as never, 'guild-A');

    expect(vi.mocked(voice.joinVoiceChannel)).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'default-vc' }),
    );
  });

  it('rejects and stays disconnected when the channel is not a voice channel', async () => {
    const { client } = makeClient(0 /* not GuildVoice */);

    await expect(mod.connect(client as never, 'guild-A', 'text-chan')).rejects.toThrow('not a voice channel');
    expect(mod.isConnected('guild-A')).toBe(false);
  });
});

describe('per-guild isolation', () => {
  it('tracks connections for two guilds independently', async () => {
    const a = makeClient();
    const b = makeClient();

    await mod.connect(a.client as never, 'guild-A', 'chan-A');
    await mod.connect(b.client as never, 'guild-B', 'chan-B');

    expect(mod.isConnected('guild-A')).toBe(true);
    expect(mod.isConnected('guild-B')).toBe(true);
    expect(mod.isConnected()).toBe(true);
    expect(mod.getCurrentChannelId('guild-A')).toBe('chan-A');
    expect(mod.getCurrentChannelId('guild-B')).toBe('chan-B');
  });

  it('disconnecting one guild leaves the other connected and does not clear global voice status', async () => {
    const a = makeClient();
    const b = makeClient();
    const status = await import('../shared/statusStore.js');
    await mod.connect(a.client as never, 'guild-A', 'chan-A');
    await mod.connect(b.client as never, 'guild-B', 'chan-B');
    vi.mocked(status.setVoiceDisconnected).mockClear();

    mod.disconnect('guild-A');

    expect(mod.isConnected('guild-A')).toBe(false);
    expect(mod.isConnected('guild-B')).toBe(true);
    // Another guild is still connected, so the shared/global voice status must not be cleared.
    expect(vi.mocked(status.setVoiceDisconnected)).not.toHaveBeenCalled();
  });

  it('disconnect() with no guild tears down every guild and clears voice status', async () => {
    const a = makeClient();
    const b = makeClient();
    const status = await import('../shared/statusStore.js');
    await mod.connect(a.client as never, 'guild-A', 'chan-A');
    await mod.connect(b.client as never, 'guild-B', 'chan-B');
    vi.mocked(status.setVoiceDisconnected).mockClear();

    mod.disconnect();

    expect(mod.isConnected('guild-A')).toBe(false);
    expect(mod.isConnected('guild-B')).toBe(false);
    expect(mod.isConnected()).toBe(false);
    expect(vi.mocked(status.setVoiceDisconnected)).toHaveBeenCalled();
  });
});

describe('isConnected / getCurrentChannelId for unknown guilds', () => {
  it('reports not connected and null channel without throwing', () => {
    expect(mod.isConnected('never-seen')).toBe(false);
    expect(mod.getCurrentChannelId('never-seen')).toBeNull();
  });
});
