import express, { type Express, type RequestHandler, type Response } from 'express';

/** Named `res.render` stub shapes covering the common conventions used across `src/web/routes/*.test.ts`. */
export type MockRenderPreset = 'spread' | 'nested' | 'text';

export interface BuildTestAppOptions {
  /** Router(s) mounted last, after any body parser and the session/render stub middleware. */
  router: RequestHandler | RequestHandler[];
  /** Body parser installed before the session/render stub. Omit for none. */
  bodyParser?: 'json' | 'urlencoded' | 'both';
  /**
   * Value attached as `req.session.user`. Pass the key explicitly (even `sessionUser: undefined`)
   * to install the stub — omitting the option entirely skips session stubbing. For a session shape
   * that isn't `{ user: sessionUser }` (e.g. no `user` key, or extra sibling keys), use `session` instead.
   */
  sessionUser?: unknown;
  /** Full `req.session` value, verbatim. Takes precedence over `sessionUser` when both are given. */
  session?: unknown;
  /**
   * Stub for `res.render()`. `'spread'` → `res.json({ view, ...locals })`; `'nested'` →
   * `res.json({ view, locals })`; `'text'` → `res.send(\`rendered:${view}\`)` (locals ignored); or
   * a custom `(view, locals, res) => void` for one-off shapes (e.g. forcing a status code). Omit to
   * leave `res.render` untouched.
   */
  mockRender?: MockRenderPreset | ((view: string, locals: unknown, res: Response) => void);
}

/** Installs the body parser(s) requested via `BuildTestAppOptions.bodyParser`. */
function applyBodyParser(app: Express, bodyParser: BuildTestAppOptions['bodyParser']): void {
  if (bodyParser === 'json' || bodyParser === 'both') app.use(express.json());
  if (bodyParser === 'urlencoded' || bodyParser === 'both') app.use(express.urlencoded({ extended: false }));
}

/** Builds the `req.session` value for a request, from `session` (verbatim) or `sessionUser` (wrapped as `{ user }`). */
function resolveSessionValue(options: BuildTestAppOptions): unknown {
  if (Object.prototype.hasOwnProperty.call(options, 'session')) return options.session;
  return { user: options.sessionUser };
}

/** Builds the `res.render` replacement for a given `mockRender` preset or custom function, bound to one response. */
function makeRenderStub(
  mockRender: NonNullable<BuildTestAppOptions['mockRender']>,
  res: Response,
): Response['render'] {
  return ((view: string, locals?: Record<string, unknown>) => {
    if (mockRender === 'spread') return res.json({ view, ...locals });
    if (mockRender === 'nested') return res.json({ view, locals });
    if (mockRender === 'text') return res.send(`rendered:${view}`);
    return mockRender(view, locals, res);
  }) as unknown as Response['render'];
}

/** Installs the `req.session`/`res.render` stub middleware for the options that requested one. */
function applySessionAndRenderStub(app: Express, options: BuildTestAppOptions): void {
  const hasSessionUser = Object.prototype.hasOwnProperty.call(options, 'sessionUser');
  const hasSession = Object.prototype.hasOwnProperty.call(options, 'session');
  const { mockRender } = options;
  if (!hasSession && !hasSessionUser && !mockRender) return;

  app.use((req, res, next) => {
    if (hasSession || hasSessionUser) {
      (req as unknown as { session: unknown }).session = resolveSessionValue(options);
    }
    if (mockRender) {
      res.render = makeRenderStub(mockRender, res);
    }
    next();
  });
}

/**
 * Builds a minimal Express app for router-level supertest coverage: an optional body parser, an
 * optional `req.session` stub, an optional `res.render` stub that echoes the view/locals back
 * (as JSON or plain text) instead of rendering a real EJS template, and the router(s) under test
 * mounted last. Mirrors the hand-rolled `buildApp()` helpers previously duplicated across
 * `src/web/routes/*.test.ts`.
 */
export function buildTestApp(options: BuildTestAppOptions): Express {
  const app = express();
  applyBodyParser(app, options.bodyParser);
  applySessionAndRenderStub(app, options);
  for (const r of Array.isArray(options.router) ? options.router : [options.router]) app.use(r);
  return app;
}
