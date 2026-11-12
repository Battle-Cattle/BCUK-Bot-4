import { getStatus } from '../../shared/statusStore';

// Whether a shared overlay's streamer is live (#917), so the overlay can preload faster while they
// are offline and slowly while they stream. The server-side preload budget stays the hard cap.

/**
 * Whether a streamer's channel is live, as the Twitch monitor reports it.
 * @param login - Lowercase Twitch login.
 * @returns True while the monitor holds the channel as live; false when offline or untracked.
 */
export function isStreamerLive(login: string): boolean {
  return getStatus(null).twitch[login]?.isLive === true;
}
