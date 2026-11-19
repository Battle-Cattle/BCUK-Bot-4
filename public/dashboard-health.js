/* ── Overall health indicator (dashboard) ─────────────────── */
// One roll-up of the bot's required services: Healthy, Degraded, Unhealthy or Unknown.
// Only Discord and the Twitch chat connections count. Voice is informational, and whether a
// channel is live (`isLive`) is broadcast state, not health, so neither is ever read here.

/** Rank of each state in the roll-up: a known failure outranks unknown, unknown outranks healthy. */
const HEALTH_RANK = { healthy: 0, unknown: 1, degraded: 2, unhealthy: 3 };

/** The words shown for each overall state. "All Systems Operational" only when every service is known healthy. */
const HEALTH_LABELS = {
  healthy: 'All Systems Operational',
  degraded: 'Degraded',
  unhealthy: 'Service down',
  unknown: 'Status unknown',
};

/**
 * Health of the Discord connection.
 * @param discord - The `discord` section of an /api/status payload (`ready`), or a missing value.
 * @returns "healthy", "unhealthy", or "unknown" when the payload doesn't say.
 */
function discordHealth(discord) {
  if (!discord || typeof discord.ready !== 'boolean') return 'unknown';
  return discord.ready ? 'healthy' : 'unhealthy';
}

/**
 * Health of the Twitch chat connections across the guild's channels. No channels configured is neutral
 * (not a fault and not unknown); a missing section is unknown. A known disconnection outranks an unknown one.
 * @param twitch - The `twitch` section of an /api/status payload: channel login to `{ connected, ... }`.
 * @returns "neutral", "healthy", "degraded", "unhealthy" or "unknown".
 */
function twitchHealth(twitch) {
  if (!twitch || typeof twitch !== 'object') return 'unknown';
  const channels = Object.values(twitch);
  if (channels.length === 0) return 'neutral';
  const disconnected = channels.filter((c) => c && c.connected === false).length;
  const unknown = channels.filter((c) => !c || typeof c.connected !== 'boolean').length;
  if (disconnected === channels.length) return 'unhealthy';
  if (disconnected > 0) return 'degraded';
  return unknown > 0 ? 'unknown' : 'healthy';
}

/**
 * Rolls component states up into one: the worst by HEALTH_RANK wins, and "neutral" components are skipped.
 * @param states - Component states from discordHealth/twitchHealth.
 * @returns The overall state; "healthy" only when every counted component is healthy.
 */
function rollUp(states) {
  return states
    .filter((s) => s !== 'neutral')
    .reduce((worst, s) => (HEALTH_RANK[s] > HEALTH_RANK[worst] ? s : worst), 'healthy');
}

/**
 * Derives the dashboard's overall health from a status payload and whether the status feed is reachable.
 * Pure: reads nothing but its arguments.
 * @param status - The /api/status payload (`discord`, `twitch`, ...), or anything malformed.
 * @param feedAvailable - False once the status feed is unreachable; the result is then always unknown.
 * @returns The overall `state`, its `label` in words, and each component's state.
 */
function deriveHealth(status, feedAvailable) {
  if (!feedAvailable || !status || typeof status !== 'object') {
    return { state: 'unknown', label: HEALTH_LABELS.unknown, components: { discord: 'unknown', twitch: 'unknown' } };
  }
  const components = { discord: discordHealth(status.discord), twitch: twitchHealth(status.twitch) };
  const state = rollUp([components.discord, components.twitch]);
  return { state, label: HEALTH_LABELS[state], components };
}

/**
 * Shows a derived health in the #health-indicator live region. Writes only when the state changes, so routine
 * status pushes don't make screen readers re-announce it; does nothing if the indicator is missing.
 * @param health - A result of deriveHealth.
 */
function renderHealth(health) {
  const el = document.getElementById('health-indicator');
  if (!el || el.dataset.state === health.state) return;
  el.dataset.state = health.state;
  el.className = `health health--${health.state}`;
  el.textContent = health.label;
}
