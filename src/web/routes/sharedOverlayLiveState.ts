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

/** The live state last sent to each connected login's overlays (in init or a push), to send only changes. */
export const lastSentLive = new Map<string, boolean>();

/**
 * Records the live state an overlay was just told for a login, so the next status change is compared
 * against what it knows rather than being swallowed as a first sight.
 * @param login - Lowercase Twitch login the overlay is connected for.
 * @param live - The live state that was sent.
 */
export function noteLiveSent(login: string, live: boolean): void {
  lastSentLive.set(login, live);
}
