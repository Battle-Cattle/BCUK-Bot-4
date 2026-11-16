// Watches component health (`healthStore`) and DMs the bot owner, via `sendOwnerAlert`, when a
// component goes down for longer than a grace period, stays down past a cooldown, or recovers
// after a delivered "down" DM. Edge-triggered per component, and silent during a deliberate
// shutdown.
import { getHealthSnapshot, onHealthChanged } from '../shared/healthStore';
import { deriveComponentOks } from './ownerAlertHealth';
import { sendOwnerAlert, resolveOwnerDiscordId } from './ownerAlerts';

/** How long a component may keep re-alerting while it stays in the failing state, before this watcher sends another notification. */
const REALERT_COOLDOWN_MS = 30 * 60_000;

/**
 * How long a component must stay failing before this watcher sends a "down" DM at all — a
 * quick reconnect (e.g. a brief EventSub WebSocket blip) that resolves within this window never
 * generates a "down"/"recovered" DM pair.
 */
export const DOWN_ALERT_GRACE_MS = 60_000;

/** Per-component edge-trigger state tracked across health-changed notifications. */
interface ComponentAlertState {
  failing: boolean;
  lastAlertAt: number;
  /**
   * Whether a "down" DM has actually been sent for the current failure. A component seeded as
   * failing at startup (e.g. `twitchChat`, before `startTwitchBot()` has run — see
   * {@link primeOwnerAlertBaseline}) starts with this false, so its eventual recovery doesn't fire
   * a "recovered" DM with no matching prior "down" DM.
   */
  downAlertSent: boolean;
  /**
   * Bumped on every failing-episode boundary — a fresh ok→fail transition (or first seen already
   * failing), and a fail→ok recovery. Lets {@link dispatchDownAlert}'s delayed delivery result
   * detect that the component has since moved past the episode it was sent for (recovered, or
   * recovered and failed again) and skip marking {@link downAlertSent} for one that's no longer
   * current.
   */
  generation: number;
  /**
   * Handle for the pending {@link DOWN_ALERT_GRACE_MS} grace-period timer started on an ok→fail
   * transition, or null once it has fired or been cancelled by a recovery within the window. Kept
   * so a fail→ok transition during the grace window can cancel it — suppressing the "down" DM
   * entirely for a quick reconnect.
   */
  pendingDownTimer: NodeJS.Timeout | null;
}

const componentStates = new Map<string, ComponentAlertState>();

let watcherStarted = false;

/**
 * Set by {@link stopOwnerAlertWatcher} once this process has started its own deliberate shutdown.
 * Checked at the top of {@link handleHealthChanged} so the disconnects that shutdown itself
 * causes (Twitch chat, Discord, EventSub, etc. all going down as components are stopped in turn)
 * are never mistaken for real outages — there's nothing useful to alert the owner about "the bot
 * is disconnecting because it's being restarted".
 */
let shuttingDown = false;

/**
 * Sends a "down" (or, for a cooldown re-notification, "still down") DM for a component — dropped
 * if the component has left this failure episode before the send goes out — and, only once
 * delivery is confirmed, marks {@link ComponentAlertState.downAlertSent} — so a component
 * whose down DM never reached the owner (no runtime, owner lookup failure, or a rejected send)
 * doesn't later fire a false "recovered" DM. Guards against a delayed delivery result from an
 * earlier failure episode incorrectly marking a newer one, via {@link ComponentAlertState.generation}.
 * @param componentId - The component's stable id (see {@link deriveComponentOks}).
 * @param error - The component's current error message, if any.
 * @param state - The component's tracked alert state, mutated in place once delivery resolves.
 * @param stillDown - Whether this is a cooldown re-notification for an already-failing component,
 *   rather than the initial down transition.
 * @returns void — the alert send and any resulting state update happen asynchronously.
 */
