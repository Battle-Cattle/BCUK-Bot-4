// The prefix rule every chat command shares: the runtime only treats a message as a command when
// its first character is one of these, and the panel only saves triggers that start with one.

/** First characters a command token can start with. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(['!', '#']);

/**
 * Checks whether text starts with a command prefix, so it can be (or name) a chat command.
 * @param text - A message or trigger, already trimmed.
 * @returns True if the first character is in {@link COMMAND_PREFIXES}.
 */
export function hasCommandPrefix(text: string): boolean {
  return COMMAND_PREFIXES.has(text.charAt(0));
}
