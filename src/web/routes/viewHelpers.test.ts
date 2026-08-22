import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import type { SessionUser } from '../../types/express';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));

import { AccessLevel, getStreamerByDiscordId } from '../../db';
import { renderView, renderError, requireStreamer } from './viewHelpers';

describe('renderView', () => {
  function mockRes() {
    const render = vi.fn();
    return { res: { render } as unknown as Response, render };
  }

  it('forwards a known view and data to res.render unchanged', () => {
    const { res, render } = mockRes();
    renderView(res, 'error', { message: 'hi' });
    expect(render).toHaveBeenCalledWith('error', { message: 'hi' });
  });

  it('throws for a view name with no matching .ejs file under views/', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'not-a-real-view')).toThrow(/unknown view/);
  });

  it('does not call res.render when the view is unknown', () => {
    const { res, render } = mockRes();
    expect(() => renderView(res, '../../etc/passwd')).toThrow();
    expect(render).not.toHaveBeenCalled();
  });

  it('throws when data contains an EJS-reserved option key', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { outputFunctionName: 'x' })).toThrow(/reserved key/);
  });

  it('throws when data contains the EJS "escape" option key', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { escape: (x: unknown) => String(x) })).toThrow(/reserved key/);
  });

  it('throws when data contains the deprecated EJS "scope" alias for "context"', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { scope: {} })).toThrow(/reserved key/);
  });

  it('throws when data contains a "settings" key (EJS renderFile\'s Express compat bypass)', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { settings: { 'view options': { outputFunctionName: 'x' } } })).toThrow(
      /reserved key/,
    );
  });

  it('throws when data contains a prototype-pollution key', () => {
    const { res } = mockRes();
    const data = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(() => renderView(res, 'error', data)).toThrow(/reserved key/);
  });

  it('throws when data contains a "constructor" key', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', { constructor: {} })).toThrow(/reserved key/);
  });

  it('does not call res.render when data has a reserved key', () => {
    const { res, render } = mockRes();
    expect(() => renderView(res, 'error', { cache: true })).toThrow();
    expect(render).not.toHaveBeenCalled();
  });

  it('throws when data is not a plain object', () => {
    const { res } = mockRes();
    expect(() => renderView(res, 'error', [1, 2, 3] as unknown as Record<string, unknown>)).toThrow(
      /plain object/,
    );
  });
});

describe('renderError', () => {
  function mockRes() {
    const render = vi.fn();
    const status = vi.fn();
    return { res: { status, render } as unknown as Response, render, status };
  }

  it('calls res.status with the given status code', () => {
    const { res, status } = mockRes();
    renderError(res, 403, 'Forbidden', undefined);
    expect(status).toHaveBeenCalledWith(403);
  });

  it('renders the error view with user: null when sessionUser is undefined', () => {
    const { res, render } = mockRes();
    renderError(res, 400, 'Bad request', undefined);
    expect(render).toHaveBeenCalledWith('error', {
      message: 'Bad request',
      user: null,
      csrfToken: '',
    });
  });

  it('renders the error view with the provided sessionUser', () => {
    const { res, render } = mockRes();
    const user: SessionUser = {
      discordId: '123456789012345678',
      discordName: 'TestUser',
      discordAvatar: null,
      isOwner: false,
      accessLevel: AccessLevel.MOD,
      currentGuildId: '999000999000999000',
      guilds: [{ guildId: '999000999000999000', name: 'Test Guild' }],
    };
    renderError(res, 500, 'Server error', user);
    expect(render).toHaveBeenCalledWith('error', {
      message: 'Server error',
      user,
      csrfToken: '',
    });
  });
});

describe('requireStreamer', () => {
  function makeReqRes(discordId = '123') {
    const req = { session: { user: { discordId } } } as any;
    const res = { redirect: vi.fn() } as any;
    return { req, res };
  }

  it('returns the streamer when found', async () => {
    const streamer = { id: 1 };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(streamer as any);
    const { req, res } = makeReqRes();
    const result = await requireStreamer(req, res, '/channel-points?error=not_a_streamer');
    expect(result).toBe(streamer);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects to the caller-supplied path and returns null when not found', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const { req, res } = makeReqRes();
    const result = await requireStreamer(req, res, '/overlay/settings?error=not_a_streamer');
    expect(result).toBeNull();
    expect(res.redirect).toHaveBeenCalledWith('/overlay/settings?error=not_a_streamer');
  });

  it("calls getStreamerByDiscordId with the session user's discordId", async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const { req, res } = makeReqRes('200000000000000002');
    await requireStreamer(req, res, '/channel-points?error=not_a_streamer');
    expect(getStreamerByDiscordId).toHaveBeenCalledWith('200000000000000002');
  });
});
