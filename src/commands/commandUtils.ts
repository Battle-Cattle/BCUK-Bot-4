/**
 * Extracts the command token from a raw message: the first whitespace-delimited
 * token, lowercased. Leading/trailing whitespace is trimmed before splitting.
 *
 * @param rawMessage - Raw message text to extract the command from.
 * @returns The lowercased first token, or null if the message is empty/whitespace-only.
 */
export function extractCommand(rawMessage: string): string | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0]?.toLowerCase() ?? null;
}

/**
 * Extracts the argument text that follows the first token of a raw message.
 * Leading/trailing whitespace is trimmed; the result preserves the original
 * casing and internal spacing of the remaining text.
 *
 * @param rawMessage - Raw message text to extract arguments from.
 * @returns The trimmed text after the first token, or '' if there is none.
 */
export function extractArgs(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  if (!trimmed) return '';
  const firstSpaceIndex = trimmed.search(/\s/);
  if (firstSpaceIndex === -1) return '';
  return trimmed.slice(firstSpaceIndex).trim();
}
