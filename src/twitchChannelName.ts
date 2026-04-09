const TWITCH_CHANNEL_NAME_PATTERN = /^[a-z0-9_]{4,25}$/;

export function normalizeTwitchChannelName(channel: string): string | null {
  const normalized = channel.trim().replace(/^#/, '').toLowerCase();
  return TWITCH_CHANNEL_NAME_PATTERN.test(normalized) ? normalized : null;
}