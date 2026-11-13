import { onStatusChanged } from '../../shared/statusStore';
import { broadcastToChannel } from './sseChannel';
import { sharedConnections } from './sharedOverlaySource';
import { isStreamerLive, lastSentLive, noteLiveSent } from './sharedOverlayLiveState';

// Pushes live-state changes to the connected shared overlays (#917). A login's state on connect
// travels in the init message (see sharedOverlaySource.ts), which records it; this sends only later changes.

/**
 * Sends `{ type: 'live', live }` to the overlays of every login whose live state changed since it
 * was last seen, and forgets logins with no overlay connected.
 */
function pushLiveChanges(): void {
  for (const login of [...lastSentLive.keys()]) if (!sharedConnections.has(login)) lastSentLive.delete(login);
  for (const login of sharedConnections.keys()) {
    const live = isStreamerLive(login);
    // A login whose init has not been sent yet gets its state there; sendInit records what it sent.
    if (!lastSentLive.has(login) || lastSentLive.get(login) === live) continue;
    broadcastToChannel(sharedConnections, login, { type: 'live', live });
    noteLiveSent(login, live);
  }
}

onStatusChanged(pushLiveChanges);
