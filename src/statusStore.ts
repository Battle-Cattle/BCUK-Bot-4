export interface ChannelStatus {
  connected: boolean;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
}

const state = {
  discord: {
    ready: false,
    tag: null as string | null,
    guildName: null as string | null,
  },
  voice: {
    connected: false,
    channelName: null as string | null,
    playing: false,
    currentFile: null as string | null,
    lastCommand: null as string | null,
    lastSource: null as string | null,
    lastPlayedAt: null as Date | null,
  },
  twitch: new Map<string, ChannelStatus>(),
  tiktok: new Map<string, ChannelStatus>(),
};

export function setDiscordReady(tag: string, guildName: string): void {
  state.discord.ready = true;
  state.discord.tag = tag;
  state.discord.guildName = guildName;
}

export function setVoiceConnected(channelName: string): void {
  state.voice.connected = true;
  state.voice.channelName = channelName;
}

export function setVoiceDisconnected(): void {
  state.voice.connected = false;
  state.voice.channelName = null;
}

export function setVoicePlaying(file: string, command: string, source: string): void {
  state.voice.playing = true;
  state.voice.currentFile = file;
  state.voice.lastCommand = command;
  state.voice.lastSource = source;
  state.voice.lastPlayedAt = new Date();
}

export function setVoiceIdle(): void {
  state.voice.playing = false;
  state.voice.currentFile = null;
}

function updateChannel(map: Map<string, ChannelStatus>, key: string, connected: boolean): void {
  const existing: ChannelStatus = map.get(key) ?? {
    connected: false,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
  };
  if (connected && !existing.connected) existing.lastConnectedAt = new Date();
  if (!connected && existing.connected) existing.lastDisconnectedAt = new Date();
  existing.connected = connected;
  map.set(key, existing);
}

export function setTwitchChannel(channel: string, connected: boolean): void {
  updateChannel(state.twitch, channel.replace(/^#/, ''), connected);
}

export function setTikTokChannel(username: string, connected: boolean): void {
  updateChannel(state.tiktok, username, connected);
}

export function getStatus() {
  return {
    discord: { ...state.discord },
    voice: { ...state.voice },
    twitch: Object.fromEntries(state.twitch) as Record<string, ChannelStatus>,
    tiktok: Object.fromEntries(state.tiktok) as Record<string, ChannelStatus>,
  };
}
