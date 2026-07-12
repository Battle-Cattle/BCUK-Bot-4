import { createLogger } from '../shared/logger';
import { extractCommand } from './commandUtils';
import { createRuntimeRegistry, type TwitchSendRuntime } from './twitchRuntime';

const log = createLogger('Twitch');

const COUNTDOWN_COMMAND = '!321';
const STEPS = ['3', '2', '1', 'Go!'];
const DELAY_MS = 1000;

/** Delays for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CountdownTwitchRuntime = TwitchSendRuntime;

const countdownRuntime = createRuntimeRegistry<CountdownTwitchRuntime>();

/** Stores the Twitch chat runtime used to send `!321` countdown steps. Call once from index.ts after the Twitch bot is ready. */
export function registerCountdownTwitchRuntime(runtime: CountdownTwitchRuntime): void {
  countdownRuntime.register(runtime);
}

/**
 * Handles a `!321` countdown command by sending each step ("3", "2", "1", "Go!")
 * to `channel` with a one-second delay between steps. No-ops for other commands
 * or if no runtime has been registered. Aborts the remaining steps (without
 * throwing) if a send fails partway through.
 *
 * @param channel - Twitch channel to send the countdown steps to.
 * @param rawMessage - Raw chat message text.
 */
export async function executeCountdownForTwitch(channel: string, rawMessage: string): Promise<void> {
  if (extractCommand(rawMessage) !== COUNTDOWN_COMMAND) return;
  const runtime = countdownRuntime.get();
  if (!runtime) return;
  for (let i = 0; i < STEPS.length; i++) {
    if (i > 0) await sleep(DELAY_MS);
    try {
      await runtime.send(channel, STEPS[i]!);
    } catch (err) {
      log.error(`Countdown failed at '${STEPS[i]}' in ${channel}:`, err);
      return;
    }
  }
}
