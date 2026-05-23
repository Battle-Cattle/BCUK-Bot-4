import mysql from 'mysql2/promise';

export type SqlExecutor = mysql.Pool | mysql.PoolConnection;

// ─── String normalisation ────────────────────────────────────────────────────

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

function normalizeCommand(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeCommandList(commandOrCommands: string | string[]): string[] {
  const commands = Array.isArray(commandOrCommands) ? commandOrCommands : [commandOrCommands];
  return commands
    .map((command) => normalizeCommand(command))
    .filter((command): command is string => command !== null);
}

export function normalizeCommandInputs(commandOrCommands: string | string[]): string[] {
  return Array.from(new Set(normalizeCommandList(commandOrCommands)));
}

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

export function isMysqlDuplicateEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const mysqlError = error as { code?: string; errno?: number };
  return mysqlError.code === 'ER_DUP_ENTRY' || mysqlError.errno === 1062;
}
