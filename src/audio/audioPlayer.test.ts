import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../shared/config', () => ({}));
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
  // clearAllMocks resets call history but not implementations, so restore the
  // default happy-path behaviour explicitly (tests below override per-case).
  const voice = await import('@discordjs/voice');
  vi.mocked(voice.entersState).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(voice.createAudioPlayer).mockReset()
    .mockImplementation(() => ({ on: vi.fn(), stop: vi.fn(), play: vi.fn() }) as never);
  vi.mocked(voice.joinVoiceChannel).mockReset().mockImplementation(() => {
    const conn = makeConnection();
    createdConnections.push(conn);
    return conn as never;
  });
  const utils = await import('../discord/discordUtils.js');
  vi.mocked(utils.isPermanentVoiceMisconfigurationError).mockReset().mockReturnValue(false);
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
    expect(vi.mocked(status.setVoiceConnected)).toHaveBeenCalledWith('guild-A', 'vc-chan-1');
  });

  it('rejects when no channelId is given', async () => {
    const { client } = makeClient();
    const utils = await import('../discord/discordUtils.js');
    vi.mocked(utils.isPermanentVoiceMisconfigurationError).mockReturnValue(true);

    await expect(mod.connect(client as never, 'guild-A', '')).rejects.toThrow('Missing guild ID or voice channel ID');
  });

  it('rejects and stays disconnected when the channel is not a voice channel', async () => {
    const { client } = makeClient(0 /* not GuildVoice */);

    await expect(mod.connect(client as never, 'guild-A', 'text-chan')).rejects.toThrow('not a voice channel');
    expect(mod.isConnected('guild-A')).toBe(false);
  });

  it('rejects and stays disconnected when the channel does not exist in the guild (cross-guild channel ID)', async () => {
    const { client, channelsFetch } = makeClient();
    // guild.channels.fetch returns null for a channel that belongs to a different guild.
    channelsFetch.mockResolvedValueOnce(null as never);

    await expect(mod.connect(client as never, 'guild-A', 'chan-from-other-guild'))
      .rejects.toThrow('not a voice channel');
    expect(mod.isConnected('guild-A')).toBe(false);
  });

  it('rejects when the guild ID is missing', async () => {
    const { client } = makeClient();
    const utils = await import('../discord/discordUtils.js');
    // Treat the misconfiguration as permanent so no reconnect timer is scheduled.
    vi.mocked(utils.isPermanentVoiceMisconfigurationError).mockReturnValue(true);

    await expect(mod.connect(client as never, '', 'chan-1')).rejects.toThrow('Missing guild ID or voice channel ID');
    expect(client.guilds.fetch).not.toHaveBeenCalled();
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

  it('disconnecting one guild leaves the other connected and only clears that guild\'s voice status', async () => {
    const a = makeClient();
    const b = makeClient();
    const status = await import('../shared/statusStore.js');
    await mod.connect(a.client as never, 'guild-A', 'chan-A');
    await mod.connect(b.client as never, 'guild-B', 'chan-B');
    vi.mocked(status.setVoiceDisconnected).mockClear();

    mod.disconnect('guild-A');

    expect(mod.isConnected('guild-A')).toBe(false);
    expect(mod.isConnected('guild-B')).toBe(true);
    // Voice status is scoped per guild, so only guild-A's status is cleared.
    expect(vi.mocked(status.setVoiceDisconnected)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(status.setVoiceDisconnected)).toHaveBeenCalledWith('guild-A');
  });

  it('a scheduled reconnect in one guild does not affect the other guild', async () => {
    vi.useFakeTimers();
    try {
      const a = makeClient();
      const b = makeClient();
      const voice = await import('@discordjs/voice');

      // Guild-A fails to connect → reconnect timer scheduled.
      vi.mocked(voice.entersState).mockRejectedValueOnce(new Error('guild-A timeout'));
      await expect(mod.connect(a.client as never, 'guild-A', 'chan-A')).rejects.toThrow('guild-A timeout');
      expect(mod.isConnected('guild-A')).toBe(false);

      // Guild-B connects successfully.
      await mod.connect(b.client as never, 'guild-B', 'chan-B');
      expect(mod.isConnected('guild-B')).toBe(true);

      const joinCountBeforeTimer = vi.mocked(voice.joinVoiceChannel).mock.calls.length;

      // Guild-A's reconnect timer fires and also fails; guild-B must be unaffected.
      vi.mocked(voice.entersState).mockRejectedValue(new Error('still failing'));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mod.isConnected('guild-B')).toBe(true);
      expect(mod.getCurrentChannelId('guild-B')).toBe('chan-B');
      // Guild-A retried (one extra join), guild-B did not.
      expect(vi.mocked(voice.joinVoiceChannel).mock.calls.length).toBeGreaterThan(joinCountBeforeTimer);
      expect(mod.isConnected('guild-A')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    expect(vi.mocked(status.setVoiceDisconnected)).toHaveBeenCalledWith('guild-A');
    expect(vi.mocked(status.setVoiceDisconnected)).toHaveBeenCalledWith('guild-B');
  });
});

describe('isConnected / getCurrentChannelId for unknown guilds', () => {
  it('reports not connected and null channel without throwing', () => {
    expect(mod.isConnected('never-seen')).toBe(false);
    expect(mod.getCurrentChannelId('never-seen')).toBeNull();
  });

  it('disconnect() on a never-connected guild is a no-op and does not allocate state', async () => {
    const status = await import('../shared/statusStore.js');
    mod.disconnect('never-connected');
    expect(mod.isConnected('never-connected')).toBe(false);
    expect(vi.mocked(status.setVoiceDisconnected)).not.toHaveBeenCalled();
  });
});

describe('reconnect', () => {
  it('schedules a reconnect after a failed connect and retries when the timer fires', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      const voice = await import('@discordjs/voice');
      // First join attempt times out waiting for Ready → connect rejects.
      vi.mocked(voice.entersState).mockRejectedValueOnce(new Error('ready timeout'));

      await expect(mod.connect(client as never, 'guild-A', 'chan-1')).rejects.toThrow('ready timeout');
      expect(mod.isConnected('guild-A')).toBe(false);
      const joinsAfterFirst = vi.mocked(voice.joinVoiceChannel).mock.calls.length;

      // The scheduled retry (entersState now resolves) should connect successfully.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(vi.mocked(voice.joinVoiceChannel).mock.calls.length).toBeGreaterThan(joinsAfterFirst);
      expect(mod.isConnected('guild-A')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and keeps retrying when a scheduled reconnect also fails', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      const voice = await import('@discordjs/voice');
      // Every Ready wait times out → the initial connect and its retry both fail.
      vi.mocked(voice.entersState).mockRejectedValue(new Error('still timing out'));

      await expect(mod.connect(client as never, 'guild-A', 'chan-1')).rejects.toThrow('still timing out');
      const joinsAfterFirst = vi.mocked(voice.joinVoiceChannel).mock.calls.length;

      // Firing the retry exercises the timer callback's connect().catch path.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(vi.mocked(voice.joinVoiceChannel).mock.calls.length).toBeGreaterThan(joinsAfterFirst);
      expect(mod.isConnected('guild-A')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second connect() to the same guild supersedes an in-flight one at the next await point', async () => {
    const { client } = makeClient();
    const voice = await import('@discordjs/voice');

    // Start two connects without awaiting the first. The second call increments
    // currentAttemptId before the first connect reaches its next checkpoint
    // (guilds.fetch resolves as a microtask), so the first connect exits silently.
    const firstConnect = mod.connect(client as never, 'guild-A', 'chan-1');
    await mod.connect(client as never, 'guild-A', 'chan-2');
    await firstConnect; // already resolved early — must not throw

    expect(mod.isConnected('guild-A')).toBe(true);
    expect(mod.getCurrentChannelId('guild-A')).toBe('chan-2');
    // First connect exits before joinVoiceChannel; only one join total.
    expect(vi.mocked(voice.joinVoiceChannel).mock.calls.length).toBe(1);
  });

  it('clears a pending reconnect timer when connect is called again', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      const voice = await import('@discordjs/voice');
      vi.mocked(voice.entersState).mockRejectedValueOnce(new Error('ready timeout'));

      await expect(mod.connect(client as never, 'guild-A', 'chan-1')).rejects.toThrow();
      // A retry timer is pending; an explicit reconnect must cancel it.
      await mod.connect(client as never, 'guild-A', 'chan-2');
      expect(mod.isConnected('guild-A')).toBe(true);

      const joinsBefore = vi.mocked(voice.joinVoiceChannel).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      // The cancelled timer must not trigger a further join.
      expect(vi.mocked(voice.joinVoiceChannel).mock.calls.length).toBe(joinsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears down and clears voice status when a live connection drops', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      const voice = await import('@discordjs/voice');
      const status = await import('../shared/statusStore.js');
      await mod.connect(client as never, 'guild-A', 'chan-1');
      expect(mod.isConnected('guild-A')).toBe(true);

      const conn = createdConnections[0];
      const dropHandler = conn.on.mock.calls.find(([e]) => e === 'disconnected')?.[1] as () => Promise<void>;
      vi.mocked(status.setVoiceDisconnected).mockClear();
      // The Signalling/Connecting recovery race fails → the connection is torn down.
      vi.mocked(voice.entersState).mockRejectedValue(new Error('gone'));

      await dropHandler();

      expect(mod.isConnected('guild-A')).toBe(false);
      expect(conn.destroy).toHaveBeenCalled();
      expect(vi.mocked(status.setVoiceDisconnected)).toHaveBeenCalledWith('guild-A');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('per-guild audio player', () => {
  it('Idle handler clears the playing flag and reports idle status', async () => {
    const { client } = makeClient();
    const voice = await import('@discordjs/voice');
    const status = await import('../shared/statusStore.js');
    const fakePlayer = { on: vi.fn(), stop: vi.fn(), play: vi.fn() };
    vi.mocked(voice.createAudioPlayer).mockReturnValue(fakePlayer as never);

    await mod.connect(client as never, 'guild-A', 'chan-1');
    mod.startPlayback({} as never, 'guild-A');
    expect(mod.isPlaying('guild-A')).toBe(true);

    const idleHandler = fakePlayer.on.mock.calls.find(([e]) => e === 'idle')?.[1] as () => void;
    idleHandler();

    expect(mod.isPlaying('guild-A')).toBe(false);
    expect(vi.mocked(status.setVoiceIdle)).toHaveBeenCalledWith('guild-A');
  });

  it('error handler resets the playing flag', async () => {
    const { client } = makeClient();
    const voice = await import('@discordjs/voice');
    const fakePlayer = { on: vi.fn(), stop: vi.fn(), play: vi.fn() };
    vi.mocked(voice.createAudioPlayer).mockReturnValue(fakePlayer as never);

    await mod.connect(client as never, 'guild-A', 'chan-1');
    mod.startPlayback({} as never, 'guild-A');
    expect(mod.isPlaying('guild-A')).toBe(true);

    const errorHandler = fakePlayer.on.mock.calls.find(([e]) => e === 'error')?.[1] as (err: Error) => void;
    errorHandler(new Error('decode failed'));

    expect(mod.isPlaying('guild-A')).toBe(false);
  });

  it('going idle in one guild only clears that guild\'s voice status (Idle)', async () => {
    const a = makeClient();
    const b = makeClient();
    const voice = await import('@discordjs/voice');
    const status = await import('../shared/statusStore.js');
    const players = [{ on: vi.fn(), stop: vi.fn(), play: vi.fn() }, { on: vi.fn(), stop: vi.fn(), play: vi.fn() }];
    let call = 0;
    vi.mocked(voice.createAudioPlayer).mockImplementation(() => players[call++] as never);

    await mod.connect(a.client as never, 'guild-A', 'chan-A');
    await mod.connect(b.client as never, 'guild-B', 'chan-B');
    mod.startPlayback({} as never, 'guild-A');
    mod.startPlayback({} as never, 'guild-B');
    vi.mocked(status.setVoiceIdle).mockClear();

    const idleHandlerA = players[0].on.mock.calls.find(([e]) => e === 'idle')?.[1] as () => void;
    idleHandlerA();

    expect(mod.isPlaying('guild-A')).toBe(false);
    expect(mod.isPlaying('guild-B')).toBe(true);
    expect(vi.mocked(status.setVoiceIdle)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(status.setVoiceIdle)).toHaveBeenCalledWith('guild-A');
  });

  it('clears the guild\'s voice status once it goes idle', async () => {
    const { client } = makeClient();
    const voice = await import('@discordjs/voice');
    const status = await import('../shared/statusStore.js');
    const fakePlayer = { on: vi.fn(), stop: vi.fn(), play: vi.fn() };
    vi.mocked(voice.createAudioPlayer).mockReturnValue(fakePlayer as never);

    await mod.connect(client as never, 'guild-A', 'chan-1');
    mod.startPlayback({} as never, 'guild-A');
    vi.mocked(status.setVoiceIdle).mockClear();

    const idleHandler = fakePlayer.on.mock.calls.find(([e]) => e === 'idle')?.[1] as () => void;
    idleHandler();

    expect(vi.mocked(status.setVoiceIdle)).toHaveBeenCalledWith('guild-A');
  });

  it('an error in one guild only clears that guild\'s voice status', async () => {
    const a = makeClient();
    const b = makeClient();
    const voice = await import('@discordjs/voice');
    const status = await import('../shared/statusStore.js');
    const players = [{ on: vi.fn(), stop: vi.fn(), play: vi.fn() }, { on: vi.fn(), stop: vi.fn(), play: vi.fn() }];
    let call = 0;
    vi.mocked(voice.createAudioPlayer).mockImplementation(() => players[call++] as never);

    await mod.connect(a.client as never, 'guild-A', 'chan-A');
    await mod.connect(b.client as never, 'guild-B', 'chan-B');
    mod.startPlayback({} as never, 'guild-A');
    mod.startPlayback({} as never, 'guild-B');
    vi.mocked(status.setVoiceIdle).mockClear();

    const errorHandlerA = players[0].on.mock.calls.find(([e]) => e === 'error')?.[1] as (err: Error) => void;
    errorHandlerA(new Error('decode failed'));

    expect(mod.isPlaying('guild-A')).toBe(false);
    expect(mod.isPlaying('guild-B')).toBe(true);
    expect(vi.mocked(status.setVoiceIdle)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(status.setVoiceIdle)).toHaveBeenCalledWith('guild-A');
  });

  it('playing one guild does not affect another guild\'s playing flag or player instance', async () => {
    const a = makeClient();
    const b = makeClient();
    const voice = await import('@discordjs/voice');
    const players = [{ on: vi.fn(), stop: vi.fn(), play: vi.fn() }, { on: vi.fn(), stop: vi.fn(), play: vi.fn() }];
    let call = 0;
    vi.mocked(voice.createAudioPlayer).mockImplementation(() => players[call++] as never);

    await mod.connect(a.client as never, 'guild-A', 'chan-A');
    await mod.connect(b.client as never, 'guild-B', 'chan-B');

    mod.startPlayback({} as never, 'guild-A');
    expect(mod.isPlaying('guild-A')).toBe(true);
    expect(mod.isPlaying('guild-B')).toBe(false);
    expect(players[0].play).toHaveBeenCalledTimes(1);
    expect(players[1].play).not.toHaveBeenCalled();
  });
});
