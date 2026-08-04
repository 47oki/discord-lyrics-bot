#!/usr/bin/env node
/**
 * Entry point.
 *
 * Responsibilities:
 *   1. Install top-level error handlers so the process never dies
 *      silently from an unhandled rejection or uncaught exception.
 *   2. Acquire the single-instance lock.
 *   3. Initialize config + logger.
 *   4. If no Discord token is configured, run the browser setup flow.
 *   5. Wire up dependencies and start the StateManager.
 *   6. Handle SIGINT/SIGTERM with a clean shutdown.
 */
'use strict';

const { Logger } = require('./core/logger');
const { ConfigManager } = require('./core/config');
const { enforce: singleInstance } = require('./core/single-instance');
const { SmtcService } = require('./services/smtc-service');
const { LyricsProvider } = require('./services/lyrics-provider');
const { Scheduler } = require('./services/scheduler');
const { DiscordClient } = require('./services/discord-client');
const { StateManager } = require('./core/state-manager');
const { runSetup } = require('./setup/setup-server');
const { AppError } = require('./core/errors');
const { PowerShellBridgeAdapter } = require('./services/powershell-bridge-adapter');
const { MockPlaybackAdapter } = require('./services/mock-adapter');

main().catch((err) => {
  // Last-resort logging. We use stderr here because the logger may
  // not have been initialized.
  try {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : String(err)}\n`);
  } catch {
    // ignore
  }
  process.exit(1);
});

async function main() {
  installGlobalErrorHandlers();

  const lock = singleInstance();
  if (!lock.isPrimary) {
    process.stderr.write('another instance is already running\n');
    process.exit(2);
  }

  const config = new ConfigManager();
  config.load();

  const verbose = !!config.get('logging.verbose');
  const logger = new Logger({ level: /** @type {any} */ (config.get('logging.level') || 'info'), verbose });

  logger.info('startup', {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
  });

  // Verify a Discord token exists; otherwise run setup.
  let token = /** @type {string|null} */ (config.get('discord.token'));
  if (!token) {
    logger.info('no token configured; running setup');
    await runSetup({ logger, config });
    token = /** @type {string|null} */ (config.get('discord.token'));
    if (!token) {
      throw new AppError('setup did not yield a token');
    }
  }

  const smtc = new SmtcService({ logger, adapter: createAdapter(logger) });
  const lyrics = new LyricsProvider({
    logger,
    timeoutMs: /** @type {number} */ (config.get('lyrics.timeoutMs')) || 8000,
    maxRetries: /** @type {number} */ (config.get('lyrics.maxRetries')) || 4,
    cacheTtlMs: /** @type {number} */ (config.get('lyrics.cacheTtlMs')) || (24 * 60 * 60 * 1000),
  });
  const scheduler = new Scheduler();
  const discord = new DiscordClient({
    token,
    logger,
    userId: /** @type {string|null} */ (config.get('discord.userId')),
  });
  const state = new StateManager({ logger, config, smtc, lyrics, scheduler, discord });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try { await state.stop(); } catch (err) { logger.warn('state.stop failed', { err: String(err) }); }
    try { await logger.close(); } catch { /* ignore */ }
    try { lock.release(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => undefined); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => undefined); });
  process.on('SIGHUP', () => { shutdown('SIGHUP').catch(() => undefined); });

  await state.start();
}

/**
 * Install process-level safety nets. These exist solely to convert
 * "the runtime died for no apparent reason" into a logged error
 * followed by an orderly exit.
 */
function installGlobalErrorHandlers() {
  process.on('unhandledRejection', (reason) => {
    try {
      process.stderr.write(`unhandledRejection: ${String(reason && reason.stack ? reason.stack : reason)}\n`);
    } catch { /* ignore */ }
  });
  process.on('uncaughtException', (err) => {
    try {
      process.stderr.write(`uncaughtException: ${err && err.stack ? err.stack : String(err)}\n`);
    } catch { /* ignore */ }
    // Best practice: exit. The OS will restart us if needed.
    process.exit(1);
  });
}

/**
 * Choose the playback adapter based on platform and env.
 *
 * - On Windows, use the PowerShell bridge. It works on PS5 and PS7,
 *   does not require any native compilation, and is overridable via
 *   DLS_ADAPTER=mock for developers who want to test without Spotify.
 * - On other platforms (or in CI), fall back to the mock adapter so
 *   the rest of the runtime can be exercised.
 *
 * @param {import('./core/logger').Logger} logger
 */
function createAdapter(logger) {
  const override = (process.env.DLS_ADAPTER || '').toLowerCase();
  if (override === 'mock') return new MockPlaybackAdapter();
  if (process.platform === 'win32') {
    try {
      return new PowerShellBridgeAdapter({
        logger,
        pollIntervalMs: 100,
     });
    } catch (err) {
      logger.warn('PowerShell bridge adapter unavailable, falling back to mock', { err: String(err) });
      return new MockPlaybackAdapter();
    }
  }
  return new MockPlaybackAdapter();
}