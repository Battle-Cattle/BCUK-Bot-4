import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../shared/statusStore', () => ({ setVoiceIdle: vi.fn() }));
// One shared logger instance, so tests can assert on the playback-start log lines.
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => log }));
vi.mock('./rtpClock', () => ({ syncRtpTimestamp: vi.fn() }));
vi.mock('@discordjs/voice', () => ({
  createAudioPlayer: vi.fn(),
  AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' },
  NoSubscriberBehavior: { Pause: 'pause' },
}));

import { createAudioPlayer } from '@discordjs/voice';
import { setVoiceIdle } from '../shared/statusStore';
import { syncRtpTimestamp } from './rtpClock';
import { type GuildPlaybackState, getPlayer, stopGuildPlayer, playOnGuildPlayer } from './guildAudioPlayback';

function makePlayer() {
  return { on: vi.fn(), stop: vi.fn(), play: vi.fn() };
}

function makeState(overrides: Partial<GuildPlaybackState> = {}): GuildPlaybackState {
  return {
    guildId: 'guild-A',
    connection: { ping: { ws: 42, udp: 17 } } as never,
    player: null,
    playing: false,
    connectedAt: null,
    playRequestedAt: null,
    ...overrides,
  };
}

/** Returns the handler the fake player registered for `event`. */
function handlerFor(player: ReturnType<typeof makePlayer>, event: string) {
  return player.on.mock.calls.find(([e]) => e === event)?.[1] as (...args: unknown[]) => void;
}

let fakePlayer: ReturnType<typeof makePlayer>;

beforeEach(() => {
  vi.clearAllMocks();
  fakePlayer = makePlayer();
  vi.mocked(createAudioPlayer).mockReturnValue(fakePlayer as never);
});

describe('getPlayer', () => {
  it('creates the guild\'s player once and reuses it', () => {
    const state = makeState();

    const first = getPlayer(state);
    const second = getPlayer(state);

    expect(first).toBe(fakePlayer);
    expect(second).toBe(first);
    expect(createAudioPlayer).toHaveBeenCalledExactlyOnceWith({ behaviors: { noSubscriber: 'pause' } });
  });

  it('Idle handler clears the playing flag and reports idle status', () => {
    const state = makeState();
    playOnGuildPlayer(state, {} as never);
    expect(state.playing).toBe(true);

    handlerFor(fakePlayer, 'idle')();

    expect(state.playing).toBe(false);
    expect(state.playRequestedAt).toBeNull();
    expect(setVoiceIdle).toHaveBeenCalledWith('guild-A');
  });

  it('error handler resets the playing flag', () => {
    const state = makeState();
    playOnGuildPlayer(state, {} as never);
    expect(state.playing).toBe(true);

    handlerFor(fakePlayer, 'error')(new Error('decode failed'));

    expect(state.playing).toBe(false);
    expect(setVoiceIdle).toHaveBeenCalledWith('guild-A');
  });
});

describe('playOnGuildPlayer', () => {
  it('marks the guild playing and hands the resource to its player', () => {
    const state = makeState();
    const resource = {} as never;

    playOnGuildPlayer(state, resource);

    expect(state.playing).toBe(true);
    expect(fakePlayer.play).toHaveBeenCalledExactlyOnceWith(resource);
  });
});

describe('stopGuildPlayer', () => {
  it('stops the player and clears the playing flag', () => {
    const state = makeState();
    playOnGuildPlayer(state, {} as never);

    stopGuildPlayer(state);

    expect(fakePlayer.stop).toHaveBeenCalledWith(true);
    expect(state.playing).toBe(false);
  });

  it('ignores a stop error and still clears the playing flag', () => {
    const state = makeState();
    playOnGuildPlayer(state, {} as never);
    fakePlayer.stop.mockImplementation(() => { throw new Error('already stopped'); });

    stopGuildPlayer(state);

    expect(state.playing).toBe(false);
  });

  it('is a no-op on the player for a guild that never played', () => {
    const state = makeState();

    stopGuildPlayer(state);

    expect(createAudioPlayer).not.toHaveBeenCalled();
    expect(state.playing).toBe(false);
  });
});

describe('playback-start log', () => {
  /** Starts a sound at `playAt` on a guild connected at `connectedAt`; returns the player's Playing handler. */
  function startSound(connectedAt: number | null, playAt: number, overrides: Partial<GuildPlaybackState> = {}) {
    const state = makeState({ connectedAt, ...overrides });
    const now = vi.spyOn(Date, 'now').mockReturnValue(playAt);
    playOnGuildPlayer(state, {} as never);
    return { playing: handlerFor(fakePlayer, 'playing'), now };
  }

  it('logs the startup time, connection age and voice ping at debug level for a quick start', () => {
    const { playing, now } = startSound(0, 90 * 60_000);
    now.mockReturnValue(90 * 60_000 + 120);

    playing();
    now.mockRestore();

    expect(log.debug).toHaveBeenCalledWith(
      'Playback started in guild guild-A after 120ms (voice connected 90min, ping ws 42ms / udp 17ms)',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips the RTP sync and logs unknown age and ping when a guild with no voice connection starts playing', () => {
    const { playing, now } = startSound(null, 1_000, { connection: null });
    now.mockReturnValue(1_050);

    playing();
    now.mockRestore();

    expect(syncRtpTimestamp).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith('Playback started in guild guild-A after 50ms (voice connected ?min, ping ws ?ms / udp ?ms)');
  });

  it('logs a warning when the sound took longer than 500ms to start', () => {
    const { playing, now } = startSound(0, 1_000);
    now.mockReturnValue(3_500);

    playing();
    now.mockRestore();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('after 2500ms'));
  });

  it('logs nothing when the player resumes playing with no start pending', () => {
    const { playing, now } = startSound(0, 1_000);
    now.mockReturnValue(1_100);
    playing();
    vi.clearAllMocks();

    playing();
    now.mockRestore();

    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('RTP clock sync on Playing', () => {
  /** Starts a sound on guild-A; returns its connection and the player's Playing handler. */
  function startWithPlayer() {
    const state = makeState();
    playOnGuildPlayer(state, {} as never);
    return { connection: state.connection, playing: handlerFor(fakePlayer, 'playing'), sync: vi.mocked(syncRtpTimestamp) };
  }

  it('syncs the guild connection\'s RTP clock against the monotonic clock whenever the player enters Playing', () => {
    const { connection, playing, sync } = startWithPlayer();
    const now = vi.spyOn(performance, 'now').mockReturnValue(12_345);

    playing();
    playing(); // e.g. a resume from auto-pause
    now.mockRestore();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledWith(connection, 12_345);
  });

  it('logs a move at debug level', () => {
    const { playing, sync } = startWithPlayer();
    sync.mockReturnValueOnce(300_000.4);

    playing();

    expect(log.debug).toHaveBeenCalledWith('Moved the RTP clock forward 300000ms in guild guild-A');
  });

  it('logs nothing when the clock was already in step or could not be synced', () => {
    const { playing, sync } = startWithPlayer();
    sync.mockReturnValueOnce(0).mockReturnValueOnce(null);

    playing();
    playing();

    expect(log.debug).not.toHaveBeenCalledWith(expect.stringContaining('RTP clock'));
  });
});
