/**
 * Setup server: captures the user's Discord token through a tiny
 * browser-based UI.
 *
 * - Auto-selects a free port (tries lastPort+1, then falls back to
 *   probing a random high port).
 * - CSRF: issues a one-time token on GET / and requires it on POST /submit.
 * - Input validation: token must match the rough Discord user-token
 *   shape (long base64-ish string with two dots). We also enforce
 *   a hard upper length so a malicious client cannot OOM us.
 * - Clean shutdown: SIGINT/SIGTERM close the server; in-flight
 *   requests get a 503.
 * - We never log the token; the form posts it directly to /submit
 *   and we hand it to the callback, which writes it to disk.
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { openExternal } = require('../core/browser');

/** @typedef {(token: string) => Promise<void> | void} TokenCallback */

/**
 * @param {{
 *   logger: import('../core/logger').Logger,
 *   onToken: TokenCallback,
 *   preferredPort?: number | null,
 * }} opts
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startSetupServer(opts) {
  const port = await pickFreePort(opts.preferredPort);
  const csrf = crypto.randomBytes(24).toString('base64url');
  let consumed = false;
  let closed = false;
  /** @type {http.Server|null} */
  const server = http.createServer((req, res) => handle(req, res));

  server.on('error', (err) => {
    opts.logger.error('setup server error', { err: String(err) });
  });

  await new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, '127.0.0.1', () => resolveStart());
  });

  const url = `http://127.0.0.1:${port}/`;
  opts.logger.info('setup server listening', { url });

  let resolveToken;
  const tokenPromise = new Promise((resolve) => {
  resolveToken = resolve;
  });

  return {
  url,
  waitForToken: () => tokenPromise,
  close: () => closeServer(server, { setClosed: () => { closed = true; } }),
  };

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  function handle(req, res) {
    if (closed) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('server shutting down');
      return;
    }
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/') return serveForm(res, csrf);
      if (req.method === 'POST' && url.pathname === '/submit') return handleSubmit(req, res, csrf);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      opts.logger.warn('setup handler error', { err: String(err) });
      try {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal');
      } catch { /* ignore */ }
    }
  }

  /**
   * @param {http.ServerResponse} res
   * @param {string} csrf
   */
  function serveForm(res, csrf) {
    const body = renderHtml(csrf);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} csrf
   */
  function handleSubmit(req, res, csrf) {
    if (consumed) {
      res.writeHead(409, { 'content-type': 'text/plain' });
      res.end('already submitted');
      return;
    }
    const chunks = [];
    let total = 0;
    const MAX = 8 * 1024;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX) {
        req.destroy();
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('payload too large');
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      let body;
      try {
        body = Buffer.concat(chunks).toString('utf8');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad encoding');
        return;
      }
      const params = new URLSearchParams(body);
      const submitted = params.get('csrf') || '';
      const token = (params.get('token') || '').trim();

      if (!safeEqual(submitted, csrf)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('csrf mismatch');
        return;
      }
      if (!validateToken(token)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('invalid token format');
        return;
      }
      consumed = true;
      try {
        await opts.onToken(token);
        resolveToken(token);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        // Give the response a tick to flush, then close.
        setTimeout(() => closeServer(server, { setClosed: () => { closed = true; } }).catch(() => undefined), 100);
        if (typeof setTimeout.unref === 'function') setTimeout.unref();
      } catch (err) {
        opts.logger.error('token save failed', { err: String(err) });
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('save failed');
      }
    });
    req.on('error', () => { /* ignore */ });
  }
}

/**
 * @param {http.Server} server
 * @param {{ setClosed?: () => void }} [hooks]
 */
function closeServer(server, hooks) {
  if (hooks && typeof hooks.setClosed === 'function') hooks.setClosed();
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
    // Force-close any keep-alive sockets.
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
  });
}

/**
 * Tries `preferredPort` (or a random port if null), then probes
 * a small range of nearby ports until one binds.
 * @param {number | null | undefined} preferredPort
 */
