/** Minimal logger contract accepted by {@link fireAndForget} — matches `shared/logger`'s `createLogger()` return shape. */
interface ErrorLogger {
  error: (message: string, err: unknown) => void;
}

/**
 * Runs `promise` without awaiting it, logging (rather than throwing) if it rejects. Used so
 * one command handler's failure can't block or delay independent handlers dispatched
 * alongside it (e.g. Twitch/Discord message handling firing several handlers per message).
 *
 * @param promise - The in-flight promise to observe.
 * @param context - Log-line prefix identifying which handler the promise belongs to.
 * @param log - Logger to report the rejection to, so the log line keeps the caller's module tag.
 */
export function fireAndForget(promise: Promise<void>, context: string, log: ErrorLogger): void {
  promise.catch((err) => log.error(`${context}:`, err));
}

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
