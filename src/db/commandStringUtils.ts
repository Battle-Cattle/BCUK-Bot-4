import mysql from 'mysql2/promise';

export type SqlExecutor = mysql.Pool | mysql.PoolConnection;

// ─── String normalisation ────────────────────────────────────────────────────

/**
 * Trims `value` and throws if the result is blank or exceeds `maxLength`.
 * @param value String to validate.
 * @param fieldName Name used in the thrown error message.
 * @param maxLength Optional maximum allowed length after trimming.
 * @returns The trimmed, non-blank string.
 * @throws If the trimmed value is blank or exceeds `maxLength`.
 */
export function requireTrimmedString(value: string, fieldName: string, maxLength?: number): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new Error(`Missing ${fieldName}`);
  }
  if (maxLength !== undefined && normalizedValue.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength}`);
  }
  return normalizedValue;
}

/** Trims and lowercases a single command string; returns null when the result is blank. */
export function normalizeCommand(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalizes (trims, lowercases) a single command string or list of command strings, dropping
 * any that become blank.
 * @param commandOrCommands A single command string or array of command strings.
 * @returns The normalized, non-blank command strings.
 */
export function normalizeCommandList(commandOrCommands: string | string[]): string[] {
  const commands = Array.isArray(commandOrCommands) ? commandOrCommands : [commandOrCommands];
  return commands
    .map((command) => normalizeCommand(command))
    .filter((command): command is string => command !== null);
}

/**
 * Normalizes a single command string or list of command strings and deduplicates the result.
 * @param commandOrCommands A single command string or array of command strings.
 * @returns The normalized, deduplicated, non-blank command strings.
 */
export function normalizeCommandInputs(commandOrCommands: string | string[]): string[] {
  return Array.from(new Set(normalizeCommandList(commandOrCommands)));
}

/**
 * Builds a comma-separated `?` placeholder list for use in a SQL `IN (...)` clause.
 * @param count Number of placeholders to generate.
 * @returns A string of `count` placeholders joined by `, `.
 */
export function buildInClausePlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class CommandNotFoundError extends Error {
  constructor(id: number) {
    super(`Command not found: ${id}`);
    this.name = 'CommandNotFoundError';
  }
}

export class CommandConflictError extends Error {
  readonly commands: string[];

  constructor(commands: string[]) {
    super(`Command already taken: ${commands.join(', ')}`);
    this.name = 'CommandConflictError';
    this.commands = commands;
  }
}

/**
 * Checks whether `error` is a MySQL duplicate-entry error (unique index violation).
 * @param error Value to check, typically a caught error.
 * @returns True if `error` is a MySQL `ER_DUP_ENTRY` / errno 1062 error.
 */
export function isMysqlDuplicateEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const mysqlError = error as { code?: string; errno?: number };
  return mysqlError.code === 'ER_DUP_ENTRY' || mysqlError.errno === 1062;
}
