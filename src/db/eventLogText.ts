// Fits text to `streamer_event_log`'s bounded columns. Kept free of DB imports so callers and
// tests can use it without a pool.

/** `streamer_event_log.display_name` is `VARCHAR(255)`. */
const DISPLAY_NAME_MAX_CHARS = 255;
/** `streamer_event_log.detail` is `VARCHAR(500)`. */
const DETAIL_MAX_CHARS = 500;

/**
 * Shortens text to fit a `VARCHAR(maxChars)` column, ending it with `…` when cut. MySQL counts a
 * utf8mb4 column's length in characters, and a JS string's `length` (UTF-16 code units) is never
 * fewer, so a result of at most `maxChars` code units always fits. A surrogate pair (e.g. an emoji)
 * is never split.
 * @param value - The text to store.
 * @param maxChars - The column's declared length.
 * @returns `value` unchanged when it fits, otherwise its start plus `…`, within `maxChars`.
 */
export function truncateForColumn(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = maxChars - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${value.slice(0, end)}…`;
}

/**
 * Fits an event's text to `streamer_event_log`'s columns. MySQL runs in strict mode, so a value
 * longer than its column fails the insert outright: a redemption's detail is the reward title
 * plus whatever the viewer typed (up to 45 + 500 characters on Twitch), and an insert that failed
 * abandoned the whole redemption (#1012). Callers that also push the event live use the fitted
 * text, so the live feed matches what a reload shows.
 * @param displayName - The acting viewer's display name.
 * @param detail - The event's detail, or null.
 * @returns Both, cut to their columns' lengths (with `…` when cut).
 */
export function fitStreamerEventText(displayName: string, detail: string | null): { displayName: string; detail: string | null } {
  return {
    displayName: truncateForColumn(displayName, DISPLAY_NAME_MAX_CHARS),
    detail: detail === null ? null : truncateForColumn(detail, DETAIL_MAX_CHARS),
  };
}
