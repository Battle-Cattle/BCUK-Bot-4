// ui-check: renders one EJS view from a fixture and inspects it in the pre-installed Chromium,
// without starting the bot (no Discord, Twitch or MySQL). See SKILL.md next to this file.
//
//   node .claude/skills/ui-check/render.mjs <fixture.json> [outDir]
//
// The page is served from a throwaway local server under the production CSP (copied from
// src/web/server.ts; keep the two in step), so inline scripts, inline styles and `on*`
// attributes show up as violations here exactly as they would in production.

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ejs = require('ejs');
// Playwright is pre-installed outside the project (not a dependency); require() resolves it.
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const CSP = [
  "default-src 'self'", "script-src 'self'", "script-src-attr 'none'", "style-src 'self'",
  "img-src 'self' data: https://cdn.discordapp.com https://static-cdn.jtvnw.net", "font-src 'self'",
  "connect-src 'self'", "media-src 'self' blob:", "object-src 'none'", "base-uri 'self'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 },
];

const MIME = {
  '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.html': 'text/html',
};

/**
 * Reads and validates a fixture file.
 * @param fixturePath - Path to the fixture JSON: `{ view, locals, api?, sse?, waitMs? }`.
 * @returns The parsed fixture, with defaults filled in.
 */
async function loadFixture(fixturePath) {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  if (typeof fixture.view !== 'string' || !/^[\w-]+$/.test(fixture.view)) {
    throw new Error('fixture.view must be the name of a file in views/ (e.g. "dashboard")');
  }
  return { locals: {}, api: {}, sse: {}, waitMs: 500, ...fixture };
}

/**
 * Renders the fixture's view with the locals the server would give every page.
 * @param fixture - The loaded fixture.
 * @returns The rendered HTML.
 */
function renderPage(fixture) {
  const viewPath = path.join(ROOT, 'views', `${fixture.view}.ejs`);
  return ejs.renderFile(viewPath, { user: null, csrfToken: 'ui-check-csrf', ...fixture.locals });
}

/**
 * Sends one response with the production CSP header.
 * @param res - Node HTTP response.
 * @param status - HTTP status code.
 * @param type - Content-Type header value.
 * @param body - Response body.
 */
function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': CSP });
  res.end(body);
}

/**
 * Serves a file from public/, refusing any path that escapes it.
 * @param res - Node HTTP response.
 * @param urlPath - The request path.
 * @returns Resolves once the response is sent.
 */
async function serveStatic(res, urlPath) {
  const filePath = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(urlPath)}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'text/plain', 'forbidden');
  try {
    const body = await readFile(filePath);
    return send(res, 200, MIME[path.extname(filePath)] ?? 'application/octet-stream', body);
  } catch {
    return send(res, 404, 'text/plain', 'not found');
  }
}

/**
 * Opens a stubbed SSE stream: sends the fixture's events, then holds the stream open.
 * @param res - Node HTTP response.
 * @param events - `{ event?, data }` entries; `data` is sent as JSON.
 */
function serveSse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP });
  for (const { event, data } of events) {
    res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  }
}

/**
 * Builds the ordered routes for one page: the first route whose `matches` accepts a path handles it.
 * @param html - The rendered page, served at `/`.
 * @param fixture - The loaded fixture (its `api` and `sse` stubs).
 * @returns `{ matches(path), handle(res, path) }` entries, most specific first.
 */
function buildRoutes(html, fixture) {
  return [
    { matches: (p) => p === '/', handle: (res) => send(res, 200, 'text/html', html) },
    { matches: (p) => p in fixture.api, handle: (res, p) => send(res, 200, 'application/json', JSON.stringify(fixture.api[p])) },
    { matches: (p) => p in fixture.sse, handle: (res, p) => serveSse(res, fixture.sse[p]) },
    // Unstubbed SSE/API paths fail, so the page shows its unavailable state rather than hanging.
    { matches: (p) => !path.extname(p), handle: (res) => send(res, 503, 'text/plain', 'not stubbed') },
    { matches: () => true, handle: (res, p) => void serveStatic(res, p) },
  ];
}

/**
 * Starts the throwaway server for one rendered page.
 * @param html - The rendered page, served at `/`.
 * @param fixture - The loaded fixture (its `api` and `sse` stubs).
 * @returns The listening server and its base URL.
 */
