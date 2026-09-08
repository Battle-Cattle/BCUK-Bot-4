const TWITCH_CHANNEL_NAME_PATTERN = /^[a-z0-9_]{4,25}$/;

/**
 * Normalizes a Twitch channel/login name: trims whitespace, strips a leading `#`, and
 * lowercases it, then validates it against Twitch's login name format.
 * @param channel Raw channel name (e.g. from chat, config, or a Helix response).
 * @returns The normalized name, or null if it doesn't match a valid Twitch login format.
 */
export function normalizeTwitchChannelName(channel: string): string | null {
  const normalized = channel.trim().replace(/^#/, '').toLowerCase();
  return TWITCH_CHANNEL_NAME_PATTERN.test(normalized) ? normalized : null;
}