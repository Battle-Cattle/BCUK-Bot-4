import { ALERT_EVENT_TYPES } from '../../db';
import type { AlertEventType } from '../../db';

/** Redirect target used when the requester isn't a streamer, scoped to the alerts admin page. */
export const NOT_A_STREAMER_REDIRECT = '/alerts/settings?error=not_a_streamer';

/**
 * Validates an `:eventType` route param against the fixed set of alert event types.
 * Rejects a repeated field (arriving as an array), consistent with `parsePositiveIntId`.
 */
export function parseEventType(value: string | string[]): AlertEventType | null {
  if (Array.isArray(value)) return null;
  return (ALERT_EVENT_TYPES as readonly string[]).includes(value) ? (value as AlertEventType) : null;
}