function dispatchDownAlert(componentId: string, error: string | null, state: ComponentAlertState, stillDown: boolean): void {
  const generation = state.generation;
  const label = stillDown ? 'is still down' : 'is down';
  // Dropped if the component has moved past this failure episode while the send waited for
  // Discord or the owner lookup — otherwise a recovery in that window (which sends no "recovered" DM, since no down
  // DM had been delivered yet) would leave the owner looking at a stale "down" DM.
  const stillCurrent = (): boolean => state.generation === generation;
  void sendOwnerAlert(`🔴 ${componentId} ${label}: ${error ?? 'unknown error'}`, stillCurrent).then((delivered) => {
    if (delivered && state.generation === generation) {
      state.downAlertSent = true;
    }
  });
}

/**
 * Records a component seen for the first time: stored (not alerted on) if it starts out healthy,
 * matching the "nothing was wrong before" baseline. A component that starts out failing is
 * handed to {@link handleNewFailure} so it goes through the same {@link DOWN_ALERT_GRACE_MS}
 * grace period as any other ok→fail transition — otherwise a brief blip on a newly-added
 * component (e.g. a streamer's EventSub connection right after setup) would DM the owner
 * immediately while the identical blip on a pre-existing component would be suppressed.
 * @param componentId - The component's stable id (see {@link deriveComponentOks}).
 * @param ok - Whether the component is currently healthy.
 * @param error - The component's current error message, if failing.
 * @returns void.
 */
function handleFirstSeenComponent(componentId: string, ok: boolean, error: string | null): void {
  const state: ComponentAlertState = {
    failing: false,
    lastAlertAt: 0,
    downAlertSent: false,
    generation: 0,
    pendingDownTimer: null,
  };
  componentStates.set(componentId, state);
  if (!ok) {
    handleNewFailure(componentId, error, state, Date.now());
  }
}

/**
 * Handles a fail→ok transition: cancels a still-pending grace-period timer (the component
 * recovered before it ever fired, so this was a quick reconnect — no "down" DM was sent, and
 * none will be now), then announces the recovery only if a "down" DM was actually delivered for
 * this failure — otherwise this is a component that was merely seeded as failing at startup
 * (e.g. twitchChat, before startTwitchBot() has run), whose down DM never reached the owner, or
 * that recovered within the grace period, finishing its normal startup/blip rather than
 * undergoing a real recovery.
 * @param componentId - The component's stable id (see {@link deriveComponentOks}).
 * @param existing - The component's tracked alert state, mutated in place.
 * @param now - The current timestamp, as already read by the caller.
 * @returns void.
 */
function handleRecovery(componentId: string, existing: ComponentAlertState, now: number): void {
  existing.failing = false;
  existing.lastAlertAt = now;
  if (existing.pendingDownTimer) {
    clearTimeout(existing.pendingDownTimer);
    existing.pendingDownTimer = null;
  }
  const wasAlerted = existing.downAlertSent;
  existing.downAlertSent = false;
  // Bump the generation so a still-in-flight down-DM delivery from this now-ended episode can't
  // resurrect downAlertSent (via dispatchDownAlert's delayed .then()) after this recovery.
  existing.generation += 1;
  if (wasAlerted) {
    void sendOwnerAlert(`✅ ${componentId} recovered`);
  }
}

/**
 * Handles an ok→fail transition: marks the component failing and schedules its "down" DM after
 * {@link DOWN_ALERT_GRACE_MS} rather than sending immediately — a component that recovers before
 * this timer fires (see {@link handleRecovery}, which cancels it) was just a quick reconnect, and
 * gets no DM at all. Re-derives the error message from a fresh health snapshot when the timer
 * fires, in case it changed during the grace window.
 * @param componentId - The component's stable id (see {@link deriveComponentOks}).
 * @param error - The component's error message as of this transition, used as a fallback if a
 *   fresh snapshot read (once the timer fires) no longer has one for this component.
 * @param existing - The component's tracked alert state, mutated in place.
 * @param now - The current timestamp, as already read by the caller.
 * @returns void.
 */
