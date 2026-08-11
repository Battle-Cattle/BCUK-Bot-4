import type { TimerCommandForScheduler } from '../../db';

// ─── Per-command Shared Chat cooldown ────────────────────────────────────────
//
// When several of one timer's assigned streamers are merged into the same Twitch Shared Chat
// session (multitwitch), each of that timer's assigned channels otherwise keeps firing on its own
// independent schedule — and since Shared Chat shows every participating channel's messages in one
// merged view, that stacks up into the same command posting several times in a few minutes. This
// caps a given timer to firing at most once per its own `interval_seconds` into a given session —
// as if that whole session were one channel, for this command specifically — and rotates fairly
// among the timer's channels sharing it (see `applyCommandSessionCooldown`) so each gets a turn
// instead of one dominating. Scoped per (timer id, session id): a *different* timer assigned to the
// same shared-chat streamers gets its own independent cooldown, sized to its own interval, and
// never competes with this one for a turn.

interface CommandSessionCooldown {
  firedAt: number;
  /** The interval (ms) that was actually applied when this cooldown was reserved — needed to prune it correctly later, since different timers (and a live-edited interval) can each imply a different cooldown length. */
  cooldownMs: number;
}

const commandSessionLastFiredAt = new Map<string, CommandSessionCooldown>();

/** Composite key for {@link commandSessionLastFiredAt}: one cooldown per (timer, Shared Chat session). */
function commandSessionKey(timerId: number, sessionId: string): string {
  return `${timerId}::${sessionId}`;
}

/** A stale command-session cooldown entry is kept around for this many multiples of its own cooldown length before being pruned, so the map doesn't grow unbounded as Shared Chat sessions come and go over long uptimes. */
const COMMAND_SESSION_COOLDOWN_PRUNE_FACTOR = 10;

/** Drops command-session cooldown entries old enough (relative to their own recorded cooldown length) that the session or assignment behind them is almost certainly gone. */
function pruneStaleCommandSessionCooldowns(now: number): void {
  for (const [key, entry] of commandSessionLastFiredAt) {
    if (now - entry.firedAt > entry.cooldownMs * COMMAND_SESSION_COOLDOWN_PRUNE_FACTOR) {
      commandSessionLastFiredAt.delete(key);
    }
  }
}

// ─── Cross-command channel floor ─────────────────────────────────────────────
//
// Independent of Shared Chat: if a single Twitch channel has several *different* timer commands
// assigned to it, each fires on its own schedule with nothing otherwise stopping two of them from
// landing seconds apart. This enforces a minimum gap between any two *different* commands posting
// into the same channel, and — like the Shared Chat cooldown above — lets whichever has waited
// longest go first. It deliberately does not slow down a single command's own cadence: the floor
// only applies when the channel's last post came from a *different* timer than the one about to
// post now, so a lone timer with a short interval (as low as `chk_timer_command_interval`'s 60s
// floor) is never throttled below its own configured interval just for being alone on its channel.

const CHANNEL_MIN_SPACING_MS = 120_000;

interface ChannelCooldown {
  firedAt: number;
  timerId: number;
}

const channelLastFiredAt = new Map<string, ChannelCooldown>();

const CHANNEL_MIN_SPACING_PRUNE_MS = 10 * CHANNEL_MIN_SPACING_MS;

/** Drops channel-floor entries older than {@link CHANNEL_MIN_SPACING_PRUNE_MS} so the map doesn't grow unbounded as channels stop being assigned any timer over long uptimes. */
function pruneStaleChannelCooldowns(now: number): void {
  for (const [channel, entry] of channelLastFiredAt) {
    if (now - entry.firedAt > CHANNEL_MIN_SPACING_PRUNE_MS) channelLastFiredAt.delete(channel);
  }
}

/** Drops every stale cooldown entry in both maps. Call once per scheduler tick. */
export function pruneStaleCooldowns(now: number): void {
  pruneStaleCommandSessionCooldowns(now);
  pruneStaleChannelCooldowns(now);
}

/** Releases a command-session cooldown reservation if it's still the one made at `now` (not a newer one made since). */
function releaseCommandSessionReservation(sessionKey: string | null, now: number): void {
  if (!sessionKey) return;
  const entry = commandSessionLastFiredAt.get(sessionKey);
  if (entry && entry.firedAt === now) commandSessionLastFiredAt.delete(sessionKey);
}

