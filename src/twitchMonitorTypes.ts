import { DbStreamGroup, DbStreamerFull } from './db';
import { TwitchStream } from './twitchApi';

export interface LiveState {
  streamerId: number;
  groupId: number;
  group: DbStreamGroup;
  login: string;
  messageId: string | null;
  channelId: string | null;
  currentGame: string;
  title: string;
  currentStream: TwitchStream;
  offlineTimer: ReturnType<typeof setTimeout> | null;
}

export function makeLiveState(
  streamer: DbStreamerFull,
  stream: TwitchStream,
  messageId: string | null,
  channelId: string | null,
): LiveState {
  return {
    streamerId: streamer.id,
    groupId: streamer.group.id,
    group: streamer.group,
    login: stream.user_login.toLowerCase(),
    messageId,
    channelId,
    currentGame: stream.game_name,
    title: stream.title,
    currentStream: stream,
    offlineTimer: null,
  };
}
