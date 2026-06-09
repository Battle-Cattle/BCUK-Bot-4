import { createLogger } from '../shared/logger';
import { extractCommand } from './commandUtils';

const log = createLogger('Twitch');

const COUNTDOWN_COMMAND = '!321';
const STEPS = ['3', '2', '1', 'Go!'];
const DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CountdownTwitchRuntime {
  send: (channel: string, message: string) => Promise<void>;
}
let _twitchRuntime: CountdownTwitchRuntime | null = null;

export function registerCountdownTwitchRuntime(runtime: CountdownTwitchRuntime): void {
  _twitchRuntime = runtime;
}

export async function executeCountdownForTwitch(channel: string, rawMessage: string, isMod: boolean): Promise<void> {
  if (!isMod) return;
  if (extractCommand(rawMessage) !== COUNTDOWN_COMMAND) return;
  const runtime = _twitchRuntime;
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
