/**
 * Single-instance lock for Windows.
 *
 * Strategy: write a "registration" object to a file in the per-user
 * data directory. The file contains {pid, startedAt, nonce}. We open
 * it in exclusive-create mode (`wx`) so the OS refuses to give two
 * processes the handle. If the file already exists we check whether
 * the recorded PID is still alive AND whether its registration is
 * recent — both must be true for the lock to be considered held.
 *
 * We deliberately avoid named Windows mutexes: they require native
 * code and are not available to a pure-Node SEA bundle.
 *
 * The lock is best-effort: a process may briefly hold two locks if
 * the system clock or PID space is hostile. That is acceptable for
 * a background status updater.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { userDataDir } = require('./paths');

/** A registration is considered stale after this many seconds. */
const STALE_AFTER_SEC = 60;

/**
 * @returns {(() => void) | null}
 */
function acquire() {
  const dir = userDataDir('lock');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'instance.lock');
  /** @type {{pid: number, startedAt: number, nonce: string}} */
  const me = { pid: process.pid, startedAt: Date.now(), nonce: crypto.randomBytes(6).toString('hex') };
  const myJson = JSON.stringify(me);

  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (err) {
    if (!err || /** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') {
      return null;
    }
    // Try to recover a stale lock.
    const prior = readLock(lockFile);
    if (!prior || !lockIsLive(prior)) {
      try { fs.unlinkSync(lockFile); } catch { return null; }
      try {
        fd = fs.openSync(lockFile, 'wx');
      } catch { return null; }
    } else {
      // The lock is held by a live process — refuse.
      return null;
    }
  }
  if (fd == null) return null;
  try {
    fs.writeSync(fd, myJson);
    try { fs.fsyncSync(fd); } catch { /* not all FS support fsync */ }
  } finally {
    fs.closeSync(fd);
  }
  /** A heartbeat keeps the file fresh in case the OS reuses a PID. */
  const heartbeat = setInterval(() => {
    try {
      const cur = readLock(lockFile);
      if (cur && cur.nonce === me.nonce) {
        fs.writeFileSync(lockFile, JSON.stringify({ ...me, startedAt: Date.now() }), 'utf8');
      }
    } catch { /* ignore */ }
  }, STALE_AFTER_SEC * 1000 / 2);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    try {
      const cur = readLock(lockFile);
      if (cur && cur.nonce === me.nonce) fs.unlinkSync(lockFile);
    } catch { /* ignore */ }
  };
}

/**
 * @param {string} p
 */
function readLock(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object'
      && Number.isFinite(obj.pid)
      && typeof obj.nonce === 'string'
      && Number.isFinite(obj.startedAt)) return obj;
  } catch { /* corrupt */ }
  return null;
}

/**
 * @param {{pid: number, startedAt: number, nonce: string}} prior
 */
function lockIsLive(prior) {
  if (!isAlive(prior.pid)) return false;
  // Registration timestamp must be recent.
  if (Date.now() - prior.startedAt > STALE_AFTER_SEC * 1000) return false;
  return true;
}

/**
 * @param {number} pid
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{ isPrimary: boolean, release: () => void }}
 */
function enforce() {
  const release = acquire();
  if (release) return { isPrimary: true, release };
  return { isPrimary: false, release: () => {} };
}

module.exports = { acquire, enforce, isAlive };
