import { createLogger } from '../../shared/logger';
import { restartTwitchMonitor } from '../../twitch/monitor/twitchMonitor';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';

const log = createLogger('Web');

/** Fire-and-forget monitor restart serialised via a promise chain so concurrent
 * CRUD operations across the stream group/streamer routes cannot interleave
 * teardown and startTwitchMonitor. */
let restartChain: Promise<void> = Promise.resolve();

/** Queues a Twitch monitor restart, serialized after any restart already in flight. */
export function triggerRestart(): void {
  restartChain = restartChain
    .then(() => restartTwitchMonitor())
    .catch((err: unknown) => { log.error('TwitchMonitor restart error:', err); });
}

/**
 * After a streamer (or a stream group with its streamers) was deleted: restarts the monitor, and
 * reloads EventSub so the deleted streamers' WebSockets and subscriptions stop. Without the reload
 * their connections kept running until some unrelated reload, dispatching follows, subs and
 * redemptions for a streamer id that no longer exists (#1008).
 */
export function afterStreamersRemoved(): void {
  triggerRestart();
  reloadEventSubSubscriptions();
}

