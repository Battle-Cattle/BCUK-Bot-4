import { EmbedBuilder } from 'discord.js';
import { TwitchStream } from './twitchApi';
import { LiveState } from './twitchMonitorTypes';

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

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

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

export function templateVars(login: string, stream: TwitchStream, multitwitch?: string): Record<string, string> {
  return {
    streamer: login,
    game: stream.game_name || 'Unknown',
    title: stream.title,
    url: getStreamUrl(login),
    multitwitch: multitwitch ?? '',
  };
}

// ─── Message preview ──────────────────────────────────────────────────────────

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
    content: fillTemplate(template, vars),
    embed: buildEmbedPreview(stream, multiTwitch.url ?? undefined),
  };
}
