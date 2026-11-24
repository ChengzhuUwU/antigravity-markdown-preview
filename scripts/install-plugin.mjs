import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const TARGET = join(homedir(), '.gemini', 'config', 'plugins', 'agy-session-preview');
const LEGACY_TARGET = join(homedir(), '.gemini', 'config', 'plugins', 'agy-markdown-preview');
const USER_BIN = join(homedir(), '.local', 'bin');

const INCLUDE_FILES = ['plugin.json', 'hooks.json', 'README.md', 'LICENSE'];
const INCLUDE_DIRS = ['assets', 'bin', 'public', 'server', 'sidecars', 'skills'];

if (process.argv.includes('--uninstall')) {
  for (const dir of [TARGET, LEGACY_TARGET]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      console.log(`[install-plugin] Removed ${dir}`);
    }
  }
  for (const shim of ['agy-preview.cmd', 'agy-preview']) {
    const p = join(USER_BIN, shim);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  process.exit(0);
}

if (!existsSync(join(ROOT, 'public', 'vendor', 'marked.min.js'))) {
  console.error('[install-plugin] public/vendor/ missing. Run `npm run sync-vendor` first.');
  process.exit(1);
}

mkdirSync(TARGET, { recursive: true });

for (const file of INCLUDE_FILES) {
  const src = join(ROOT, file);
  if (existsSync(src)) {
    cpSync(src, join(TARGET, file), { force: true });
  }
}

for (const dir of INCLUDE_DIRS) {
  const src = join(ROOT, dir);
  if (existsSync(src)) {
    cpSync(src, join(TARGET, dir), { recursive: true, force: true });
  }
}

// Copy only hook-sync.mjs into installed scripts/ (omit build/install scripts)
mkdirSync(join(TARGET, 'scripts'), { recursive: true });
cpSync(join(ROOT, 'scripts', 'hook-sync.mjs'), join(TARGET, 'scripts', 'hook-sync.mjs'), { force: true });

// Install global `agy-preview` CLI shim into ~/.local/bin
mkdirSync(USER_BIN, { recursive: true });
const installedEntry = join(TARGET, 'bin', 'agy-preview.mjs');

if (process.platform === 'win32') {
  const cmdShim = `@echo off\r\nnode "${installedEntry}" %*\r\n`;
  writeFileSync(join(USER_BIN, 'agy-preview.cmd'), cmdShim, 'utf-8');
}
const shShim = `#!/usr/bin/env sh\nexec node "${installedEntry.replace(/\\/g, '/')}" "$@"\n`;
const shPath = join(USER_BIN, 'agy-preview');
writeFileSync(shPath, shShim, 'utf-8');
try { chmodSync(shPath, 0o755); } catch {}

if (existsSync(LEGACY_TARGET)) {
  rmSync(LEGACY_TARGET, { recursive: true, force: true });
  console.log(`[install-plugin] Removed legacy plugin directory ${LEGACY_TARGET}`);
}

console.log(`[install-plugin] Installed agy-session-preview to ${TARGET}`);
console.log(`[install-plugin] Installed CLI command 'agy-preview' to ${USER_BIN}`);