async function startServer(html, fixture) {
  const routes = buildRoutes(html, fixture);
  const server = createServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    routes.find((r) => r.matches(urlPath)).handle(res, urlPath);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Loads the page in one browser context and records what a reviewer needs to check.
 * @param browser - The Playwright browser.
 * @param baseUrl - The throwaway server's URL.
 * @param run - Viewport, motion and colour settings, and where to write the screenshot.
 * @returns Findings for this run: console errors, CSP violations, failed requests, overflow, animations.
 */
async function inspect(browser, baseUrl, run) {
  const context = await browser.newContext({
    viewport: { width: run.width, height: run.height },
    deviceScaleFactor: 1,
    reducedMotion: run.reducedMotion ? 'reduce' : 'no-preference',
    // Only the greyscale run bypasses the CSP, to inject its filter; every other run enforces it.
    bypassCSP: run.greyscale,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => { if (res.status() >= 400) failedRequests.push(`${res.status()} ${new URL(res.url()).pathname}`); });
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForTimeout(run.waitMs);
  if (run.greyscale) await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });
  // Runs in the page, so `document` is the browser's (reached via globalThis for the Node linter).
  const metrics = await page.evaluate(() => ({
    scrollWidth: globalThis.document.documentElement.scrollWidth,
    clientWidth: globalThis.document.documentElement.clientWidth,
    runningAnimations: globalThis.document.getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => {
        const el = a.effect?.target;
        const where = el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')}` : '?';
        return `${a.animationName ?? a.transitionProperty ?? 'animation'} on ${where}`;
      }),
  }));
  await page.screenshot({ path: run.screenshot, fullPage: true });
  const aria = run.ariaPath ? await page.locator('body').ariaSnapshot() : null;
  if (aria) await writeFile(run.ariaPath, aria);
  await context.close();
  return {
    run: run.label,
    screenshot: path.relative(ROOT, run.screenshot),
    horizontalOverflow: metrics.scrollWidth > metrics.clientWidth ? `${metrics.scrollWidth - metrics.clientWidth}px` : 'none',
    runningAnimations: metrics.runningAnimations,
    cspViolations: consoleErrors.filter((e) => e.includes('Content Security Policy')),
    consoleErrors: consoleErrors.filter((e) => !e.includes('Content Security Policy')),
    failedRequests,
  };
}

/**
 * Lists the runs: each viewport normally, plus reduced motion and greyscale at desktop and mobile.
 * @param outDir - Directory for screenshots and the ARIA snapshot.
 * @param waitMs - How long to let the page's scripts settle before capturing.
 * @returns The runs to perform.
 */
function planRuns(outDir, waitMs) {
  const runs = VIEWPORTS.map((v) => ({ ...v, label: v.name, reducedMotion: false, greyscale: false }));
  for (const v of [VIEWPORTS[0], VIEWPORTS[2]]) {
    runs.push({ ...v, label: `${v.name}-reduced-motion`, reducedMotion: true, greyscale: false });
    runs.push({ ...v, label: `${v.name}-greyscale`, reducedMotion: false, greyscale: true });
  }
  return runs.map((r) => ({
    ...r,
    waitMs,
    screenshot: path.join(outDir, `${r.label}.png`),
    ariaPath: r.label === 'desktop' ? path.join(outDir, 'aria-snapshot.yml') : null,
  }));
}

/**
 * Entry point: renders the fixture, runs every check and writes `report.json` to the output directory.
 * @returns Resolves when the report is written; the process exits 1 on a CSP violation or page error.
 */
async function main() {
  const [fixturePath, outArg] = process.argv.slice(2);
  if (!fixturePath) throw new Error('usage: node .claude/skills/ui-check/render.mjs <fixture.json> [outDir]');
  const fixture = await loadFixture(fixturePath);
  const outDir = path.resolve(outArg ?? path.join(ROOT, 'ui-check-output', fixture.view));
  await mkdir(outDir, { recursive: true });
  const { server, baseUrl } = await startServer(await renderPage(fixture), fixture);
  const browser = await chromium.launch();
  try {
    const results = [];
    for (const run of planRuns(outDir, fixture.waitMs)) results.push(await inspect(browser, baseUrl, run));
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(results, null, 2));
    const blocking = results.some((r) => r.cspViolations.length > 0 || r.consoleErrors.some((e) => e.startsWith('pageerror')));
    process.exitCode = blocking ? 1 : 0;
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
}

await main();
