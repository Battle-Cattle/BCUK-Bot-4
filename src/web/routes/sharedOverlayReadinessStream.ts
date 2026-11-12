import type { Response } from 'express';
import { Router } from 'express';
import { createLogger } from '../../shared/logger';
import { OVERLAY_STATUS_MAX_SSE_PER_STREAMER } from '../../shared/config';
import { getSessionUser } from '../session';
import { attachSseConnection, broadcastToChannel, onConnectionCountChange } from './sseChannel';
import { getReadinessSnapshot, onReadinessChange, type ReadinessSnapshot } from './sharedOverlayReadiness';
import { getSharedVideoEntries, sharedConnections } from './sharedOverlaySource';

// Live readiness stream for the shared videos admin page (#917). Mounted by sharedOverlayAdmin.ts
// behind the Manager gate, so only Managers can open it.

const log = createLogger('SharedOverlayReadinessStream');
export const router = Router();

/** Open admin streams, keyed by the viewing Manager's Discord id. */
export const readinessConnections = new Map<string, Set<Response>>();

/**
 * Builds the current snapshot from the enabled list and the connected overlays.
 * @returns The snapshot the admin page renders.
 */
async function currentSnapshot(): Promise<ReadinessSnapshot> {
  return getReadinessSnapshot(await getSharedVideoEntries(), new Set(sharedConnections.keys()));
}

/** Publish state: whether a run is in progress and whether another call arrived during it. */
const publishState = { running: false, again: false };

/**
 * Whether a publish was requested while one was running.
 * @returns True if another run is wanted.
 */
function anotherPublishWanted(): boolean {
  return publishState.again;
}

/**
 * Sends the current snapshot to every open admin stream.
 * @returns Resolves once sent; never rejects (a failed lookup is logged).
 */
async function publishOnce(): Promise<void> {
  try {
    const snapshot = await currentSnapshot();
    for (const key of [...readinessConnections.keys()]) broadcastToChannel(readinessConnections, key, snapshot);
  } catch (err) {
    log.error('Failed to publish shared overlay readiness:', err);
  }
}

/**
 * Publishes the current snapshot. Calls that arrive while a run is in progress are folded into one
 * more run afterwards (even if the earlier lookup failed), so a burst of reports costs few list
 * lookups and an accepted report is never left unpublished.
 * @returns Resolves once the publishing has settled; never rejects.
 */
async function publish(): Promise<void> {
  if (publishState.running) { publishState.again = true; return; }
  publishState.running = true;
  try {
    do {
      publishState.again = false;
      if (readinessConnections.size === 0) break;
      await publishOnce();
    } while (anotherPublishWanted());
  } finally {
    publishState.running = false;
  }
}

/** Counts change notifications, so a lookup can tell whether anything changed while it ran. */
let changeCount = 0;

/**
 * Records a change and publishes.
 * @returns Nothing; the publish runs in the background.
 */
function onChange(): void {
  changeCount++;
  void publish();
}

// Reports, list changes, and overlays connecting or disconnecting change what the page shows.
onReadinessChange(onChange);
onConnectionCountChange(sharedConnections, onChange);

/** Most times the first snapshot is looked up again because something changed during the lookup. */
const MAX_INITIAL_LOOKUPS = 3;

/**
 * Builds the first snapshot for a new stream. A change that arrives during the lookup would not be
 * published to this stream (it is not registered yet), so the lookup is repeated if one did.
 * @returns The snapshot, fresh as of the last lookup.
 */
async function initialSnapshot(): Promise<ReadinessSnapshot> {
  for (let tries = 1; ; tries++) {
    const seen = changeCount;
    const snapshot = await currentSnapshot();
    if (changeCount === seen || tries >= MAX_INITIAL_LOOKUPS) return snapshot;
  }
}

/**
 * GET /overlay/shared/settings/readiness/events — SSE stream of readiness snapshots for the
 * admin page: one on connect, then one whenever a report arrives or an overlay connects or
 * disconnects. Limited per Manager like the other status streams.
 * @param req - Express request; reads the session user.
 * @param res - Express response; upgrades to `text/event-stream`, or replies 429 over the limit
 *   or 500 if the first snapshot cannot be built.
 */
router.get('/readiness/events', async (req, res) => {
  const key = getSessionUser(req).discordId;
  let snapshot: ReadinessSnapshot;
  try {
    snapshot = await initialSnapshot();
  } catch (err) {
    log.error('Failed to build shared overlay readiness:', err);
    res.status(500).end();
    return;
  }
  const attached = attachSseConnection(req, res, {
    connections: readinessConnections, key, maxPerChannel: OVERLAY_STATUS_MAX_SSE_PER_STREAMER,
  });
  if (attached) res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
});
