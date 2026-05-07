/**
 * Built-in command names that cannot be registered as custom commands or counters.
 * These are handled by dedicated handlers (e.g. multiCommandHandler.ts).
 */
export const RESERVED_BUILT_IN_COMMANDS: ReadonlySet<string> = new Set(['!multi']);

export class ReservedCommandError extends Error {
  constructor(trigger: string) {
    super(`'${trigger}' is a reserved built-in command and cannot be used as a custom command trigger.`);
    this.name = 'ReservedCommandError';
  }
}

export function assertNotReservedCommand(normalizedTrigger: string): void {
  if (RESERVED_BUILT_IN_COMMANDS.has(normalizedTrigger)) {
    throw new ReservedCommandError(normalizedTrigger);
  }
}
