import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDefaultDocsDataDir, getLegacyDocsDataDir, migrateLegacyDataDirIfNeeded } from './custom-preview.mjs';

export const AUTH_COOKIE_NAME = 'amp_session';
const SESSION_MAX_AGE_SEC = 30 * 24 * 3600; // 30 days

export function getDefaultAuthConfigPath() {
  return join(getDefaultDocsDataDir(), 'auth-config.json');
}

function generateRandomPassword(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function sha256Buf(str) {
  return createHash('sha256').update(String(str ?? ''), 'utf-8').digest();
}

function safeEqualStrings(a, b) {
  const bufA = sha256Buf(a);
  const bufB = sha256Buf(b);
  return timingSafeEqual(bufA, bufB) && String(a).length === String(b).length;
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export class PreviewAuthManager {
  #persistPath;
  #state = {
    version: 1,
    enabled: false,
    password: '',
    sessionSecret: randomBytes(32).toString('hex'),
    cliToken: randomBytes(24).toString('hex'),
    updatedAt: '',
  };
  #lastLoadedMtimeMs = 0;
  #loginAttempts = new Map(); // ip -> { count, resetAt }

  constructor({ persistPath = getDefaultAuthConfigPath() } = {}) {
    this.#persistPath = persistPath;
    if (persistPath === getDefaultAuthConfigPath()) {
      migrateLegacyDataDirIfNeeded(dirname(persistPath), getLegacyDocsDataDir());
    }
    this.#loadFromDisk(true);
  }

  get persistPath() {
    return this.#persistPath;
  }

  #loadFromDisk(initializeIfMissing = false) {
    if (!this.#persistPath) return;
    if (!existsSync(this.#persistPath)) {
      if (initializeIfMissing) {
        this.#saveToDisk();
      }
      return;
    }
    try {
      const st = statSync(this.#persistPath);
      const raw = JSON.parse(readFileSync(this.#persistPath, 'utf-8'));
      if (raw && typeof raw === 'object') {
        this.#state = {
          version: 1,
          enabled: Boolean(raw.enabled),
          password: typeof raw.password === 'string' ? raw.password : '',
          sessionSecret: typeof raw.sessionSecret === 'string' && raw.sessionSecret.length >= 32
            ? raw.sessionSecret
            : randomBytes(32).toString('hex'),
          cliToken: typeof raw.cliToken === 'string' && raw.cliToken.length >= 24
            ? raw.cliToken
            : randomBytes(24).toString('hex'),
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        };
      }
      this.#lastLoadedMtimeMs = st.mtimeMs;
    } catch {
      // Keep in-memory state if malformed
    }
  }

  syncFromDisk() {
    if (!this.#persistPath || !existsSync(this.#persistPath)) return;
    try {
      const st = statSync(this.#persistPath);
      if (st.mtimeMs > this.#lastLoadedMtimeMs + 0.5) {
        this.#loadFromDisk(false);
      }
    } catch {}
  }

  #saveToDisk() {
    if (!this.#persistPath) return;
    try {
      mkdirSync(dirname(this.#persistPath), { recursive: true });
      this.#state.updatedAt = new Date().toISOString();
      const jsonText = JSON.stringify(this.#state, null, 2);
      const tmp = `${this.#persistPath}.tmp.${process.pid}`;
      try {
        writeFileSync(tmp, jsonText, { encoding: 'utf-8', mode: 0o600 });
        renameSync(tmp, this.#persistPath);
      } catch {
        try { rmSync(tmp, { force: true }); } catch {}
        writeFileSync(this.#persistPath, jsonText, { encoding: 'utf-8', mode: 0o600 });
      }
      if (process.platform !== 'win32') {
        try { chmodSync(this.#persistPath, 0o600); } catch {}
      }
      this.#lastLoadedMtimeMs = statSync(this.#persistPath).mtimeMs;
    } catch {
      // Ignore read-only test env errors
    }
  }

  getCliToken() {
    this.syncFromDisk();
    return this.#state.cliToken;
  }

  getStatus() {
    this.syncFromDisk();
    const hasPassword = Boolean(this.#state.password);
    const enabled = Boolean(this.#state.enabled);
    return {
      enabled,
      hasPassword,
      authRequired: enabled && hasPassword,
      updatedAt: this.#state.updatedAt || '',
    };
  }

  setPassword(newPassword) {
    this.syncFromDisk();
    const pwd = String(newPassword ?? '').trim();
    if (!pwd) {
      throw new Error('Password cannot be empty. Use --clear-password to remove password protection.');
    }
    this.#state.password = pwd;
    this.#state.enabled = true;
    this.#state.sessionSecret = randomBytes(32).toString('hex');
    this.#saveToDisk();
    return this.getStatus();
  }

  disablePassword() {
    this.syncFromDisk();
    this.#state.enabled = false;
    this.#saveToDisk();
    return this.getStatus();
  }

  clearPassword() {
    this.syncFromDisk();
    this.#state.password = '';
    this.#state.enabled = false;
    this.#state.sessionSecret = randomBytes(32).toString('hex');
    this.#saveToDisk();
    return this.getStatus();
  }

  activatePassword(optionalPassword = '') {
    this.syncFromDisk();
    const provided = String(optionalPassword ?? '').trim();
    let generated = false;
    if (provided) {
      this.#state.password = provided;
      this.#state.sessionSecret = randomBytes(32).toString('hex');
    } else if (!this.#state.password) {
      this.#state.password = generateRandomPassword(12);
      this.#state.sessionSecret = randomBytes(32).toString('hex');
      generated = true;
    }
    this.#state.enabled = true;
    this.#saveToDisk();
    return {
      ...this.getStatus(),
      password: this.#state.password,
      generated,
    };
  }

  printPasswordInfo() {
    this.syncFromDisk();
    return {
      ...this.getStatus(),
      password: this.#state.password,
      configPath: this.#persistPath,
    };
  }

  checkRateLimit(remoteKey = 'local') {
    const now = Date.now();
    const rec = this.#loginAttempts.get(remoteKey);
    if (!rec || now > rec.resetAt) {
      return { allowed: true };
    }
    if (rec.count >= 10) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) };
    }
    return { allowed: true };
  }

  recordLoginAttempt(remoteKey = 'local', success = false) {
    if (success) {
      this.#loginAttempts.delete(remoteKey);
      return;
    }
    const now = Date.now();
    const rec = this.#loginAttempts.get(remoteKey);
    if (!rec || now > rec.resetAt) {
      this.#loginAttempts.set(remoteKey, { count: 1, resetAt: now + 60_000 });
    } else {
      rec.count += 1;
    }
  }

  verifyPassword(candidate) {
    this.syncFromDisk();
    if (!this.#state.password) return true;
    return safeEqualStrings(String(candidate ?? ''), this.#state.password);
  }

  #signPayload(issuedAtSec) {
    const pwdDigest = sha256Buf(this.#state.password).toString('hex').slice(0, 24);
    return createHmac('sha256', this.#state.sessionSecret)
      .update(`v1:${issuedAtSec}:${pwdDigest}`)
      .digest('hex');
  }

  createSessionToken() {
    this.syncFromDisk();
    const issuedAt = Math.floor(Date.now() / 1000);
    const sig = this.#signPayload(issuedAt);
    return `v1.${issuedAt}.${sig}`;
  }

  verifySessionToken(token) {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;
    const issuedAt = Number(parts[1]);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
    const ageSec = Math.floor(Date.now() / 1000) - issuedAt;
    if (ageSec < -300 || ageSec > SESSION_MAX_AGE_SEC) return false;
    const expected = this.#signPayload(issuedAt);
    return safeEqualStrings(parts[2], expected);
  }

  buildSetCookieHeader(token) {
    return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`;
  }

  buildClearCookieHeader() {
    return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  isRequestAuthenticated(req, url = null) {
    const status = this.getStatus();
    if (!status.authRequired) return true;

    const cliHeader = req.headers['x-preview-cli-token'];
    if (typeof cliHeader === 'string' && cliHeader && safeEqualStrings(cliHeader, this.#state.cliToken)) {
      return true;
    }

    const cookies = parseCookies(req.headers.cookie || '');
    if (cookies[AUTH_COOKIE_NAME] && this.verifySessionToken(cookies[AUTH_COOKIE_NAME])) {
      return true;
    }

    const authHeader = req.headers.authorization || '';
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (this.verifySessionToken(bearer)) return true;
    }

    const queryToken = url?.searchParams?.get('authToken') || '';
    if (queryToken && this.verifySessionToken(queryToken)) {
      return true;
    }

    return false;
  }
}
