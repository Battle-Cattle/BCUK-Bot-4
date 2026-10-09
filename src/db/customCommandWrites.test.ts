import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./customCommands', () => ({
  addCustomCommand: vi.fn(),
  updateCustomCommand: vi.fn(),
  removeCustomCommand: vi.fn(),
  updateOwnCustomCommand: vi.fn(),
  removeOwnCustomCommand: vi.fn(),
  discardOwnNewCustomCommand: vi.fn(),
  assignUserToCommand: vi.fn(),
  assignUsersToCommand: vi.fn(),
  unassignUserFromCommand: vi.fn(),
}));
vi.mock('./customCommandCache', () => ({ invalidateCustomCommandLookupCache: vi.fn() }));

import {
  addCustomCommand as addCustomCommandRecord,
  updateCustomCommand as updateCustomCommandRecord,
  removeCustomCommand as removeCustomCommandRecord,
  updateOwnCustomCommand as updateOwnCustomCommandRecord,
  removeOwnCustomCommand as removeOwnCustomCommandRecord,
  discardOwnNewCustomCommand as discardOwnNewCustomCommandRecord,
  assignUserToCommand as assignUserToCommandRecord,
  assignUsersToCommand as assignUsersToCommandRecord,
  unassignUserFromCommand as unassignUserFromCommandRecord,
} from './customCommands';
import { invalidateCustomCommandLookupCache } from './customCommandCache';
import {
  addCustomCommand, updateCustomCommand, removeCustomCommand, updateOwnCustomCommand, removeOwnCustomCommand,
  discardOwnNewCustomCommand, assignUserToCommand, assignUsersToCommand, unassignUserFromCommand,
} from './customCommandWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(addCustomCommandRecord).mockResolvedValue(1);
  vi.mocked(updateCustomCommandRecord).mockResolvedValue(undefined);
  vi.mocked(removeCustomCommandRecord).mockResolvedValue(undefined);
  vi.mocked(assignUserToCommandRecord).mockResolvedValue(undefined);
  vi.mocked(assignUsersToCommandRecord).mockResolvedValue(undefined);
  vi.mocked(unassignUserFromCommandRecord).mockResolvedValue(undefined);
});

// ─── addCustomCommand / updateCustomCommand / removeCustomCommand ─────────────
// ─── assignUserToCommand / assignUsersToCommand / unassignUserFromCommand ─────
//
// customCommands.ts is a pure DB layer with no cache knowledge (see the header comment
// of customCommandWrites.ts); these tests verify its wrappers invalidate the
// custom-command lookup cache after each write.

describe('addCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    const id = await addCustomCommand('!clap', 'Clap!', true, false);
    expect(id).toBe(1);
    expect(addCustomCommandRecord).toHaveBeenCalledWith('!clap', 'Clap!', true, false);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without calling invalidate', async () => {
    vi.mocked(addCustomCommandRecord).mockRejectedValue(new Error('DB error'));
    await expect(addCustomCommand('!clap', 'Clap!', true, false)).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

describe('updateCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await updateCustomCommand(1, '!clap', 'Clap!', true, false);
    expect(updateCustomCommandRecord).toHaveBeenCalledWith(1, '!clap', 'Clap!', true, false);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

describe('removeCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await removeCustomCommand(1);
    expect(removeCustomCommandRecord).toHaveBeenCalledWith(1);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

describe('updateOwnCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    vi.mocked(updateOwnCustomCommandRecord).mockResolvedValueOnce(undefined);
    await updateOwnCustomCommand(1, '!clap', 'Clap!', 'user1');
    expect(updateOwnCustomCommandRecord).toHaveBeenCalledWith(1, '!clap', 'Clap!', 'user1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('does not invalidate the cache when the ownership check denies the update', async () => {
    vi.mocked(updateOwnCustomCommandRecord).mockRejectedValueOnce(new Error('denied'));
    await expect(updateOwnCustomCommand(1, '!clap', 'Clap!', 'user1')).rejects.toThrow('denied');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

describe('removeOwnCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    vi.mocked(removeOwnCustomCommandRecord).mockResolvedValueOnce(undefined);
    await removeOwnCustomCommand(1, 'user1');
    expect(removeOwnCustomCommandRecord).toHaveBeenCalledWith(1, 'user1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('does not invalidate the cache when the ownership check denies the delete', async () => {
    vi.mocked(removeOwnCustomCommandRecord).mockRejectedValueOnce(new Error('denied'));
    await expect(removeOwnCustomCommand(1, 'user1')).rejects.toThrow('denied');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

describe('discardOwnNewCustomCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    vi.mocked(discardOwnNewCustomCommandRecord).mockResolvedValueOnce(undefined);
    await discardOwnNewCustomCommand(1, 'user1');
    expect(discardOwnNewCustomCommandRecord).toHaveBeenCalledWith(1, 'user1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('does not invalidate the cache when the cleanup is denied', async () => {
    vi.mocked(discardOwnNewCustomCommandRecord).mockRejectedValueOnce(new Error('denied'));
    await expect(discardOwnNewCustomCommand(1, 'user1')).rejects.toThrow('denied');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

describe('assignUserToCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await assignUserToCommand(1, 'user1');
    expect(assignUserToCommandRecord).toHaveBeenCalledWith(1, 'user1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

describe('assignUsersToCommand', () => {
  it('calls the record function and invalidates the cache once, even for an empty array', async () => {
    await assignUsersToCommand(1, []);
    expect(assignUsersToCommandRecord).toHaveBeenCalledWith(1, []);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});

describe('unassignUserFromCommand', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await unassignUserFromCommand(1, 'user1');
    expect(unassignUserFromCommandRecord).toHaveBeenCalledWith(1, 'user1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });
});
