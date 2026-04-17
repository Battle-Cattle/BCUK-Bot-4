export type CommandTestSource = 'twitch' | 'discord';

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

export function getRecentCommandTestEntries(): CommandTestEntry[] {
  return entries.map((entry) => ({
    ...entry,
    createdAt: new Date(entry.createdAt),
  }));
}
