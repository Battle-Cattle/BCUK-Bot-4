import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../db', () => ({ getStreamerByDiscordId: vi.fn() }));
vi.mock('../session', () => ({ getSessionUser: vi.fn() }));
vi.mock('./sseOverlayAccess', () => ({ isKnownStreamerLogin: vi.fn(), unauthenticatedOverlayPool: {} }));
vi.mock('./sseChannel', () => ({
  attachSseConnection: vi.fn().mockReturnValue(true),
  broadcastToChannel: vi.fn(),
  chainConnectionCleanup: vi.fn(),
  onConnectionCountChange: vi.fn(),
}));

import { createOverlayStatusEventsHandler } from './sseEventsHandlers';
import { broadcastToChannel, chainConnectionCleanup, onConnectionCountChange } from './sseChannel';
import { getStreamerByDiscordId } from '../../db';
import { getSessionUser } from '../session';

describe('createOverlayStatusEventsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionUser).mockReturnValue({ discordId: 'discord1' } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 7, twitch_name: 'somestreamer' } as any);
  });
  it('unsubscribes and sends nothing if the connection was torn down before its cleanup could be chained', async () => {
    const unsubscribe = vi.fn();
    vi.mocked(onConnectionCountChange).mockReturnValue(unsubscribe);
    vi.mocked(chainConnectionCleanup).mockReturnValue(false);
    const handler = createOverlayStatusEventsHandler({
      statusConnections: new Map(), overlayConnections: new Map(), maxPerChannel: 5,
      log: mockLogger() as any,
    });
    const req = { on: vi.fn() };
    const res = { on: vi.fn() };

    await handler(req as any, res as any);

    expect(chainConnectionCleanup).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});
