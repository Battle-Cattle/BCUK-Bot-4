// Shared by the companion app's acknowledgement and progress routes (advanced commands and
// channel-point redemptions): each pair takes the same body and answers the same way.
import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import { getStreamerByDiscordId } from '../../db';

/** Twitch redemption ids and advanced-command event ids are both UUIDs. */
const EVENT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MAX_ACK_ERROR_LENGTH = 255;

/** A validated acknowledgement body. */
interface CompanionAck {
  eventId: string;
  ok: boolean;
  error: string | null;
}

/**
 * Reads a well-formed `eventId` from a request body.
 * @param body - The parsed JSON body.
 * @returns The event id, or null if missing or malformed.
 */
function parseEventId(body: unknown): string | null {
  const { eventId } = (body ?? {}) as { eventId?: unknown };
  return typeof eventId === 'string' && EVENT_ID_PATTERN.test(eventId) ? eventId : null;
}

/**
 * Validates an acknowledgement body.
 * @param body - The parsed JSON body.
 * @returns The event id, outcome and error text (truncated), or null if malformed.
 */
function parseCompanionAck(body: unknown): CompanionAck | null {
  const eventId = parseEventId(body);
  const { ok, error } = (body ?? {}) as { ok?: unknown; error?: unknown };
  if (eventId === null || typeof ok !== 'boolean') return null;
  if (error != null && typeof error !== 'string') return null;
  return { eventId, ok, error: typeof error === 'string' ? error.slice(0, MAX_ACK_ERROR_LENGTH) : null };
}

/**
 * Whether an event belongs to the companion app's authenticated streamer.
 * @param req - Express request; `req.companionDiscordId` is set by `requireCompanionKey`.
 * @param eventId - The event id.
 * @param getOwnerStreamerId - Looks up which streamer the event belongs to.
 * @returns True if the event is known and the caller's streamer owns it.
 */
async function isCallersEvent(
  req: Request, eventId: string, getOwnerStreamerId: (eventId: string) => Promise<number | null>,
): Promise<boolean> {
  const [streamer, ownerId] = await Promise.all([
    getStreamerByDiscordId(req.companionDiscordId!),
    getOwnerStreamerId(eventId),
  ]);
  return ownerId !== null && ownerId === streamer?.id;
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
    if (!(await isCallersEvent(req, ack.eventId, handler.getOwnerStreamerId))) {
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

/** What one progress route plugs into {@link handleCompanionProgress}. */
export interface CompanionProgressHandler {
  /** Looks up which streamer the event belongs to, or null if it's unknown. */
  getOwnerStreamerId: (eventId: string) => Promise<number | null>;
  /** Restarts the event's acknowledgement timeout; returns false if it isn't waiting or was held too long. */
  extend: (eventId: string) => boolean;
  log: Logger;
  /** Log label for an unexpected failure. */
  failureLabel: string;
}

/**
 * Handles a companion progress ping, sent while the app is still running an event's actions:
 * validates the body, checks the event belongs to the authenticated streamer, then restarts the
 * event's acknowledgement timeout.
 * @param req - Express request; `req.companionDiscordId` is set by `requireCompanionKey`, JSON body
 *   `{ eventId }`.
 * @param res - `{ ok: true, extended }` (`extended` false when the event is no longer waiting, or
 *   has been held as long as allowed), 400 for a malformed body, 404 for an unknown or another
 *   streamer's event, or 500 on an error.
 * @param handler - The route's lookup and timeout extension.
 * @returns Resolves once the response is sent.
 */
export async function handleCompanionProgress(req: Request, res: Response, handler: CompanionProgressHandler): Promise<void> {
  const eventId = parseEventId(req.body);
  if (eventId === null) {
    res.status(400).json({ ok: false, error: 'Expected { eventId }' });
    return;
  }
  try {
    if (!(await isCallersEvent(req, eventId, handler.getOwnerStreamerId))) {
      res.status(404).json({ ok: false, error: 'event_not_found' });
      return;
    }
    res.json({ ok: true, extended: handler.extend(eventId) });
  } catch (err) {
    handler.log.error(handler.failureLabel, err);
    res.status(500).json({ ok: false, error: 'Failed to record progress' });
  }
}
