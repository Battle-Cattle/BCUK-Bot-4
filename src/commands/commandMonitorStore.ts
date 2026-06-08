/** Platform a command was triggered from. */
export type CommandTestSource = 'twitch' | 'discord' | 'tiktok';

/** A single recorded command execution for the monitor panel. */
export interface CommandTestEntry {
  id: number;
  source: CommandTestSource;
  command: string;
  response: string;
  channel: string | null;
  user: string | null;
  createdAt: Date;
}

const MAX_COMMAND_TEST_ENTRIES = 30;
const entries: CommandTestEntry[] = [];
let nextEntryId = 1;

/** Prepends an entry to the in-memory monitor ring buffer (capped at 30). */
export function recordCommandTestEntry(entry: Omit<CommandTestEntry, 'id' | 'createdAt'>): void {
  entries.unshift({
    id: nextEntryId++,
    ...entry,
    createdAt: new Date(),
  });

  if (entries.length > MAX_COMMAND_TEST_ENTRIES) {
    entries.length = MAX_COMMAND_TEST_ENTRIES;
  }
}

/** Returns a snapshot of the recent command monitor entries (newest first). */
export function getRecentCommandTestEntries(): CommandTestEntry[] {
  return entries.map((entry) => ({
    ...entry,
    createdAt: new Date(entry.createdAt),
  }));
}
