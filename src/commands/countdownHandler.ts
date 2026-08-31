import { createLogger } from '../shared/logger';
import { resolveCommand } from './commandUtils';
import { createRuntimeRegistry, type TwitchSendRuntime } from './twitchRuntime';
import { createCooldownGate } from './cooldownGate';

const log = createLogger('Twitch');

const COUNTDOWN_COMMAND = '!321';
const STEPS = ['3', '2', '1', 'Go!'];
const DELAY_MS = 1000;

// ─── Cooldown ─────────────────────────────────────────────────────────────────
//
// Otherwise unthrottled: any chat member (no permission needed) can spam `!321`
// as fast as they can send it, each spawning a 4-step countdown chain into the
// shared global Twitch send queue. Gated per channel, mirroring
// counterHandler.ts's per-channel cooldown.

const countdownCooldown = createCooldownGate();

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
 * to `channel` with a one-second delay between steps. No-ops for other commands,
 * if no runtime has been registered, or if `channel` is still on cooldown from a
 * previous countdown. Aborts the remaining steps (without throwing) if a send
 * fails partway through.
 *
 * @param channel - Twitch channel to send the countdown steps to.
 * @param rawMessage - Raw chat message text.
 * @param precomputedCommand - Already-parsed command token from the caller's single
 *   `extractCommand` call for this message, or omit to parse `rawMessage` here.
 */
export async function executeCountdownForTwitch(
  channel: string,
  rawMessage: string,
  precomputedCommand?: string | null,
): Promise<void> {
  if (resolveCommand(rawMessage, precomputedCommand) !== COUNTDOWN_COMMAND) return;
  const runtime = countdownRuntime.get();
  if (!runtime) return;
  if (!countdownCooldown.tryClaim(`twitch:${channel}`)) return;
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