/** Releases a channel-floor reservation if it's still the one made at `now` for `timerId` (not a newer/different one made since). */
function releaseChannelReservation(channel: string, timerId: number, now: number): void {
  const entry = channelLastFiredAt.get(channel);
  if (entry && entry.firedAt === now && entry.timerId === timerId) channelLastFiredAt.delete(channel);
}

/** Clears all cooldown state in both maps. Call on scheduler stop. */
export function clearCooldowns(): void {
  commandSessionLastFiredAt.clear();
  channelLastFiredAt.clear();
}

/** A row picked to fire this tick, paired with the reservations the caller must release if the send doesn't succeed. */
export interface PickedRow {
  row: TimerCommandForScheduler;
  /** The {@link commandSessionKey} reserved for this pick, or null if its channel isn't in a Shared Chat session. */
  sessionKey: string | null;
}

/** Resolves a row's current `lastFiredAt`, used to pick whichever of a group of contending rows has waited longest. Supplied by the caller since that state lives in the scheduler, not here. */
export type LastFiredAtLookup = (row: TimerCommandForScheduler) => number;

/** Picks whichever of `rows` has gone longest without firing (oldest per `lastFiredAtOf`), breaking ties by keeping the first. */
function pickLongestWaiting(rows: readonly TimerCommandForScheduler[], lastFiredAtOf: LastFiredAtLookup): TimerCommandForScheduler {
  return rows.reduce((oldest, row) => (lastFiredAtOf(row) < lastFiredAtOf(oldest) ? row : oldest));
}

/**
 * Layer 1 of {@link pickRowsToFire}: groups `eligibleRows` by (timer id, Shared Chat session), and
 * for a group off its own cooldown (sized to that timer's `interval_seconds`), picks the row that's
 * gone longest without firing and reserves the cooldown. Rows whose channel isn't in a session pass
 * straight through untouched. See the module doc above `commandSessionLastFiredAt`.
 * @param eligibleRows - Rows that already passed their own per-timer fire-gate check.
 * @param sessionIdByChannel - Each row's channel's resolved Shared Chat session id (or null).
 * @param now - Current time in epoch ms, shared across the whole tick.
 * @param lastFiredAtOf - Resolves a row's current `lastFiredAt`, for the longest-waiting tie-break.
 * @returns One entry per row that cleared this layer, paired with the command-session cooldown key
 *   reserved for it (or null if its channel isn't in a session).
 */
function applyCommandSessionCooldown(
  eligibleRows: readonly TimerCommandForScheduler[],
  sessionIdByChannel: ReadonlyMap<string, string | null>,
  now: number,
  lastFiredAtOf: LastFiredAtLookup,
): PickedRow[] {
  const survivors: PickedRow[] = [];
  const bySessionAndTimer = new Map<string, TimerCommandForScheduler[]>();

  for (const row of eligibleRows) {
    const sessionId = sessionIdByChannel.get(row.channel) ?? null;
    if (!sessionId) {
      survivors.push({ row, sessionKey: null });
      continue;
    }
    const key = commandSessionKey(row.id, sessionId);
    const group = bySessionAndTimer.get(key);
    if (group) group.push(row); else bySessionAndTimer.set(key, [row]);
  }

  for (const [key, rows] of bySessionAndTimer) {
    const cooldownMs = rows[0].interval_seconds * 1000;
    const entry = commandSessionLastFiredAt.get(key);
    if (entry && now - entry.firedAt < cooldownMs) continue;

    const picked = pickLongestWaiting(rows, lastFiredAtOf);
    commandSessionLastFiredAt.set(key, { firedAt: now, cooldownMs }); // provisional — released by releaseReservations on failure
    survivors.push({ row: picked, sessionKey: key });
  }

  return survivors;
}

