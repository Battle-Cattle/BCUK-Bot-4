import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { buildTestApp } from './expressTestApp';

/** A tiny router used to exercise buildTestApp: echoes session/body state and can trigger res.render. */
function makeRouter() {
  const router = express.Router();
  router.get('/session', (req, res) => {
    res.json({ session: (req as unknown as { session?: unknown }).session ?? null });
  });
  router.post('/body', (req, res) => {
    res.json({ body: req.body });
  });
  router.get('/render', (req, res) => {
    res.render('some-view', { a: 1, b: 2 });
  });
  return router;
}

describe('buildTestApp', () => {
  it('mounts the router with no middleware when no options are given beyond router', async () => {
    const app = buildTestApp({ router: makeRouter() });
    const res = await supertest(app).get('/session');
    expect(res.body).toEqual({ session: null });
  });

  it('stubs req.session.user from sessionUser', async () => {
    const app = buildTestApp({ router: makeRouter(), sessionUser: { discordId: '1' } });
    const res = await supertest(app).get('/session');
    expect(res.body).toEqual({ session: { user: { discordId: '1' } } });
  });

  it('stubs req.session verbatim from session, taking precedence over sessionUser', async () => {
    const app = buildTestApp({ router: makeRouter(), session: { foo: 'bar' }, sessionUser: { discordId: 'ignored' } });
    const res = await supertest(app).get('/session');
    expect(res.body).toEqual({ session: { foo: 'bar' } });
  });

  it('installs a json body parser when bodyParser is "json"', async () => {
    const app = buildTestApp({ router: makeRouter(), bodyParser: 'json' });
    const res = await supertest(app).post('/body').send({ x: 1 });
    expect(res.body).toEqual({ body: { x: 1 } });
  });

  it('installs a urlencoded body parser when bodyParser is "urlencoded"', async () => {
    const app = buildTestApp({ router: makeRouter(), bodyParser: 'urlencoded' });
    const res = await supertest(app).post('/body').send('x=1');
    expect(res.body).toEqual({ body: { x: '1' } });
  });

  it('mockRender "spread" flattens locals onto the JSON body alongside view', async () => {
    const app = buildTestApp({ router: makeRouter(), mockRender: 'spread' });
    const res = await supertest(app).get('/render');
    expect(res.body).toEqual({ view: 'some-view', a: 1, b: 2 });
  });

  it('mockRender "nested" nests locals under a locals key', async () => {
    const app = buildTestApp({ router: makeRouter(), mockRender: 'nested' });
    const res = await supertest(app).get('/render');
    expect(res.body).toEqual({ view: 'some-view', locals: { a: 1, b: 2 } });
  });

  it('mockRender "text" sends a plain "rendered:<view>" string, ignoring locals', async () => {
    const app = buildTestApp({ router: makeRouter(), mockRender: 'text' });
    const res = await supertest(app).get('/render');
    expect(res.text).toBe('rendered:some-view');
  });

  it('mockRender accepts a custom function for one-off shapes', async () => {
    const app = buildTestApp({
      router: makeRouter(),
      mockRender: (view, locals, res) => res.status(201).json({ customView: view, customLocals: locals }),
    });
    const res = await supertest(app).get('/render');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ customView: 'some-view', customLocals: { a: 1, b: 2 } });
  });

  it('accepts an array of routers, mounting each in order', async () => {
    const other = express.Router();
    other.get('/other', (_req, res) => res.json({ ok: true }));
    const app = buildTestApp({ router: [makeRouter(), other] });
    const res = await supertest(app).get('/other');
    expect(res.body).toEqual({ ok: true });
  });
});
