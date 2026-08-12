import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { csrfProtection } from './csrf';

const SESSION_TOKEN = 'a'.repeat(64); // 32 hex bytes

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = { csrfToken: SESSION_TOKEN };
    next();
  });
  app.use(csrfProtection);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.code === 'EBADCSRFTOKEN' ? 403 : 500).json({ code: err?.code });
  });
  app.post('/test', (_req, res) => res.json({ ok: true }));
  app.get('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('csrfProtection — safe methods', () => {
  it('allows GET without a token', async () => {
    const res = await supertest(buildApp()).get('/test');
    expect(res.status).toBe(200);
  });
});

describe('csrfProtection — body token', () => {
  it('accepts POST with correct _csrf in body', async () => {
    const res = await supertest(buildApp())
      .post('/test')
      .send(`_csrf=${SESSION_TOKEN}`)
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(200);
  });

  it('rejects POST with wrong _csrf in body', async () => {
    const res = await supertest(buildApp())
      .post('/test')
      .send('_csrf=wrong-token')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EBADCSRFTOKEN');
  });

  it('rejects POST with no token', async () => {
    const res = await supertest(buildApp()).post('/test');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EBADCSRFTOKEN');
  });

  it('rejects a 64-char token that is not valid hex, without throwing', async () => {
    const notHex = 'z'.repeat(64);
    const res = await supertest(buildApp())
      .post('/test')
      .send(`_csrf=${notHex}`)
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EBADCSRFTOKEN');
  });
});

describe('csrfProtection — X-CSRF-Token header', () => {
  it('accepts POST with correct X-CSRF-Token header', async () => {
    const res = await supertest(buildApp())
      .post('/test')
      .set('X-CSRF-Token', SESSION_TOKEN);
    expect(res.status).toBe(200);
  });

  it('rejects POST with wrong X-CSRF-Token header', async () => {
    const res = await supertest(buildApp())
      .post('/test')
      .set('X-CSRF-Token', 'bad-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EBADCSRFTOKEN');
  });
});

describe('csrfProtection — X-XSRF-Token header', () => {
  it('accepts POST with correct X-XSRF-Token header', async () => {
    const res = await supertest(buildApp())
      .post('/test')
      .set('X-XSRF-Token', SESSION_TOKEN);
    expect(res.status).toBe(200);
  });

  it('rejects POST with wrong X-XSRF-Token header', async () => {
    const res = await supertest(buildApp())
      .post('/test')
      .set('X-XSRF-Token', 'bad-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EBADCSRFTOKEN');
  });
});

describe('csrfProtection — body takes priority over header', () => {
  it('uses body token when both are present', async () => {
    const res = await supertest(buildApp())
      .post('/test')
      .send(`_csrf=${SESSION_TOKEN}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-CSRF-Token', 'wrong-header-token');
    expect(res.status).toBe(200);
  });
});

describe('csrfProtection — X-CSRF-Token falls back to X-XSRF-Token when empty', () => {
  it('uses X-XSRF-Token when X-CSRF-Token is an empty string', async () => {
    const res = await supertest(buildApp())
      .post('/test')
      .set('X-CSRF-Token', '')
      .set('X-XSRF-Token', SESSION_TOKEN);
    expect(res.status).toBe(200);
  });
});

describe('csrfProtection — query string token is ignored', () => {
  it('uses body token and ignores a wrong query token when both are present', async () => {
    const res = await supertest(buildApp())
      .post('/test?_csrf=wrong-query-token')
      .send(`_csrf=${SESSION_TOKEN}`)
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(200);
  });

  it('rejects a request with only a (even correct) query token and no body/header token', async () => {
    const res = await supertest(buildApp())
      .post(`/test?_csrf=${SESSION_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EBADCSRFTOKEN');
  });
});
