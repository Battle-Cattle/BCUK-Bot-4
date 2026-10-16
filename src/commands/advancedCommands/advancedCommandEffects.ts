// Fires an advanced command's effects: the chat reply (chat uses only), an overlay video, an alerts-overlay alert,
// and the companion-app event. Every effect but the companion push is best-effort (logged, never
// thrown), so one failing effect can't stop the others or undo the points already spent.
import type { DbAdvancedCommand } from '../../db';
import { createLogger } from '../../shared/logger';
import { fillTemplate } from '../../shared/textTemplate';
import { pickWeightedRandom } from '../../audio/soundSelector';
import {
  alertRuntimeRegistry,
  companionRuntimeRegistry,
  overlayRuntimeRegistry,
} from '../../twitch/eventsub/twitchEventSubRuntime';
import { advancedCommandRuntimeRegistry } from './advancedCommandRuntime';

const log = createLogger('AdvancedCommands');

/** One use of a command, as passed to {@link runAdvancedCommandEffects}. */
export interface AdvancedCommandUse {
  command: DbAdvancedCommand;
  eventId: string;
  /** The streamer's Twitch login (the chat channel and overlay key). */
  channel: string;
  /** The streamer's Discord id (the companion stream key). */
  discordId: string;
  source: 'chat' | 'streamdeck';
  userLogin: string | null;
  /** Display name for `{user}`: the viewer, or the streamer for a Stream Deck use. */
  userName: string;
  args: string;
  pointsSpent: number;
  /** The viewer's balance after the use, or null for a Stream Deck use (no viewer). */
  balance: number | null;
  triggeredAt: Date;
}

/**
 * What happened to the companion push: `pushed` (an acknowledgement is now expected),
 * `no_companion` (the command wants the companion app but none is connected), or `disabled`.
 */
export type CompanionPushOutcome = 'pushed' | 'no_companion' | 'disabled';

/**
 * The `{placeholder}` values shared by the chat reply and the alert message.
 * @param use - The command use.
 * @returns The template variables.
 */
export function buildTemplateVars(use: AdvancedCommandUse): Record<string, string> {
  return {
    user: use.userName,
    args: use.args,
    arg: use.args.split(/\s+/)[0] ?? '',
    cost: String(use.pointsSpent),
    balance: use.balance === null ? '' : String(use.balance),
  };
}

/**
 * Posts the command's chat reply, if it has one. A Stream Deck use posts nothing to chat.
 * @param use - The command use.
 * @param vars - Template variables.
 */
async function sendReply(use: AdvancedCommandUse, vars: Record<string, string>): Promise<void> {
  const runtime = advancedCommandRuntimeRegistry.get();
  if (use.source !== 'chat' || !use.command.response || !runtime) return;
  try {
    await runtime.send(use.channel, fillTemplate(use.command.response, vars));
  } catch (err) {
    log.error(`Failed to send reply for advanced command ${use.command.id} in ${use.channel}:`, err);
  }
}

/**
 * Plays one of the command's overlay videos, picked by weight, in the video overlay.
 * @param use - The command use.
 */
function pushVideo(use: AdvancedCommandUse): void {
  const { videos, streamerId } = use.command;
  if (videos.length === 0) return;
  const filename = pickWeightedRandom(videos.map((v) => ({ file: v.filename, weight: v.weight })));
  overlayRuntimeRegistry.get()?.pushOverlayEvent(use.channel, `/overlay/videos/${streamerId}/${filename}`);
}

/**
 * Shows the command's alert, if it has one, in the alerts overlay.
 * @param use - The command use.
 * @param vars - Template variables for the alert message.
 */
function pushAlert(use: AdvancedCommandUse, vars: Record<string, string>): void {
  const { alert, streamerId } = use.command;
  if (!alert) return;
  // Same URLs `alertAssetUrl` builds for the event alerts (served by GET /alerts/assets/...).
  const assetUrl = (f: string | null): string | null => (f ? `/alerts/assets/${streamerId}/${f}` : null);
  alertRuntimeRegistry.get()?.pushAlertEvent(use.channel, {
    type: 'advanced_command',
    message: fillTemplate(alert.messageTemplate, vars),
    imageUrl: assetUrl(alert.imageFilename),
    soundUrl: assetUrl(alert.soundFilename),
    durationMs: alert.durationMs,
    textAnimation: alert.textAnimation,
  });
}

/**
 * Sends the use to the streamer's companion app when the command has the companion effect on.
 * @param use - The command use.
 * @returns Whether the event was pushed, and if not, why.
 */
function pushCompanion(use: AdvancedCommandUse): CompanionPushOutcome {
  if (!use.command.companionEnabled) return 'disabled';
  const runtime = advancedCommandRuntimeRegistry.get();
  const companion = companionRuntimeRegistry.get();
  if (!runtime?.hasCompanionConnection(use.discordId) || !companion) return 'no_companion';
  companion.pushCompanionEvent(use.discordId, {
    type: 'advanced_command',
    id: use.eventId,
    commandId: use.command.id,
    commandName: use.command.name,
    source: use.source,
    userLogin: use.userLogin,
    userName: use.source === 'chat' ? use.userName : null,
    args: use.args || null,
    pointsSpent: use.pointsSpent,
    parameters: Object.fromEntries(use.command.params.map((p) => [p.key, p.value])),
    ackRequired: true,
    triggeredAt: use.triggeredAt.toISOString(),
  });
  return 'pushed';
}

/**
 * Fires every effect of a command use. The companion push goes first, and `hooks.onPushed` runs
 * straight after it — before the chat reply is awaited — so the caller can start the
 * acknowledgement timer before a fast companion app could possibly answer. The overlays and chat
 * reply follow.
 * @param use - The command use.
 * @param hooks - `onPushed`, called synchronously once the companion event has been pushed.
 * @returns The companion push outcome; `no_companion` means the caller should refund.
 */
export async function runAdvancedCommandEffects(
  use: AdvancedCommandUse,
  hooks: { onPushed?: () => void } = {},
): Promise<CompanionPushOutcome> {
  const vars = buildTemplateVars(use);
  const outcome = pushCompanion(use);
  if (outcome === 'pushed') hooks.onPushed?.();
  try {
    pushVideo(use);
    pushAlert(use, vars);
  } catch (err) {
    log.error(`Failed to push overlay effects for advanced command ${use.command.id}:`, err);
  }
  await sendReply(use, vars);
  return outcome;
}
