import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const NM = join(ROOT, 'node_modules');
const VENDOR = join(ROOT, 'public', 'vendor');

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  if (!existsSync(src)) {
    throw new Error(`Missing vendor source file: ${src}`);
  }
  ensureDir(dirname(dest));
  cpSync(src, dest);
}

if (existsSync(VENDOR)) {
  rmSync(VENDOR, { recursive: true, force: true });
}
ensureDir(VENDOR);

// 1. marked (browser UMD/min build)
copyFile(join(NM, 'marked', 'marked.min.js'), join(VENDOR, 'marked.min.js'));

// 2. highlight.js browser bundle + light/dark github themes
copyFile(join(NM, '@highlightjs', 'cdn-assets', 'highlight.min.js'), join(VENDOR, 'highlight.min.js'));
copyFile(join(NM, '@highlightjs', 'cdn-assets', 'styles', 'github.min.css'), join(VENDOR, 'hljs-light.min.css'));
copyFile(join(NM, '@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css'), join(VENDOR, 'hljs-dark.min.css'));

// 3. KaTeX JS + CSS + modern woff2 fonts only
copyFile(join(NM, 'katex', 'dist', 'katex.min.js'), join(VENDOR, 'katex.min.js'));
copyFile(join(NM, 'katex', 'dist', 'katex.min.css'), join(VENDOR, 'katex.min.css'));
const fontsSrc = join(NM, 'katex', 'dist', 'fonts');
const fontsDest = join(VENDOR, 'fonts');
ensureDir(fontsDest);
for (const file of readdirSync(fontsSrc)) {
  if (file.endsWith('.woff2')) {
    copyFile(join(fontsSrc, file), join(fontsDest, file));
  }
}

// 4. Mermaid standalone browser UMD bundle (lazy-loaded in UI only when needed)
copyFile(join(NM, 'mermaid', 'dist', 'mermaid.min.js'), join(VENDOR, 'mermaid.min.js'));

console.log(`[sync-vendor] Copied offline assets to ${VENDOR}`);