/**
 * Layer 2 of {@link pickRowsToFire}: groups whatever survived layer 1 by channel. While the
 * channel's floor is active (its last post was within {@link CHANNEL_MIN_SPACING_MS}), only a
 * repeat of that *same* timer may post now — the floor exists to space out *different* commands,
 * not to hold back the one that just posted from its own next cycle, so a lone fast timer is never
 * throttled by this layer. If no such repeat is eligible this tick, the whole channel is deferred.
 * Once the floor has cleared, whichever eligible row has waited longest wins as usual. Every row
 * that loses its channel this tick — because a different row won it, or the floor deferred it
 * outright — has its layer 1 (Shared Chat) reservation released immediately, since it never gets a
 * chance to actually send: without this, it would sit "reserved" for its full command-session
 * cooldown despite nothing having been posted for it. See the module doc above `channelLastFiredAt`.
 * @param layer1Survivors - Rows (with their layer 1 session-key reservation, if any) that cleared {@link applyCommandSessionCooldown}.
 * @param now - Current time in epoch ms, shared across the whole tick.
 * @param lastFiredAtOf - Resolves a row's current `lastFiredAt`, for the longest-waiting tie-break.
 * @returns The final set of rows to actually send this tick.
 */
function applyChannelFloor(layer1Survivors: readonly PickedRow[], now: number, lastFiredAtOf: LastFiredAtLookup): PickedRow[] {
  const toFire: PickedRow[] = [];
  const byChannel = new Map<string, PickedRow[]>();
  for (const picked of layer1Survivors) {
    const group = byChannel.get(picked.row.channel);
    if (group) group.push(picked); else byChannel.set(picked.row.channel, [picked]);
  }

  for (const [channel, picks] of byChannel) {
    const lastPoster = channelLastFiredAt.get(channel);
    const floorActive = !!lastPoster && now - lastPoster.firedAt < CHANNEL_MIN_SPACING_MS;

    const candidatePick = floorActive
      ? picks.find((p) => p.row.id === lastPoster!.timerId)
      : picks.find((p) => p.row === pickLongestWaiting(picks.map((p2) => p2.row), lastFiredAtOf));

    for (const pick of picks) {
      if (pick !== candidatePick) releaseCommandSessionReservation(pick.sessionKey, now);
    }

    if (!candidatePick) continue; // floor active and no eligible repeat of the last poster this tick

    channelLastFiredAt.set(channel, { firedAt: now, timerId: candidatePick.row.id }); // provisional — released on failure
    toFire.push(candidatePick);
  }

  return toFire;
}

/**
 * From the rows that already passed their own per-timer fire-gate check, decides which ones
 * actually get to fire this tick: {@link applyCommandSessionCooldown} (per-command Shared Chat
 * cooldown), then {@link applyChannelFloor} (cross-command channel floor) on whatever survives.
 * Both layers' reservations are only provisional: {@link releaseReservations} undoes them if the
 * send doesn't actually succeed, so a failed send can't silence a session/channel for the full
 * cooldown window. Rows not picked at either layer are left untouched so they're reconsidered on a
 * later tick.
 * @param eligibleRows - Rows that already passed their own per-timer fire-gate check.
 * @param sessionIdByChannel - Each row's channel's resolved Shared Chat session id (or null).
 * @param now - Current time in epoch ms, shared across the whole tick.
 * @param lastFiredAtOf - Resolves a row's current `lastFiredAt`, for the longest-waiting tie-break.
 */
export function pickRowsToFire(
  eligibleRows: readonly TimerCommandForScheduler[],
  sessionIdByChannel: ReadonlyMap<string, string | null>,
  now: number,
  lastFiredAtOf: LastFiredAtLookup,
): PickedRow[] {
  const layer1Survivors = applyCommandSessionCooldown(eligibleRows, sessionIdByChannel, now, lastFiredAtOf);
  return applyChannelFloor(layer1Survivors, now, lastFiredAtOf);
}

/**
 * Releases the provisional cooldown reservations {@link pickRowsToFire} made for a row, if the send
 * that would have justified them didn't actually happen (no runtime, or the send threw). Guarded by
 * matching the reservation's own identity so a release can't clobber a newer reservation made by a
 * different row on a later tick.
 * @param sessionKey - The command-session cooldown key reserved for this row, or null.
 * @param channel - The row's Twitch channel — the channel-floor reservation to potentially release.
 * @param timerId - The row's timer id — must match the channel-floor reservation's own recorded id.
 * @param now - The epoch-ms timestamp the reservations were made under, shared across the whole tick.
 * @returns Nothing — mutates the module-level cooldown maps in place.
 */
export function releaseReservations(sessionKey: string | null, channel: string, timerId: number, now: number): void {
  releaseCommandSessionReservation(sessionKey, now);
  releaseChannelReservation(channel, timerId, now);
}