function handleNewFailure(componentId: string, error: string | null, existing: ComponentAlertState, now: number): void {
  existing.failing = true;
  existing.lastAlertAt = now;
  existing.downAlertSent = false;
  existing.generation += 1;
  const generation = existing.generation;
  /**
   * Fires once {@link DOWN_ALERT_GRACE_MS} elapses: no-ops if the component's tracked state is
   * gone or has moved past this failure episode (recovered, or recovered and failed again — see
   * {@link ComponentAlertState.generation}), otherwise re-derives the error from a fresh health
   * snapshot (falling back to `error` as read at transition time, in case the snapshot no longer
   * has one for this component) and dispatches the "down" DM via {@link dispatchDownAlert}.
   * @returns void.
   */
  const dispatchDelayedDownAlert = (): void => {
    const current = componentStates.get(componentId);
    if (current?.generation !== generation) return;
    current.pendingDownTimer = null;
    const latestError = deriveComponentOks(getHealthSnapshot()).get(componentId)?.error ?? error;
    dispatchDownAlert(componentId, latestError, current, false);
  };
  existing.pendingDownTimer = setTimeout(dispatchDelayedDownAlert, DOWN_ALERT_GRACE_MS);
}

/**
 * Reacts to one component's latest ok/fail state against its previously tracked state: sends an
 * edge-triggered DM alert on a fail→ok or ok→fail transition (see {@link handleRecovery} and
 * {@link handleNewFailure}), or a "still down" DM once the {@link REALERT_COOLDOWN_MS} cooldown
 * has elapsed for a component that's stayed failing.
 * @param componentId - The component's stable id (see {@link deriveComponentOks}).
 * @param ok - Whether the component is currently healthy.
 * @param error - The component's current error message, if failing.
 * @param existing - The component's previously tracked alert state, mutated in place.
 * @returns void.
 */
function handleTrackedComponent(componentId: string, ok: boolean, error: string | null, existing: ComponentAlertState): void {
  const now = Date.now();

  if (ok && existing.failing) {
    handleRecovery(componentId, existing, now);
  } else if (!ok && !existing.failing) {
    handleNewFailure(componentId, error, existing, now);
  } else if (!ok && existing.failing && now - existing.lastAlertAt > REALERT_COOLDOWN_MS) {
    existing.lastAlertAt = now;
    dispatchDownAlert(componentId, error, existing, true);
  }
}

/**
 * Reacts to one health-changed notification: derives every tracked component's ok/fail state
 * from the latest snapshot and dispatches each one to {@link handleFirstSeenComponent} or
 * {@link handleTrackedComponent} depending on whether it's been seen before.
 * @returns void.
 */
function handleHealthChanged(): void {
  if (shuttingDown) return;
  const snapshot = getHealthSnapshot();
  const componentOks = deriveComponentOks(snapshot);

  for (const [componentId, { ok, error }] of componentOks) {
    const existing = componentStates.get(componentId);
    if (existing) {
      handleTrackedComponent(componentId, ok, error, existing);
    } else {
      handleFirstSeenComponent(componentId, ok, error);
    }
  }
  forgetRemovedComponents(componentOks);
}

/**
 * Drops the tracked state of every component no longer in the health snapshot (e.g. an EventSub
 * streamer whose connection was stopped for good), cancelling any pending "down" DM for it — the
 * component was removed on purpose, so alerting on it later would be a false alarm, and its
 * state would otherwise never be cleared.
 * @param componentOks - The components in the current health snapshot.
 * @returns void.
 */
function forgetRemovedComponents(componentOks: Map<string, unknown>): void {
  for (const [componentId, state] of componentStates) {
    if (componentOks.has(componentId)) continue;
    if (state.pendingDownTimer) clearTimeout(state.pendingDownTimer);
    // Bump the generation so a "down" DM already waiting on Discord or the owner lookup is dropped too.
    state.generation += 1;
    componentStates.delete(componentId);
  }
}

