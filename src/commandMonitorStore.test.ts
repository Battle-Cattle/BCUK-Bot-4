import { describe, it, expect, beforeEach, vi } from 'vitest';

let recordCommandTestEntry: (typeof import('./commandMonitorStore.js'))['recordCommandTestEntry'];
let getRecentCommandTestEntries: (typeof import('./commandMonitorStore.js'))['getRecentCommandTestEntries'];

beforeEach(async () => {
  vi.resetModules();
  ({ recordCommandTestEntry, getRecentCommandTestEntries } = await import('./commandMonitorStore.js'));
});

const makeEntry = (command = '!test') => ({
  source: 'twitch' as const,
  command,
  response: 'response',
  channel: 'channel1',
  user: 'user1',
});

describe('recordCommandTestEntry', () => {
  it('prepends — newest entry is at index 0', () => {
    recordCommandTestEntry(makeEntry('!first'));
    recordCommandTestEntry(makeEntry('!second'));

    const entries = getRecentCommandTestEntries();
    expect(entries[0].command).toBe('!second');
    expect(entries[1].command).toBe('!first');
  });

  it('assigns monotonically increasing IDs starting at 1', () => {
    recordCommandTestEntry(makeEntry('!a'));
    recordCommandTestEntry(makeEntry('!b'));
    recordCommandTestEntry(makeEntry('!c'));

    const entries = getRecentCommandTestEntries();
    // Newest first, so IDs are 3, 2, 1
    expect(entries[0].id).toBe(3);
    expect(entries[1].id).toBe(2);
    expect(entries[2].id).toBe(1);
  });

  it('caps the list at 30 entries when 31 are added', () => {
    for (let i = 1; i <= 31; i++) {
      recordCommandTestEntry(makeEntry(`!cmd${i}`));
    }

    const entries = getRecentCommandTestEntries();
    expect(entries).toHaveLength(30);
  });

  it('drops the oldest entry (original first) when the cap is exceeded', () => {
    for (let i = 1; i <= 31; i++) {
      recordCommandTestEntry(makeEntry(`!cmd${i}`));
    }

    const entries = getRecentCommandTestEntries();
    // !cmd1 was added first and should have been dropped
    const commands = entries.map((e) => e.command);
    expect(commands).not.toContain('!cmd1');
    expect(commands).toContain('!cmd31');
  });
});

describe('getRecentCommandTestEntries', () => {
  it('returns entries newest-first', () => {
    recordCommandTestEntry(makeEntry('!alpha'));
    recordCommandTestEntry(makeEntry('!beta'));
    recordCommandTestEntry(makeEntry('!gamma'));

    const entries = getRecentCommandTestEntries();
    expect(entries.map((e) => e.command)).toEqual(['!gamma', '!beta', '!alpha']);
  });

  it('returns copies — mutating the returned array does not affect internal state', () => {
    recordCommandTestEntry(makeEntry('!original'));

    const first = getRecentCommandTestEntries();
    first.splice(0, first.length); // clear the returned array

    const second = getRecentCommandTestEntries();
    expect(second).toHaveLength(1);
    expect(second[0].command).toBe('!original');
  });

  it('returns Date instances for createdAt', () => {
    recordCommandTestEntry(makeEntry('!timetest'));

    const entries = getRecentCommandTestEntries();
    expect(entries[0].createdAt).toBeInstanceOf(Date);
  });
});
