import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import session from 'express-session';
import { vi } from 'vitest';
import { wrapStoreDestroy } from '../web/sessionStreams';

/** Cookie options a real deployment uses behind the proxy; requests in tests send `X-Forwarded-Proto: https`. */
export const SECURE_COOKIE = { secure: true, httpOnly: true, sameSite: 'lax' } as const;

/**
 * A MemoryStore whose `destroy` never calls back until `release()` is called (a hung store write), wrapped by
 * `wrapStoreDestroy` exactly as production wraps its store, so a session's streams are closed before the destroy.
 * @returns The store, and `release` which finishes every held destroy.
 */
export function createHungDestroyStore(): { store: session.MemoryStore; release: () => void } {
  const store = new session.MemoryStore();
  const held: Array<() => void> = [];
  store.destroy = (_sid: string, callback?: (err?: unknown) => void): void => {
    held.push(() => callback?.());
  };
  wrapStoreDestroy(store);
  return { store, release: () => held.splice(0).forEach((finish) => finish()) };
}

/**
 * A dashboard status stream stand-in for `registerSessionStream`: a request carrying a signed-in session and a response
 * whose `write` and `end` are mocks (ending it emits `close`, as a real one does).
 * @param sessionID - ID of the session the stream belongs to.
 * @param discordId - Discord snowflake of the signed-in user.
 * @returns The request and response to register.
 */
export function fakeStatusStream(sessionID: string, discordId: string): { req: Request; res: Response & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } } {
  const res = new EventEmitter() as unknown as Response & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  res.write = vi.fn(() => true);
  res.end = vi.fn(() => { res.emit('close'); return res; });
  const req = new EventEmitter() as unknown as Request;
  Object.assign(req, { sessionID, session: { user: { discordId } } });
  return { req, res };
}