/**
 * Seeds this watcher's baseline component state and owner-ID cache from the current health
 * snapshot, without sending any alerts. Call once from `index.ts`, after
 * `registerOwnerAlertRuntime` (in `ownerAlerts.ts`) and before {@link startOwnerAlertWatcher} — otherwise the
 * watcher's first health-changed notification would compare against an empty baseline and fire
 * false "down" alerts for components still mid-startup (e.g. Twitch chat, before
 * `startTwitchBot()` has run). Also resolves and caches the owner's Discord ID up front (via
 * {@link resolveOwnerDiscordId}) so the very first real failure — e.g. a DB outage — doesn't skip
 * its alert because the owner-ID cache in `ownerAlerts.ts` was never populated yet.
 * Resolves the owner ID *before* taking the health snapshot — the watcher isn't listening yet
 * at this point, so nothing here reacts to concurrent health changes, but a snapshot taken
 * before that await could still go stale (e.g. Discord finishing its connect) by the time this
 * function returns and the caller starts the watcher, seeding a baseline that's already wrong.
 * @returns Resolves once both owner-ID resolution and baseline seeding have completed.
 */
export async function primeOwnerAlertBaseline(): Promise<void> {
  await resolveOwnerDiscordId();
  const snapshot = getHealthSnapshot();
  const componentOks = deriveComponentOks(snapshot);
  const now = Date.now();
  for (const [componentId, { ok }] of componentOks) {
    // downAlertSent starts false even for a component seeded as already-failing (e.g. twitchChat,
    // before startTwitchBot() has run) — no "down" DM was actually sent for this baseline state,
    // so its later recovery must not fire a "recovered" DM either. See handleHealthChanged.
    componentStates.set(componentId, { failing: !ok, lastAlertAt: now, downAlertSent: false, generation: 0, pendingDownTimer: null });
  }
}

/**
 * Subscribes to `healthStore.onHealthChanged` and starts sending owner DM alerts on
 * component health transitions. Call once from `index.ts`, after {@link primeOwnerAlertBaseline}.
 * Idempotent — a second call is a no-op, so it can never register a duplicate listener.
 * @returns void.
 */
export function startOwnerAlertWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  onHealthChanged(handleHealthChanged);
}

/**
 * Marks this process as deliberately shutting down, so every disconnect that follows (Twitch
 * chat, Discord, EventSub, etc. going down as `index.ts`'s `shutdown()` stops each component in
 * turn) is ignored by {@link handleHealthChanged} instead of being treated as a real outage.
 * Call once, as the very first step of `shutdown()` — before any component is actually stopped —
 * so no disconnect it causes can start a grace-period timer (see {@link DOWN_ALERT_GRACE_MS})
 * that might otherwise still be pending when the process exits, or (on a slow shutdown) fire
 * before it does. There's no matching "resume" — a process that's shutting down never un-shuts-down;
 * the next process boots with its own fresh module state instead.
 * Also cancels any grace-period timer already pending for a component that failed moments before
 * shutdown began, for the same reason — that alert is about to become moot.
 * @returns void.
 */
export function stopOwnerAlertWatcher(): void {
  shuttingDown = true;
  for (const state of componentStates.values()) {
    if (state.pendingDownTimer) {
      clearTimeout(state.pendingDownTimer);
      state.pendingDownTimer = null;
    }
  }
}

/** Test-only: resets all watcher state so each test starts from a clean slate. */
export function __resetOwnerAlertWatcherForTests(): void {
  for (const state of componentStates.values()) {
    if (state.pendingDownTimer) clearTimeout(state.pendingDownTimer);
  }
  componentStates.clear();
  watcherStarted = false;
  shuttingDown = false;
}
