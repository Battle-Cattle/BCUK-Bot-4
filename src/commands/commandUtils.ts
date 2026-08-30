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
 * Resolves the command token for a message, reusing an already-parsed value when the caller
 * (`handleTwitchMessage`/Discord's `messageCreate`) parsed it once up front for every handler
 * dispatched off the same message, instead of each handler re-parsing independently via
 * {@link extractCommand}.
 *
 * @param rawMessage - Raw message text, used to parse the command if `precomputed` is `undefined`.
 * @param precomputed - The already-parsed command (possibly `null`, if the message had none), or
 *   `undefined` to parse `rawMessage` fresh — the latter keeps every direct/test call to a
 *   handler working exactly as before, without having to pass this through.
 * @returns The resolved command token, or null if there is none.
 */
export function resolveCommand(rawMessage: string, precomputed?: string | null): string | null {
  return precomputed !== undefined ? precomputed : extractCommand(rawMessage);
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
