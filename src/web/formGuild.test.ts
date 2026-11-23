import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));

import express from 'express';
import supertest from 'supertest';
import { requireFormGuild } from './formGuild';
import { buildTestApp } from '../test-utils/expressTestApp';

const GUILD_ID = '900000000000000001';
const OTHER_GUILD = '900000000000000002';

/** A form route behind the guard that answers 200 when it is reached. */
function buildApp(currentGuildId: string | null = GUILD_ID) {
  const router = express.Router();
  router.post('/form', requireFormGuild('/page'), (_req, res) => { res.status(200).send('reached'); });
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser: { discordId: '1', currentGuildId } });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('requireFormGuild', () => {
  it('lets a form for the session\'s current guild through', async () => {
    const res = await supertest(buildApp()).post('/form').type('form').send({ guild_id: GUILD_ID });
    expect(res.status).toBe(200);
    expect(res.text).toBe('reached');
  });

  it('accepts surrounding whitespace in the submitted guild id', async () => {
    const res = await supertest(buildApp()).post('/form').type('form').send({ guild_id: ` ${GUILD_ID} ` });
    expect(res.text).toBe('reached');
  });

  it('redirects ?error=guild_changed when the form was rendered for another guild', async () => {
    const res = await supertest(buildApp()).post('/form').type('form').send({ guild_id: OTHER_GUILD });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/page?error=guild_changed');
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining(GUILD_ID));
    // The submitted value is user input and isn't logged.
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining(OTHER_GUILD));
  });

  it('redirects ?error=guild_changed when the form carries no guild_id', async () => {
    const res = await supertest(buildApp()).post('/form').type('form').send({ discord_id: '5' });
    expect(res.headers.location).toBe('/page?error=guild_changed');
  });

  it('rejects a guild_id sent more than once (parsed as a non-string)', async () => {
    const res = await supertest(buildApp()).post('/form').type('form').send(`guild_id=${GUILD_ID}&guild_id=${GUILD_ID}`);
    expect(res.headers.location).toBe('/page?error=guild_changed');
  });

  it('fails loudly when mounted without a selected guild (missing requireGuildContext)', async () => {
    const res = await supertest(buildApp(null)).post('/form').type('form').send({ guild_id: GUILD_ID });
    expect(res.status).toBe(500);
  });
});
