/**
 * Identifies the Discord guild and voice channel where an SFX should play.
 * voiceChannelId is resolved dynamically at playback time (where the streamer is sitting).
 */
export interface GuildAudioContext {
  guildId: string;
  voiceChannelId: string;
}
