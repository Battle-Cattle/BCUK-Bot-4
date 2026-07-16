import { ALERT_EVENT_TYPES } from '../../db';
import type { AlertEventType } from '../../db';

/** Redirect target used when the requester isn't a streamer, scoped to the alerts admin page. */
export const NOT_A_STREAMER_REDIRECT = '/alerts/settings?error=not_a_streamer';

/**
 * Validates `value` against a fixed list of allowed values, returning `fallback` (default
 * `null`) for anything not in the list. Shared by every alerts-settings field that's validated
 * against a fixed enum-like array (event type, text animation, ...) so each doesn't need its
 * own bespoke includes-and-cast check.
 * @param value - The raw value to validate (e.g. a route param or form field).
 * @param allowed - The fixed list of acceptable values.
 * @param fallback - Value to return when `value` isn't in `allowed`. Defaults to `null`.
 * @returns `value` narrowed to `T` if allowed, otherwise `fallback`.
 */
export function parseEnumField<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T;
export function parseEnumField<T extends string>(value: unknown, allowed: readonly T[], fallback?: null): T | null;
export function parseEnumField<T extends string>(value: unknown, allowed: readonly T[], fallback: T | null = null): T | null {
  return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

/**
 * Validates an `:eventType` route param against the fixed set of alert event types.
 * Rejects a repeated field (arriving as an array), consistent with `parsePositiveIntId`.
 */
export function parseEventType(value: string | string[]): AlertEventType | null {
  if (Array.isArray(value)) return null;
  return parseEnumField(value, ALERT_EVENT_TYPES);
}
