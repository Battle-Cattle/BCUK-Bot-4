/** Minimal contract every Twitch command runtime must satisfy: a function to send a chat message to a channel. */
export interface TwitchSendRuntime {
  send: (channel: string, message: string) => Promise<void>;
}

/**
 * Runtime contract for handlers that broadcast to multiple channels and need to
 * de-duplicate by Twitch shared-chat session — shared by `customCommandHandler.ts`
 * and `multiCommandHandler.ts` to avoid two copies of the same interface.
 */
export interface TwitchBroadcastRuntime extends TwitchSendRuntime {
  getActiveChannels: () => ReadonlySet<string>;
  getLoginUserIds: () => ReadonlyMap<string, string>;
}
