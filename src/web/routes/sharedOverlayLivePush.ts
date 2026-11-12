import { onStatusChanged } from '../../shared/statusStore';
import { broadcastToChannel } from './sseChannel';
import { sharedConnections } from './sharedOverlaySource';
import { isStreamerLive } from './sharedOverlayLiveState';

// Pushes live-state changes to the connected shared overlays (#917). A login's state on connect
// travels in the init message (see sharedOverlaySource.ts); this sends only later changes.

/** The live state last seen for each connected login, to send only changes. */
const lastSeen = new Map<string, boolean>();

/**
 * Sends `{ type: 'live', live }` to the overlays of every login whose live state changed since it
 * was last seen, and forgets logins with no overlay connected.
 */
function pushLiveChanges(): void {
  for (const login of [...lastSeen.keys()]) if (!sharedConnections.has(login)) lastSeen.delete(login);
  for (const login of sharedConnections.keys()) {
    const live = isStreamerLive(login);
    // A login seen for the first time got its state in the init message; only remember it.
    if (lastSeen.has(login) && lastSeen.get(login) !== live) broadcastToChannel(sharedConnections, login, { type: 'live', live });
    lastSeen.set(login, live);
  }
}

onStatusChanged(pushLiveChanges);
