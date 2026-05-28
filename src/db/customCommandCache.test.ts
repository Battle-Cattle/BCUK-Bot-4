import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

vi.mock('./lookupCache', () => ({
  createManagedLookupCache: vi.fn(({ loadCache }: { loadCache: () => Promise<unknown> }) => ({
    getCache: () => loadCache(),
    invalidate: vi.fn(),
  })),
}));

vi.mock('./customCommands', () => ({
  getAllCustomCommandsWithAssignments: vi.fn(),
}));

vi.mock('./users', () => ({
  getTwitchEnabledChannels: vi.fn(),
}));

vi.mock('../twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((name: string | null) => {
    if (!name) return null;
    const result = name.trim().toLowerCase().replace(/^#/, '');
    return result || null;
  }),
}));

import { getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from './customCommandCache';
import { getAllCustomCommandsWithAssignments } from './customCommands';
import { getTwitchEnabledChannels } from './users';

type MockCommand = {
  command_id: number;
  trigger_string: string;
  output: string;
  is_discord_enabled: boolean;
  is_multi_twitch: boolean;
  assigned_users: Array<{
    discord_id: string;
    twitch_name: string | null;
    is_twitch_bot_enabled: boolean;
  }>;
};

function makeCommand(overrides: Partial<MockCommand> = {}): MockCommand {
  return {
    command_id: 1,
    trigger_string: '!clap',
    output: '*claps*',
    is_discord_enabled: true,
    is_multi_twitch: false,
    assigned_users: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([]);
  vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
});

// ─── getCustomCommandForDiscord ───────────────────────────────────────────────

describe('getCustomCommandForDiscord', () => {
  it('returns null for empty string', async () => {
    expect(await getCustomCommandForDiscord('')).toBeNull();
  });

  it('returns null for whitespace-only string', async () => {
    expect(await getCustomCommandForDiscord('   ')).toBeNull();
  });

  it('returns the command when trigger matches (case-insensitive)', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([makeCommand()] as any);
    const result = await getCustomCommandForDiscord('!CLAP');
    expect(result).not.toBeNull();
    expect(result?.trigger_string).toBe('!clap');
  });

  it('trims whitespace from the query before lookup', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([makeCommand()] as any);
    expect(await getCustomCommandForDiscord('  !clap  ')).not.toBeNull();
  });

  it('returns null when the command is not discord-enabled', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({ is_discord_enabled: false }),
    ] as any);
    expect(await getCustomCommandForDiscord('!clap')).toBeNull();
  });

  it('returns null when trigger does not match', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([makeCommand()] as any);
    expect(await getCustomCommandForDiscord('!other')).toBeNull();
  });

  it('collision: lower command_id wins', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({ command_id: 2, output: 'second' }),
      makeCommand({ command_id: 1, output: 'first' }),
    ] as any);
    const result = await getCustomCommandForDiscord('!clap');
    expect(result?.output).toBe('first');
  });

  it('returns a copy — mutating result does not affect subsequent lookups', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([makeCommand()] as any);
    const first = await getCustomCommandForDiscord('!clap');
    (first as any).output = 'mutated';
    const second = await getCustomCommandForDiscord('!clap');
    expect(second?.output).toBe('*claps*');
  });
});

// ─── getCustomCommandForTwitchChannel ────────────────────────────────────────

describe('getCustomCommandForTwitchChannel', () => {
  it('returns null for empty channel', async () => {
    expect(await getCustomCommandForTwitchChannel('', '!clap')).toBeNull();
  });

  it('returns null for empty trigger', async () => {
    expect(await getCustomCommandForTwitchChannel('mychan', '')).toBeNull();
  });

  it('finds an assigned-user command for their channel', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({
        assigned_users: [
          { discord_id: '111', twitch_name: 'mychan', is_twitch_bot_enabled: true },
        ],
      }),
    ] as any);
    const result = await getCustomCommandForTwitchChannel('mychan', '!clap');
    expect(result).not.toBeNull();
    expect(result?.trigger_string).toBe('!clap');
  });

  it('skips assigned users with no twitch_name', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({
        assigned_users: [
          { discord_id: '111', twitch_name: null, is_twitch_bot_enabled: true },
        ],
      }),
    ] as any);
    expect(await getCustomCommandForTwitchChannel('mychan', '!clap')).toBeNull();
  });

  it('skips assigned users with is_twitch_bot_enabled=false', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({
        assigned_users: [
          { discord_id: '111', twitch_name: 'mychan', is_twitch_bot_enabled: false },
        ],
      }),
    ] as any);
    expect(await getCustomCommandForTwitchChannel('mychan', '!clap')).toBeNull();
  });

  it('finds a multi-twitch command in an active channel', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['mychan']);
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({ is_multi_twitch: true }),
    ] as any);
    const result = await getCustomCommandForTwitchChannel('mychan', '!clap');
    expect(result).not.toBeNull();
  });

  it('multi-twitch command is absent for channels not in active list', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['otherchan']);
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({ is_multi_twitch: true }),
    ] as any);
    expect(await getCustomCommandForTwitchChannel('mychan', '!clap')).toBeNull();
  });

  it('assigned (priority 2) beats multi-twitch (priority 1) for the same key', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['mychan']);
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({
        command_id: 1,
        output: 'multi',
        is_multi_twitch: true,
        assigned_users: [],
      }),
      makeCommand({
        command_id: 2,
        output: 'assigned',
        is_multi_twitch: false,
        assigned_users: [
          { discord_id: '111', twitch_name: 'mychan', is_twitch_bot_enabled: true },
        ],
      }),
    ] as any);
    const result = await getCustomCommandForTwitchChannel('mychan', '!clap');
    expect(result?.output).toBe('assigned');
  });

  it('same-priority collision: lower command_id wins', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['mychan']);
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({
        command_id: 2,
        output: 'second',
        assigned_users: [
          { discord_id: '222', twitch_name: 'mychan', is_twitch_bot_enabled: true },
        ],
      }),
      makeCommand({
        command_id: 1,
        output: 'first',
        assigned_users: [
          { discord_id: '111', twitch_name: 'mychan', is_twitch_bot_enabled: true },
        ],
      }),
    ] as any);
    const result = await getCustomCommandForTwitchChannel('mychan', '!clap');
    expect(result?.output).toBe('first');
  });

  it('channel lookup is case-insensitive (strips # and lowercases)', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({
        assigned_users: [
          { discord_id: '111', twitch_name: 'mychan', is_twitch_bot_enabled: true },
        ],
      }),
    ] as any);
    expect(await getCustomCommandForTwitchChannel('#MyChan', '!clap')).not.toBeNull();
  });

  it('returns a copy — mutating result does not affect subsequent lookups', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      makeCommand({
        assigned_users: [
          { discord_id: '111', twitch_name: 'mychan', is_twitch_bot_enabled: true },
        ],
      }),
    ] as any);
    const first = await getCustomCommandForTwitchChannel('mychan', '!clap');
    (first as any).output = 'mutated';
    const second = await getCustomCommandForTwitchChannel('mychan', '!clap');
    expect(second?.output).toBe('*claps*');
  });
});
