import { DbStreamGroup } from './db';
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
