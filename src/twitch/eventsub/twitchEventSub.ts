import { createLogger } from '../../shared/logger';
import { loadStreamersForEventSub, StreamerEventSubData } from './twitchEventSubSubscriptions';
import { StreamerConnection } from './twitchEventSubConnection';

const log = createLogger('EventSub');

const connections = new Map<string, StreamerConnection>();
let globalStopped = false;
let topReloadChain: Promise<void> = Promise.resolve();

export function startEventSub(): void {
  globalStopped = false;
  topReloadChain = topReloadChain
    .then(async () => {
      const streamers = await loadStreamersForEventSub();
      if (globalStopped) return;
      for (const data of streamers) {
        if (!connections.has(data.uid)) {
          const conn = new StreamerConnection(data);
          conn.setSelfStopCallback((uid) => { connections.delete(uid); });
          connections.set(data.uid, conn);
          conn.start();
        }
      }
    })
    .catch((err) => { log.error('EventSub start error:', err); });
}

export function stopEventSub(): void {
  globalStopped = true;
  for (const conn of connections.values()) conn.stop();
  connections.clear();
}

export function reloadEventSubSubscriptions(): void {
  if (globalStopped) return;
  topReloadChain = topReloadChain
    .then(() => doReload())
    .catch((err) => { log.error('EventSub reload error:', err); });
}

async function doReload(): Promise<void> {
  const streamers = await loadStreamersForEventSub();
  if (globalStopped) return;
  const newUids = new Set(streamers.map((s: StreamerEventSubData) => s.uid));

  for (const [uid, conn] of connections) {
    if (!newUids.has(uid)) { conn.stop(); connections.delete(uid); }
  }

  for (const data of streamers) {
    const existing = connections.get(data.uid);
    if (existing) {
      existing.reload(data);
    } else {
      const conn = new StreamerConnection(data);
      conn.setSelfStopCallback((uid) => { connections.delete(uid); });
      connections.set(data.uid, conn);
      conn.start();
    }
  }
}
