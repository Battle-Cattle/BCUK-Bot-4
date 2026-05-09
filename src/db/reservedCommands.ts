export interface BuiltInCommandMeta {
  description: string;
}

/**
 * Registry of built-in commands. Add an entry here whenever a new hardcoded
 * command is introduced so it is automatically protected from being claimed as
 * a custom command or counter trigger.
 */
export const BUILT_IN_COMMANDS: Readonly<Record<string, BuiltInCommandMeta>> = {
  '!multi': { description: 'Posts a multitwitch.tv link for the active stream group' },
  '!so': { description: 'Posts a Twitch shoutout for a named streamer (mod/broadcaster only)' },
};

export const RESERVED_BUILT_IN_COMMANDS: ReadonlySet<string> = new Set(Object.keys(BUILT_IN_COMMANDS));

export class ReservedCommandError extends Error {
  constructor(trigger: string) {
    super(`'${trigger}' is a reserved built-in command and cannot be used as a custom command trigger.`);
    this.name = 'ReservedCommandError';
  }
}

export function assertNotReservedCommand(trigger: string): void {
  const normalized = trigger.trim().toLowerCase();
  if (RESERVED_BUILT_IN_COMMANDS.has(normalized)) {
    throw new ReservedCommandError(normalized);
  }
}
