// Normalisation helpers for command trigger strings and required text fields.

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
