import tmi from 'tmi.js';
import { setTwitchChannel } from '../shared/statusStore';
import { getTwitchEnabledChannels } from '../db';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { getUsers } from './twitchApi';
import { createMutationQueue } from '../shared/mutationQueue';
import { createLogger } from '../shared/logger';

const log = createLogger('Twitch');

let _client: tmi.Client | null = null;
let _connected = false;

const activeChannels = new Set<string>();
const activeChannelUserIds = new Map<string, string>();
const membershipMutationQueue = createMutationQueue();
// Twitch rate-limits JOIN to 20 per 10 s (2/s). 600 ms ≈ 1.67/s, ~83% of the ceiling.
const JOIN_THROTTLE_MS = 600;
let _onChannelJoined: ((channel: string) => void) | null = null;

export function setTmiClient(c: tmi.Client | null): void {
  _client = c;
}

export function setConnected(v: boolean): void {
  _connected = v;
}

export function setChannelJoinedHook(fn: (channel: string) => void): void {
  _onChannelJoined = fn;
}

function isChannelJoined(channel: string): boolean {
  if (!_client || !_connected) return false;
  return _client.getChannels().some((ch) => normalizeTwitchChannelName(ch) === channel);
}

function cacheChannelUserId(channel: string): void {
  getUsers([channel])
    .then(([u]) => { if (u && activeChannels.has(channel)) activeChannelUserIds.set(channel, u.id); })
    .catch((err) => { log.warn(`Failed to cache user ID for channel ${channel}:`, err); });
}

function fireChannelJoinedHook(channel: string): void {
  try { _onChannelJoined?.(channel); } catch (err) { log.error('Channel joined hook error:', err); }
}

async function partStaleChannel(channel: string): Promise<void> {
  if (activeChannels.has(channel)) {
    setTwitchChannel(channel, true);
    cacheChannelUserId(channel);
    return;
  }
  if (!_client || !_connected || !isChannelJoined(channel)) {
    setTwitchChannel(channel, false);
    return;
  }
  await _client.part(channel);
  setTwitchChannel(channel, false);
  log.info(`Parted stale channel after reconnect: ${channel}`);
}

async function joinMissingChannel(channel: string): Promise<void> {
  if (!activeChannels.has(channel)) return;
  if (!_client || !_connected) {
    setTwitchChannel(channel, false);
    return;
  }
  if (isChannelJoined(channel)) {
    setTwitchChannel(channel, true);
    cacheChannelUserId(channel);
    return;
  }
  await _client.join(channel);
  await new Promise<void>((resolve) => { setTimeout(resolve, JOIN_THROTTLE_MS); });
  setTwitchChannel(channel, true);
  cacheChannelUserId(channel);
  fireChannelJoinedHook(channel);
  log.info(`Joined queued channel after reconnect: ${channel}`);
}

export async function reconcileJoinedChannels(): Promise<void> {
  if (!_client || !_connected) return;

  const joinedChannels = _client.getChannels()
    .map((channel) => normalizeTwitchChannelName(channel))
    .filter((channel): channel is string => channel !== null);
  const joinedChannelSet = new Set(joinedChannels);

  for (const channel of joinedChannels) {
    try {
      await membershipMutationQueue.run(channel, () => partStaleChannel(channel));
    } catch (err) {
      log.error(`Failed to part stale channel ${channel}:`, err);
    }
  }

  for (const channel of activeChannels) {
    if (joinedChannelSet.has(channel)) continue;
    try {
      await membershipMutationQueue.run(channel, () => joinMissingChannel(channel));
    } catch (err) {
      setTwitchChannel(channel, false);
      log.error(`Failed to join queued channel ${channel}:`, err);
    }
  }
}

export async function initializeActiveChannels(): Promise<void> {
  const configuredChannels = await getTwitchEnabledChannels();
  for (const ch of configuredChannels) {
    const normalized = normalizeTwitchChannelName(ch);
    if (!normalized) {
      log.error(`Skipping invalid enabled channel in DB: ${ch}`);
      continue;
    }
    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
  }

  if (activeChannels.size === 0) {
    log.warn('No enabled Twitch channels found in DB; connecting with no joined channels.');
    return;
  }

  try {
    const users = await getUsers([...activeChannels]);
    for (const u of users) activeChannelUserIds.set(u.login.toLowerCase(), u.id);
  } catch (err) {
    log.error('Failed to resolve channel user IDs (shared-chat dedup unavailable):', err);
  }
}

export async function joinTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeTwitchChannelName(channel);
  if (!normalized) {
    throw new Error(`[Twitch] Invalid channel name: ${channel}`);
  }

  await membershipMutationQueue.run(normalized, async () => {
    // Check inside the mutex so no concurrent join can race between the check
    // and the actual client.join() call.
    if (isChannelJoined(normalized)) {
      // Already joined — sync local tracking so status store and activeChannels
      // agree with the live tmi.js state.
      activeChannels.add(normalized);
      setTwitchChannel(normalized, true);
      cacheChannelUserId(normalized);
      fireChannelJoinedHook(normalized);
      return;
    }

    if (!_client || !_connected) {
      // Queue the desired membership locally so reconnect reconciliation can join
      // it once the Twitch client is available again.
      activeChannels.add(normalized);
      setTwitchChannel(normalized, false);
      cacheChannelUserId(normalized);
      return;
    }

    activeChannels.add(normalized);
    setTwitchChannel(normalized, false);
    try {
      await _client.join(normalized);
      setTwitchChannel(normalized, true);
      cacheChannelUserId(normalized);
    } catch (err) {
      // Roll back local state; reconnect reconciliation will retry via activeChannels.
      activeChannels.delete(normalized);
      setTwitchChannel(normalized, false);
      log.error(`Failed to join channel ${normalized}:`, err);
      throw err;
    }
    fireChannelJoinedHook(normalized);
  });
}

export async function partTwitchChannel(channel: string): Promise<void> {
  const normalized = normalizeTwitchChannelName(channel);
  if (!normalized) return;

  await membershipMutationQueue.run(normalized, async () => {
    if (!activeChannels.has(normalized) && !isChannelJoined(normalized)) return;

    if (!_client || !_connected) {
      // We remove local state immediately and let reconcileJoinedChannels() part
      // any stale tmi.js channel memberships on the next successful connect.
      activeChannels.delete(normalized);
      activeChannelUserIds.delete(normalized);
      setTwitchChannel(normalized, false);
      return;
    }

    try {
      activeChannels.delete(normalized);
      activeChannelUserIds.delete(normalized);
      setTwitchChannel(normalized, false);
      if (isChannelJoined(normalized)) {
        await _client.part(normalized);
      }
    } catch (err) {
      // Keep desired membership removed so later reconciliation can retry
      // parting any stale runtime join without restoring admin intent here.
      log.error(`Failed to part channel ${normalized}:`, err);
      throw err;
    }
  });
}

export function getActiveChannels(): ReadonlySet<string> {
  return activeChannels;
}

export function getActiveChannelUserIds(): ReadonlyMap<string, string> {
  return activeChannelUserIds;
}

export function clearMembershipState(): void {
  activeChannels.clear();
  activeChannelUserIds.clear();
}
