// Shared by the companion app's acknowledgement routes (advanced commands and channel-point
// redemptions): both take the same `{ eventId, ok, error? }` body and answer the same way.
import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import { getStreamerByDiscordId } from '../../db';

/** Twitch redemption ids and advanced-command event ids are both UUIDs. */
const EVENT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MAX_ACK_ERROR_LENGTH = 255;

/** A validated acknowledgement body. */
export interface CompanionAck {
  eventId: string;
  ok: boolean;
  error: string | null;
}

/**
 * Validates an acknowledgement body.
 * @param body - The parsed JSON body.
 * @returns The event id, outcome and error text (truncated), or null if malformed.
 */
export function parseCompanionAck(body: unknown): CompanionAck | null {
  const { eventId, ok, error } = (body ?? {}) as { eventId?: unknown; ok?: unknown; error?: unknown };
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId) || typeof ok !== 'boolean') return null;
  if (error != null && typeof error !== 'string') return null;
  return { eventId, ok, error: typeof error === 'string' ? error.slice(0, MAX_ACK_ERROR_LENGTH) : null };
}

/** What one acknowledgement route plugs into {@link handleCompanionAck}. */
export interface CompanionAckHandler {
  /** Looks up which streamer the event belongs to, or null if it's unknown. */
  getOwnerStreamerId: (eventId: string) => Promise<number | null>;
  /** Applies the acknowledgement; resolves true if it resolved the event, false if already resolved. */
  acknowledge: (eventId: string, ack: { ok: boolean; error: string | null }) => Promise<boolean>;
  log: Logger;
  /** Log label for an unexpected failure. */
  failureLabel: string;
}

/**
 * Handles a companion acknowledgement request: validates the body, checks the event belongs to
 * the authenticated streamer, then applies it.
 * @param req - Express request; `req.companionDiscordId` is set by `requireCompanionKey`, JSON body
 *   `{ eventId, ok, error? }`.
 * @param res - `{ ok: true, resolved }` (`resolved` false when the event was already resolved, e.g.
 *   after the acknowledgement timeout), 400 for a malformed body, 404 for an unknown or another
 *   streamer's event, or 500 on an error.
 * @param handler - The route's lookups and acknowledgement.
 * @returns Resolves once the response is sent.
 */
export async function handleCompanionAck(req: Request, res: Response, handler: CompanionAckHandler): Promise<void> {
  const ack = parseCompanionAck(req.body);
  if (!ack) {
    res.status(400).json({ ok: false, error: 'Expected { eventId, ok, error? }' });
    return;
  }
  try {
    const [streamer, ownerId] = await Promise.all([
      getStreamerByDiscordId(req.companionDiscordId!),
      handler.getOwnerStreamerId(ack.eventId),
    ]);
    if (ownerId === null || ownerId !== streamer?.id) {
      res.status(404).json({ ok: false, error: 'event_not_found' });
      return;
    }
    const resolved = await handler.acknowledge(ack.eventId, { ok: ack.ok, error: ack.error });
    res.json({ ok: true, resolved });
  } catch (err) {
    handler.log.error(handler.failureLabel, err);
    res.status(500).json({ ok: false, error: 'Failed to acknowledge' });
  }
}