async function pickFreePort(preferredPort) {
  const candidates = [];
  if (Number.isInteger(preferredPort) && preferredPort > 0 && preferredPort < 65535) {
    for (let i = 0; i < 10; i++) candidates.push(preferredPort + i);
  }
  // Try a random high port a few times as fallback.
  for (let i = 0; i < 5; i++) candidates.push(40_000 + Math.floor(Math.random() * 15_000));

  for (const port of candidates) {
    if (await canBind(port)) return port;
  }
  throw new Error('no free port found for setup server');
}

/**
 * @param {number} port
 */
function canBind(port) {
  return new Promise((res) => {
    const probe = http.createServer();
    probe.once('error', () => res(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => res(true));
    });
  });
}

/**
 * Constant-time comparison.
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Lightweight validation. Real Discord user tokens are typically:
 *   <base64>.<base64>.<base64-or-hex>
 * We accept any string of length 30..200 made of base64url chars
 * and dots. The auth check on first PATCH will reject invalid ones.
 * @param {string} s
 */
function validateToken(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 30 || s.length > 200) return false;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
}

/**
 * @param {string} csrf
 */
function renderHtml(csrf) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discord Lyrics Status — Setup</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 16px; line-height: 1.5; }
  h1 { margin-bottom: 0.2em; }
  .muted { color: #888; font-size: 0.92em; }
  input[type=password] { width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid #8884; font: inherit; }
  button { margin-top: 12px; padding: 10px 16px; border-radius: 6px; border: 0; background: #5865F2; color: white; font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: progress; }
  .steps { background: #8881; padding: 12px 16px; border-radius: 8px; }
  .steps ol { margin: 6px 0 0 0; padding-left: 22px; }
  details { margin-top: 16px; }
  pre { background: #8882; padding: 8px 12px; border-radius: 6px; overflow: auto; }
</style>
</head>
<body>
<h1>Discord Lyrics Status</h1>
<p class="muted">Authorize this app to update your Discord custom status in real time.</p>
<div class="steps">
  <strong>How to get your token:</strong>
  <ol>
    <li>In a browser, open Discord and log in.</li>
    <li>Open DevTools (F12) &rarr; <em>Console</em>.</li>
    <li>Paste the snippet below and press Enter.
      <details><summary>Show snippet</summary>
      <pre>let req = webpackChunkdiscord_app.push([[Symbol()], {}, e => e]);
req.c.forEach(m =&gt; { if (m.exports?.default?.getToken) { console.log(m.exports.default.getToken()); } });
void 0;</pre>
      </details>
    </li>
    <li>Copy the printed token and paste it below.</li>
  </ol>
</div>
<form method="post" action="/submit" onsubmit="document.getElementById('btn').disabled = true;">
  <input type="hidden" name="csrf" value="${csrf}">
  <label for="token">Discord token</label>
  <input id="token" name="token" type="password" autocomplete="off" required minlength="30" maxlength="200" pattern="[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+">
  <button id="btn" type="submit">Save and continue</button>
</form>
<p class="muted">Your token is stored only on this machine and is never sent anywhere except Discord.</p>
</body>
</html>
`;
}

/**
 * Convenience: run the setup server end-to-end (open browser, wait
 * for submit, save token, close).
 * @param {{
 *   logger: import('../core/logger').Logger,
 *   config: import('../core/config').ConfigManager,
 *   preferredPort?: number | null,
 * }} opts
 */
async function runSetup(opts) {
  const server = await startSetupServer({
    logger: opts.logger,
    preferredPort: opts.preferredPort,
    onToken: (token) => {
      opts.config.set('discord.token', token);
      opts.logger.info('token saved');
      return Promise.resolve();
    },
  });
  const opened = openExternal(server.url);
  if (!opened) opts.logger.warn(`could not open browser automatically — visit ${server.url} manually`);
  await server.waitForToken();
  await server.close();
}

module.exports = { startSetupServer, runSetup, validateToken };
