// Error types shared by the custom-command DB modules (re-exported from `db.ts`).

/** Thrown when a custom-command lookup/mutation matches no row. */
export class CommandNotFoundError extends Error {
  constructor(id: number) {
    super(`Command not found: ${id}`);
    this.name = 'CommandNotFoundError';
  }
}

/**
 * Thrown when a streamer below Mod tries to change a custom command they don't own outright
 * (see `isCommandSelfManageableBy`).
 */
export class CommandSelfServiceDeniedError extends Error {
  constructor(id: number) {
    super(`Command not self-manageable: ${id}`);
    this.name = 'CommandSelfServiceDeniedError';
  }
}

/** Thrown when one or more command strings are already taken by another command/counter. */
export class CommandConflictError extends Error {
  /** The command string(s) that caused the conflict. */
  readonly commands: string[];

  constructor(commands: string[]) {
    super(`Command already taken: ${commands.join(', ')}`);
    this.name = 'CommandConflictError';
    this.commands = commands;
  }
}
