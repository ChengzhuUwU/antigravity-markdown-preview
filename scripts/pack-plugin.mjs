import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DIST_DIR = join(ROOT, 'dist');
const STAGE_DIR = join(DIST_DIR, 'stage', 'agy-markdown-preview');
const OUT_ZIP = join(DIST_DIR, 'agy-markdown-preview.zip');

const INCLUDE_FILES = ['plugin.json', 'hooks.json', 'README.md', 'LICENSE'];
const INCLUDE_DIRS = ['assets', 'bin', 'public', 'server', 'sidecars', 'skills'];

if (!existsSync(join(ROOT, 'public', 'vendor', 'marked.min.js'))) {
  throw new Error('public/vendor/ is missing. Run `npm run sync-vendor` first.');
}

rmSync(DIST_DIR, { recursive: true, force: true });
mkdirSync(STAGE_DIR, { recursive: true });

for (const file of INCLUDE_FILES) {
  const src = join(ROOT, file);
  if (existsSync(src)) cpSync(src, join(STAGE_DIR, file));
}

for (const dir of INCLUDE_DIRS) {
  const src = join(ROOT, dir);
  if (existsSync(src)) cpSync(src, join(STAGE_DIR, dir), { recursive: true });
}

mkdirSync(join(STAGE_DIR, 'scripts'), { recursive: true });
cpSync(join(ROOT, 'scripts', 'hook-sync.mjs'), join(STAGE_DIR, 'scripts', 'hook-sync.mjs'));

if (process.platform === 'win32') {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path "${STAGE_DIR}\\*" -DestinationPath "${OUT_ZIP}" -Force`,
    ],
    { stdio: 'inherit' }
  );
} else {
  execFileSync('zip', ['-r', '-q', OUT_ZIP, '.'], { cwd: STAGE_DIR, stdio: 'inherit' });
}

rmSync(join(DIST_DIR, 'stage'), { recursive: true, force: true });
console.log(`[pack-plugin] Created distributable archive: ${OUT_ZIP}`);
