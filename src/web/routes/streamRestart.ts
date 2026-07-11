import { createLogger } from '../../shared/logger';
import { restartTwitchMonitor } from '../../twitch/monitor/twitchMonitor';

const log = createLogger('Web');

/** Fire-and-forget monitor restart serialised via a promise chain so concurrent
 * CRUD operations across the stream group/streamer routes cannot interleave
 * teardown and startTwitchMonitor. */
let restartChain: Promise<void> = Promise.resolve();

/** Queues a Twitch monitor restart, serialized after any restart already in flight. */
export function triggerRestart(): void {
  restartChain = restartChain
    .then(() => restartTwitchMonitor())
    .catch((err) => { log.error('TwitchMonitor restart error:', err); });
}
