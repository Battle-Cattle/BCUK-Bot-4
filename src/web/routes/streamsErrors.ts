import type { Response } from 'express';
import type { Logger } from 'winston';
import { logAndRedirectError } from './errorHandling';

/** Path every streams-page error redirect targets. */
const STREAMS_BASE_PATH = '/admin/streams';

/**
 * Every `error` query-param code the streams page — and the routes that
 * redirect back to it (stream groups, streamers, and the admin EventSub
 * disconnect) — can produce. Kept as a single source of truth so a typo'd
 * code fails to compile instead of silently rendering no error message.
 */
export const STREAMS_ERROR_CODES = [
  'missing_fields',
  'invalid_id',
  'add_group_failed',
  'update_group_failed',
  'remove_group_failed',
  'add_streamer_failed',
  'remove_streamer_failed',
  'eventsub_disconnect_failed',
] as const;

export type StreamsErrorCode = (typeof STREAMS_ERROR_CODES)[number];

/** Human-readable message for each {@link StreamsErrorCode}. */
export const STREAMS_ERROR_MESSAGES: Record<StreamsErrorCode, string> = {
  missing_fields:             'All required fields must be filled in.',
  invalid_id:                 'Invalid ID — please try again.',
  add_group_failed:           'Failed to add stream group. Please try again.',
  update_group_failed:        'Failed to update stream group. Please try again.',
  remove_group_failed:        'Failed to remove stream group. Please try again.',
  add_streamer_failed:        'Failed to add streamer. Please try again.',
  remove_streamer_failed:     'Failed to remove streamer. Please try again.',
  eventsub_disconnect_failed: 'Failed to disconnect Twitch account. Please try again.',
};

/**
 * Redirects to the streams page with a type-checked `error` query param, for
 * a validation failure that has no caught error to log.
 * @param res - Express response object.
 * @param errorCode - One of {@link StreamsErrorCode}.
 */
export function redirectStreamsInvalid(res: Response, errorCode: StreamsErrorCode): void {
  res.redirect(`${STREAMS_BASE_PATH}?error=${errorCode}`);
}

/**
 * Logs a caught error and redirects to the streams page with a type-checked
 * `error` query param.
 * @param res - Express response object.
 * @param log - Logger to record the error on.
 * @param logLabel - Message prefix passed to `log.error`.
 * @param err - The caught error value, forwarded to `log.error` unchanged.
 * @param errorCode - One of {@link StreamsErrorCode}.
 */
export function redirectStreamsFailure(
  res: Response,
  log: Logger,
  logLabel: string,
  err: unknown,
  errorCode: StreamsErrorCode,
): void {
  logAndRedirectError({ res, log, logLabel, err, basePath: STREAMS_BASE_PATH, errorCode });
}
