import { EmbedBuilder } from 'discord.js';
import { TwitchStream } from '../twitchApi';
import { LiveState } from './twitchMonitorTypes';
import { fillTemplate } from '../../shared/textTemplate';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DiscordEmbedPreview {
  title: string;
  url: string;
  color: string;
  fields: Array<{ name: string; value: string }>;
  imageUrl: string;
}

export interface DiscordMessagePreview {
  content: string;
  embed: DiscordEmbedPreview;
}

// ─── Template helpers ─────────────────────────────────────────────────────────

export function getStreamUrl(login: string): string {
  return `https://www.twitch.tv/${login}`;
}

export function getThumbnailUrl(stream: TwitchStream): string {
  return stream.thumbnail_url
    .replace('{width}', '640')
    .replace('{height}', '360');
}

export function buildEmbedPreview(stream: TwitchStream, multitwitchUrl?: string): DiscordEmbedPreview {
  const fields: Array<{ name: string; value: string }> = [{ name: 'Game', value: stream.game_name || 'Unknown' }];
  if (multitwitchUrl) fields.push({ name: 'MultiTwitch', value: multitwitchUrl });
  return {
    title: stream.title,
    url: getStreamUrl(stream.user_login),
    color: '#9146FF',
    fields,
    imageUrl: getThumbnailUrl(stream),
  };
}

export function parseHexColor(color: string): number {
  const normalized = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return 0x9146ff;
  return parseInt(normalized, 16);
}

export function buildEmbed(stream: TwitchStream, multitwitchUrl?: string): EmbedBuilder {
  const preview = buildEmbedPreview(stream, multitwitchUrl);

  return new EmbedBuilder()
    .setTitle(preview.title)
    .setURL(preview.url)
    .setColor(parseHexColor(preview.color))
    .addFields(...preview.fields)
    .setImage(preview.imageUrl);
}

export function templateVars(login: string, stream: TwitchStream): Record<string, string> {
  return {
    streamer: login,
    game: stream.game_name || 'Unknown',
    title: stream.title,
    url: getStreamUrl(login),
  };
}

// ─── Message preview ──────────────────────────────────────────────────────────

/**
 * Builds the admin-panel preview (message content + embed) for a streamer's
 * live/new-game announcement template. Uses the `'keep'` {@link fillTemplate}
 * fallback so a placeholder with a typo (no matching key in `templateVars`)
 * stays visible in the preview as `{like_this}` instead of silently vanishing —
 * a useful signal for whoever is editing the template. This mirrors the
 * behaviour used when the same templates are actually posted/edited on
 * Discord (see `twitchMonitorAnnouncements.ts` and `twitchMonitorStartup.ts`).
 *
 * @param state - Live state supplying the current stream and message templates.
 * @param templateKey - Which of the group's templates to render.
 * @param multiTwitch - Multi-twitch URL context; a non-null `url` adds a MultiTwitch field.
 * @returns The rendered message content and embed preview.
 */
export function buildMessagePreview(
  state: LiveState,
  templateKey: 'live_message' | 'new_game_message',
  multiTwitch: { url: string | null },
): DiscordMessagePreview {
  const stream = state.currentStream;
  const template = templateKey === 'new_game_message'
    ? state.group.new_game_message
    : state.group.live_message;
  const vars = templateVars(state.login, stream);

  return {
    content: fillTemplate(template, vars, 'keep'),
    embed: buildEmbedPreview(stream, multiTwitch.url ?? undefined),
  };
}
