// Pure checks for a chat use of an advanced command: the viewer's role, the escalating cost, and
// the in-memory global/per-viewer cooldowns. Kept free of I/O so they're unit-tested directly.
import type { AdvancedCommandRole, DbAdvancedCommand } from '../../db';

/** The chat badges that decide whether a viewer meets a command's minimum role. */
export interface ChatRoleInfo {
  isBroadcaster: boolean;
  isMod: boolean;
  isVip: boolean;
  isSubscriber: boolean;
}

// Each role also covers every role above it: a mod can use a VIP command, and so on.
const ROLE_RANK: Record<AdvancedCommandRole, number> = { everyone: 0, subscriber: 1, vip: 2, moderator: 3 };

/**
 * Ranks a viewer by their highest badge, on the same scale as {@link ROLE_RANK}.
 * @param info - The viewer's badges.
 * @returns 0 (everyone) to 3 (moderator); the broadcaster ranks above every role.
 */
function viewerRank(info: ChatRoleInfo): number {
  if (info.isBroadcaster) return Number.POSITIVE_INFINITY;
  if (info.isMod) return ROLE_RANK.moderator;
  if (info.isVip) return ROLE_RANK.vip;
  return info.isSubscriber ? ROLE_RANK.subscriber : ROLE_RANK.everyone;
}

/**
 * Checks whether a viewer may use a command restricted to `minRole`. The broadcaster always can.
 * @param minRole - The command's minimum role.
 * @param info - The viewer's badges.
 * @returns True if allowed.
 */
export function hasRequiredRole(minRole: AdvancedCommandRole, info: ChatRoleInfo): boolean {
  return viewerRank(info) >= ROLE_RANK[minRole];
}

/**
 * The cost of the next use: the base cost plus `price_step` for each earlier use this stream,
 * capped at `max_cost` when set.
 * @param command - The command.
 * @param usesThisStream - Non-refunded chat uses earlier in the same stream.
 * @returns The point cost.
 */
export function computeCommandCost(
  command: Pick<DbAdvancedCommand, 'pointCost' | 'priceStep' | 'maxCost'>,
  usesThisStream: number,
): number {
  const cost = command.pointCost + command.priceStep * usesThisStream;
  return command.maxCost === null ? cost : Math.min(cost, command.maxCost);
}

/** In-memory cooldown tracking for advanced commands (single bot instance; see CLAUDE.md). */
export interface AdvancedCommandCooldowns {
  /** Seconds left before `login` may use the command again (0 when ready). */
  remainingSeconds: (command: CooldownCommand, login: string, now?: number) => number;
  /** Starts both cooldowns for a use by `login`. */
  claim: (command: CooldownCommand, login: string, now?: number) => void;
  /** Forgets every cooldown (tests and shutdown). */
  clear: () => void;
}

type CooldownCommand = Pick<DbAdvancedCommand, 'id' | 'globalCooldownSeconds' | 'userCooldownSeconds'>;

/**
 * Creates a cooldown store keyed by command (global) and command+viewer (per-user). Entries are
 * last-use timestamps, so changing a command's cooldown applies to uses already made.
 * @returns The store.
 */
export function createAdvancedCommandCooldowns(): AdvancedCommandCooldowns {
  const lastUse = new Map<string, number>();

  /** Seconds left on one cooldown, given its length and the key's last use. */
  const left = (key: string, seconds: number, now: number): number => {
    const last = lastUse.get(key);
    if (last === undefined || seconds <= 0) return 0;
    return Math.max(0, Math.ceil((last + seconds * 1000 - now) / 1000));
  };

  return {
    remainingSeconds: (command, login, now = Date.now()) => Math.max(
      left(`${command.id}`, command.globalCooldownSeconds, now),
      left(`${command.id}:${login}`, command.userCooldownSeconds, now),
    ),
    claim: (command, login, now = Date.now()) => {
      if (command.globalCooldownSeconds > 0) lastUse.set(`${command.id}`, now);
      if (command.userCooldownSeconds > 0) lastUse.set(`${command.id}:${login}`, now);
    },
    clear: () => lastUse.clear(),
  };
}

/**
 * A throttle for the bot's "you can't do that yet" chat notices, so a viewer spamming a command
 * gets one notice per window instead of one per message.
 * @param windowMs - Minimum time between notices for the same key.
 * @returns `tryClaim(key)`, true when a notice may be sent now, and `clear()`.
 */
export function createNoticeThrottle(windowMs: number): { tryClaim: (key: string, now?: number) => boolean; clear: () => void } {
  const sentAt = new Map<string, number>();
  return {
    tryClaim: (key, now = Date.now()) => {
      const last = sentAt.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      sentAt.set(key, now);
      // Bounded: drop stale entries once the map grows, so a long uptime can't grow it forever.
      if (sentAt.size > 1000) {
        for (const [k, t] of sentAt) if (now - t >= windowMs) sentAt.delete(k);
      }
      return true;
    },
    clear: () => sentAt.clear(),
  };
}
