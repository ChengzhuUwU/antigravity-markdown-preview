import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TranscriptReader,
  detectFlavors,
  getRollingUsageStats,
  listArtifacts,
  listBtwCommands,
  listConversations,
  resolveConversationDir,
  resolveTranscriptPath,
} from './transcript.mjs';
import { CustomPreviewStore } from './custom-preview.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const PUBLIC_DIR = resolve(HERE, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);
const TEXT_CODE_EXTS = new Set([
  '.py', '.pyi', '.ipynb', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.cu', '.cuh',
  '.rs', '.go', '.java', '.kt', '.kts', '.scala', '.cs', '.swift', '.rb', '.php', '.lua',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte',
  '.sql', '.graphql', '.proto', '.cmake', '.gradle', '.dockerfile', '.makefile',
  '.txt', '.log', '.csv', '.tsv', '.tex', '.bib', '.rst', '.gitignore', '.editorconfig',
]);

const EXT_TO_LANG = {
  '.py': 'python', '.pyi': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.cu': 'cpp',
  '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ps1': 'powershell', '.bat': 'dos', '.cmd': 'dos',
  '.json': 'json', '.jsonl': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.ini': 'ini',
  '.xml': 'xml', '.html': 'xml', '.css': 'css', '.scss': 'scss', '.sql': 'sql',
  '.cmake': 'cmake', '.tex': 'latex', '.md': 'markdown',
};

const BLOCKED_PATH_SEGMENTS = [
  /[\\/]\.ssh(?:[\\/]|$)/i,
  /[\\/]\.gnupg(?:[\\/]|$)/i,
  /[\\/]\.aws(?:[\\/]|$)/i,
  /[\\/]windows[\\/]system32(?:[\\/]|$)/i,
  /^\/etc\/(?:shadow|passwd|sudoers)/i,
];

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectBody(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function normalizeIncomingFilePath(raw) {
  if (!raw || typeof raw !== 'string') return { filePart: '', hashPart: '' };
  let cleaned = raw.trim();
  let hashPart = '';
  const hashIdx = cleaned.indexOf('#');
  if (hashIdx !== -1) {
    hashPart = cleaned.slice(hashIdx + 1);
    cleaned = cleaned.slice(0, hashIdx);
  }
  const qIdx = cleaned.indexOf('?');
  if (qIdx !== -1) {
    cleaned = cleaned.slice(0, qIdx);
  }

  if (cleaned.startsWith('file://')) {
    try {
      const u = new URL(cleaned);
      let p = decodeURIComponent(u.pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
        p = p.slice(1);
      }
      cleaned = p;
    } catch {
      cleaned = decodeURIComponent(cleaned.replace(/^file:\/\/\/?/, ''));
    }
  } else {
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // Keep raw if percent sign is literal
    }
  }
  if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  return { filePart: cleaned, hashPart };
}

const SKIP_SEARCH_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', 'out', '.venv', 'venv', '__pycache__', '.pytest_cache',
]);

function findBareFileUnderRoot(rootDir, bareName) {
  const lowerTarget = bareName.toLowerCase();
  const queue = [{ dir: rootDir, depth: 0 }];
  const deadline = Date.now() + 80;
  let visited = 0;

  while (queue.length > 0 && visited < 350 && Date.now() < deadline) {
    const { dir, depth } = queue.shift();
    visited++;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile() && ent.name.toLowerCase() === lowerTarget) {
        return join(dir, ent.name);
      }
      if (ent.isDirectory() && depth < 4 && !SKIP_SEARCH_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
        queue.push({ dir: join(dir, ent.name), depth: depth + 1 });
      }
    }
  }
  return '';
}

export function resolveSafeFilePath(rawPath, baseDir = '') {
  const { filePart, hashPart } = normalizeIncomingFilePath(rawPath);
  if (!filePart) return { error: 'Empty path', status: 400 };

  const candidates = [];
  let resolvedCleanBase = '';
  const winDriveAbsolute = /^[a-zA-Z]:[\\/]/.test(filePart);
  if (isAbsolute(filePart) || winDriveAbsolute) {
    candidates.push(resolve(filePart));
  } else if (baseDir && typeof baseDir === 'string') {
    const cleanBase = normalizeIncomingFilePath(baseDir).filePart;
    if (cleanBase) {
      resolvedCleanBase = resolve(cleanBase);
      candidates.push(resolve(resolvedCleanBase, filePart));

      // Also check ancestor git repo root if baseDir is a subfolder like `docs/`
      let anc = resolvedCleanBase;
      for (let i = 0; i < 3; i++) {
        const parent = dirname(anc);
        if (!parent || parent === anc) break;
        anc = parent;
        if (existsSync(join(anc, '.git'))) {
          candidates.push(resolve(anc, filePart));
          break;
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { error: `Cannot resolve relative path without base directory: ${filePart}`, status: 400 };
  }

  let chosen = candidates.find((c) => existsSync(c)) || '';

  // Fallback for bare filename links (e.g. `pce_contracts.py#L1390-L1600`) inside a project subdirectory
  if (!chosen && resolvedCleanBase && !/[\\/]/.test(filePart) && existsSync(resolvedCleanBase)) {
    chosen = findBareFileUnderRoot(resolvedCleanBase, filePart);
  }

  if (!chosen) {
    chosen = candidates[0];
  }

  for (const blockedRe of BLOCKED_PATH_SEGMENTS) {
    if (blockedRe.test(chosen)) {
      return { error: 'Access denied: restricted system or credential path', status: 403 };
    }
  }

  if (!existsSync(chosen)) {
    return { error: `File not found: ${chosen}`, status: 404, resolvedPath: chosen };
  }

  try {
    const st = statSync(chosen);
    // If link points to a directory (e.g. `isaacgymenvs/`), resolve to its README.md if present
    if (st.isDirectory()) {
      const readme = ['README.md', 'readme.md', 'index.md'].map((n) => join(chosen, n)).find((p) => existsSync(p));
      if (readme) {
        chosen = readme;
      } else {
        return { error: `Target is a directory: ${chosen}`, status: 400 };
      }
    }
  } catch (err) {
    return { error: err.message, status: 500 };
  }

  return { resolvedPath: chosen, hashPart, status: 200 };
}

function classifyFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const base = basename(filePath).toLowerCase();
  if (MARKDOWN_EXTS.has(ext)) return { kind: 'markdown', ext, lang: 'markdown' };
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', ext, lang: '' };
  if (TEXT_CODE_EXTS.has(ext) || ['dockerfile', 'makefile', 'cmakelists.txt', 'license', 'readme'].includes(base)) {
    return { kind: 'code', ext, lang: EXT_TO_LANG[ext] || (base === 'cmakelists.txt' ? 'cmake' : 'plaintext') };
  }
  return { kind: 'unknown', ext, lang: EXT_TO_LANG[ext] || 'plaintext' };
}

export function spawnAppWindow(url) {
  const winCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const macCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  const candidates = process.platform === 'win32' ? winCandidates : (process.platform === 'darwin' ? macCandidates : []);
  const browser = candidates.find((p) => existsSync(p)) || '';

  if (browser) {
    const child = spawn(browser, [`--app=${url}`, '--new-window'], { detached: true, stdio: 'ignore' });
    child.unref();
    return { launchedWith: browser, mode: 'app-window' };
  }
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    return { launchedWith: 'default-browser', mode: 'browser' };
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
  child.unref();
  return { launchedWith: opener, mode: 'browser' };
}

export function createPreviewEngine({ onExtraRoute, tokenValidator, storePersistPath } = {}) {
  const reader = new TranscriptReader();
  const customStore = new CustomPreviewStore(storePersistPath !== undefined ? { persistPath: storePersistPath } : {});
  const btwNotesPath = customStore.persistPath ? join(dirname(customStore.persistPath), 'btw-notes.json') : '';
  const btwNotesByConv = new Map(); // convId -> [{ id, question, answer, createdAt }]
  let btwNotesMtimeMs = 0;
  const loadBtwNotesFromDisk = () => {
    if (!btwNotesPath || !existsSync(btwNotesPath)) return;
    try {
      const st = statSync(btwNotesPath);
      if (st.mtimeMs <= btwNotesMtimeMs + 1) return;
      const savedBtw = JSON.parse(readFileSync(btwNotesPath, 'utf-8'));
      btwNotesByConv.clear();
      if (savedBtw && typeof savedBtw === 'object') {
        for (const [cid, arr] of Object.entries(savedBtw)) {
          if (Array.isArray(arr)) btwNotesByConv.set(cid, arr);
        }
      }
      btwNotesMtimeMs = st.mtimeMs;
    } catch {}
  };
  loadBtwNotesFromDisk();
  const saveBtwNotes = () => {
    if (!btwNotesPath) return;
    try {
      mkdirSync(dirname(btwNotesPath), { recursive: true });
      writeFileSync(btwNotesPath, JSON.stringify(Object.fromEntries(btwNotesByConv), null, 2), 'utf-8');
      btwNotesMtimeMs = statSync(btwNotesPath).mtimeMs;
    } catch {}
  };
  const sseClients = new Set(); // { res, convId, previewId }
  const watchers = new Map(); // key -> { watcher, timer, refs }
  const liveHookStates = new Map(); // convId -> { phase, toolName, detail, updatedAt }

  function broadcastEvent(eventName, payload, filterFn = null) {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      if (filterFn && !filterFn(client)) continue;
      try {
        client.res.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function ensureTranscriptWatch(convId, flavorHint) {
    const resolved = resolveConversationDir(convId, flavorHint);
    if (!resolved) return null;
    const tPath = resolveTranscriptPath(resolved.dir);
    if (!tPath) return null;

    if (!watchers.has(tPath)) {
      let timer = null;
      const emitUpdate = () => {
        try {
          const { view, updatedAt } = reader.read(tPath);
          broadcastEvent(
            'transcript',
            {
              conversationId: convId,
              flavor: resolved.flavor,
              updatedAt,
              view,
              hookState: liveHookStates.get(convId) || null,
            },
            (c) => !c.convId || c.convId === convId
          );
        } catch {
          // Ignore transient partial write
        }
      };

      try {
        const watcher = watch(tPath, { persistent: false }, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(emitUpdate, 90);
        });
        watchers.set(tPath, { watcher, timer, kind: 'transcript', convId });
      } catch {
        // Fallback polling handled by heartbeat if watch unsupported
      }
    }
    return { ...resolved, transcriptPath: tPath };
  }

  function ensureCustomFileWatch(previewId, filePath) {
    if (!filePath || watchers.has(filePath)) return;
    let timer = null;
    try {
      const watcher = watch(filePath, { persistent: false }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const refreshed = customStore.refreshFromFile(previewId);
          if (refreshed) {
            broadcastEvent(
              'custom-preview',
              refreshed,
              (c) => !c.previewId || c.previewId === previewId
            );
          }
        }, 120);
      });
      watchers.set(filePath, { watcher, timer, kind: 'custom', previewId });
    } catch {
      // Ignore
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 15000);
  heartbeat.unref?.();

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (onExtraRoute) {
      const handled = await onExtraRoute(req, res, url);
      if (handled) return;
    }

    if (req.method !== 'GET' && tokenValidator && !tokenValidator(req, url)) {
      return sendJson(res, 401, { error: 'Unauthorized: invalid sidecar token' });
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, pid: process.pid, clients: sseClients.size });
    }

    if (req.method === 'GET' && pathname === '/api/flavors') {
      return sendJson(res, 200, { flavors: detectFlavors() });
    }

    if (req.method === 'GET' && pathname === '/api/conversations') {
      const flavor = url.searchParams.get('flavor') || 'antigravity-cli';
      const limit = Math.min(2000, Math.max(10, Number(url.searchParams.get('limit')) || 1000));
      return sendJson(res, 200, { flavor, conversations: listConversations(flavor, limit) });
    }

    const viewMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/view$/);
    if (req.method === 'GET' && viewMatch) {
      const convId = decodeURIComponent(viewMatch[1]);
      const flavorHint = url.searchParams.get('flavor') || undefined;
      const resolved = resolveConversationDir(convId, flavorHint);
      if (!resolved) {
        return sendJson(res, 404, { error: `Conversation not found: ${convId}` });
      }
      const tPath = resolveTranscriptPath(resolved.dir);
      const { view, updatedAt } = reader.read(tPath);
      const artifacts = listArtifacts(resolved.dir);
      const allConvs = listConversations(resolved.flavor, 1000);
      const catalogEntry = allConvs.find((c) => c.id === convId);
      const subagents = allConvs.filter((c) => c.parentConversationId === convId);
      const parentSession = catalogEntry?.parentConversationId
        ? allConvs.find((c) => c.id === catalogEntry.parentConversationId) || { id: catalogEntry.parentConversationId, title: 'Parent Session' }
        : null;
      loadBtwNotesFromDisk();
      ensureTranscriptWatch(convId, resolved.flavor);
      return sendJson(res, 200, {
        conversationId: convId,
        flavor: resolved.flavor,
        transcriptPath: tPath,
        baseDir: catalogEntry?.workspaceUri || resolved.dir,
        artifactDir: resolved.dir,
        projectName: catalogEntry?.projectName || '',
        subagents,
        parentSession,
        cliInsights: {
          btwCommands: listBtwCommands(convId, resolved.flavor),
          btwNotes: btwNotesByConv.get(convId) || [],
          globalUsage: getRollingUsageStats(resolved.flavor),
        },
        updatedAt,
        view,
        artifacts,
        hookState: liveHookStates.get(convId) || null,
      });
    }

    const btwNotesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/btw-notes(?:\/([^/]+))?$/);
    if (btwNotesMatch) {
      const convId = decodeURIComponent(btwNotesMatch[1]);
      const noteId = btwNotesMatch[2] ? decodeURIComponent(btwNotesMatch[2]) : '';
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const answer = String(body.answer || '').trim();
          if (!answer) return sendJson(res, 400, { error: 'Answer text is empty' });
          const notes = btwNotesByConv.get(convId) || [];
          const note = {
            id: `btw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            question: String(body.question || '').trim(),
            answer,
            createdAt: Date.now(),
          };
          notes.push(note);
          btwNotesByConv.set(convId, notes);
          saveBtwNotes();
          return sendJson(res, 200, { ok: true, notes });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (req.method === 'DELETE' && noteId) {
        const notes = (btwNotesByConv.get(convId) || []).filter((n) => n.id !== noteId);
        btwNotesByConv.set(convId, notes);
        saveBtwNotes();
        return sendJson(res, 200, { ok: true, notes });
      }
    }

    const stepMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/steps\/(\d+)$/);
    if (req.method === 'GET' && stepMatch) {
      const convId = decodeURIComponent(stepMatch[1]);
      const stepIndex = Number(stepMatch[2]);
      const flavorHint = url.searchParams.get('flavor') || undefined;
      const resolved = resolveConversationDir(convId, flavorHint);
      if (!resolved) return sendJson(res, 404, { error: 'Conversation not found' });
      const tPath = resolveTranscriptPath(resolved.dir);
      const stepData = reader.getStepOutput(tPath, stepIndex);
      if (!stepData) return sendJson(res, 404, { error: 'Step not found' });
      return sendJson(res, 200, stepData);
    }

    // Reveal target file (or its parent directory) in the native OS file manager
    if (req.method === 'POST' && pathname === '/api/reveal-in-folder') {
      try {
        const body = await readJsonBody(req);
        const check = resolveSafeFilePath(body.path || '', body.base || '');
        if (check.error) {
          return sendJson(res, check.status || 400, { error: check.error });
        }
        const resolvedPath = check.resolvedPath;
        const folderPath = dirname(resolvedPath);
        if (!body.dryRun) {
          if (process.platform === 'win32') {
            const child = spawn('explorer.exe', [`/select,${resolvedPath}`], { detached: true, stdio: 'ignore' });
            child.unref();
          } else if (process.platform === 'darwin') {
            const child = spawn('open', ['-R', resolvedPath], { detached: true, stdio: 'ignore' });
            child.unref();
          } else {
            const child = spawn('xdg-open', [folderPath], { detached: true, stdio: 'ignore' });
            child.unref();
          }
        }
        return sendJson(res, 200, { ok: true, path: resolvedPath, folder: folderPath });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // Rich file metadata + content endpoint for Side Preview Pane (supports relative paths!)
    if (req.method === 'GET' && pathname === '/api/file-info') {
      const targetPath = url.searchParams.get('path') || '';
      const baseDir = url.searchParams.get('base') || '';
      const check = resolveSafeFilePath(targetPath, baseDir);
      if (check.error) {
        return sendJson(res, check.status || 400, { error: check.error, resolvedPath: check.resolvedPath || '' });
      }
      try {
        const st = statSync(check.resolvedPath);
        const info = classifyFile(check.resolvedPath);
        const result = {
          path: check.resolvedPath,
          filename: basename(check.resolvedPath),
          baseDir: dirname(check.resolvedPath),
          hash: check.hashPart || '',
          size: st.size,
          kind: info.kind,
          lang: info.lang,
          ext: info.ext,
        };
        if (info.kind === 'image') {
          result.rawUrl = `/api/raw-file?path=${encodeURIComponent(check.resolvedPath)}`;
          return sendJson(res, 200, result);
        }
        // Read text content up to 2 MB; also sniff UTF-8 for unknown extension text files
        if (st.size <= 2 * 1024 * 1024) {
          const buf = readFileSync(check.resolvedPath);
          const isBinary = buf.subarray(0, Math.min(buf.length, 4096)).includes(0);
          if (!isBinary) {
            result.kind = info.kind === 'unknown' ? 'code' : info.kind;
            result.content = buf.toString('utf-8');
          } else {
            result.kind = 'binary';
          }
        } else {
          result.truncated = true;
          const buf = readFileSync(check.resolvedPath).subarray(0, 512 * 1024);
          result.content = buf.toString('utf-8');
        }
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // Binary-safe raw file & image endpoint (supports relative paths + baseDir)
    if (req.method === 'GET' && (pathname === '/api/raw-file' || pathname === '/api/file')) {
      const targetPath = url.searchParams.get('path') || '';
      const baseDir = url.searchParams.get('base') || '';
      const check = resolveSafeFilePath(targetPath, baseDir);
      if (check.error) {
        return sendJson(res, check.status || 400, { error: check.error });
      }
      try {
        const ext = extname(check.resolvedPath).toLowerCase();
        const contentType = pathname === '/api/file'
          ? 'text/plain; charset=utf-8'
          : (MIME_TYPES[ext] || 'application/octet-stream');
        const buf = readFileSync(check.resolvedPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
        return;
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/previews') {
      return sendJson(res, 200, {
        previews: customStore.list(),
        storagePath: customStore.persistPath || '',
      });
    }

    if (req.method === 'POST' && pathname === '/api/previews') {
      try {
        const body = await readJsonBody(req);
        const entry = customStore.createOrUpdate({
          id: body.id,
          title: body.title,
          filePath: body.filePath,
          droppedFilename: body.droppedFilename || '',
          baseDir: body.baseDir || '',
          mode: body.mode || 'auto',
          content: body.content,
        });
        if (entry.filePath) {
          ensureCustomFileWatch(entry.id, entry.filePath);
        }
        broadcastEvent('custom-preview', entry);
        return sendJson(res, 200, entry);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/previews/reorder') {
      try {
        const body = await readJsonBody(req);
        customStore.reorder(body.orderedIds || []);
        return sendJson(res, 200, { ok: true, previews: customStore.list() });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // Native OS file picker for exact path selection on Windows
    if (req.method === 'POST' && pathname === '/api/pick-file') {
      if (process.platform !== 'win32') {
        return sendJson(res, 400, { error: 'Native file dialog is only supported on Windows' });
      }
      try {
        const psScript = `Add-Type -AssemblyName System.Windows.Forms; $dlg = New-Object System.Windows.Forms.OpenFileDialog; $dlg.Filter = 'Markdown & Logs (*.md;*.markdown;*.jsonl;*.txt)|*.md;*.markdown;*.jsonl;*.txt|All Files (*.*)|*.*'; $dlg.Title = 'Select File to Preview'; if ($dlg.ShowDialog() -eq 'OK') { Write-Output $dlg.FileName }`;
        const selectedPath = await new Promise((resolvePick, rejectPick) => {
          const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], { windowsHide: true });
          let out = '';
          child.stdout.on('data', (c) => { out += c.toString('utf-8'); });
          child.on('error', rejectPick);
          child.on('close', () => resolvePick(out.trim()));
        });
        if (!selectedPath) {
          return sendJson(res, 200, { canceled: true });
        }
        const entry = customStore.createOrUpdate({ filePath: selectedPath });
        ensureCustomFileWatch(entry.id, entry.filePath);
        broadcastEvent('custom-preview', entry);
        return sendJson(res, 200, { canceled: false, entry });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    const previewItemMatch = pathname.match(/^\/api\/previews\/([^/]+)$/);
    if (previewItemMatch) {
      const id = decodeURIComponent(previewItemMatch[1]);
      if (req.method === 'GET') {
        const refreshed = customStore.refreshFromFile(id) || customStore.get(id);
        if (!refreshed) return sendJson(res, 404, { error: 'Preview not found' });
        if (refreshed.filePath) ensureCustomFileWatch(refreshed.id, refreshed.filePath);
        return sendJson(res, 200, refreshed);
      }
      if (req.method === 'PATCH') {
        try {
          const body = await readJsonBody(req);
          const updated = customStore.updateMeta(id, body);
          if (!updated) return sendJson(res, 404, { error: 'Preview not found' });
          broadcastEvent('custom-preview', updated);
          return sendJson(res, 200, updated);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (req.method === 'DELETE') {
        const entry = customStore.get(id);
        if (entry?.filePath && watchers.has(entry.filePath)) {
          const w = watchers.get(entry.filePath);
          if (w.timer) clearTimeout(w.timer);
          try { w.watcher.close(); } catch {}
          watchers.delete(entry.filePath);
        }
        const ok = customStore.delete(id);
        return sendJson(res, ok ? 200 : 404, { ok });
      }
    }

    if (req.method === 'POST' && pathname === '/api/hook-event') {
      try {
        const payload = await readJsonBody(req, 1024 * 1024);
        const convId = payload.conversationId || '';
        const hookEventName = payload.hookEventName || '';
        const toolName = payload.toolCall?.name || '';

        if (convId && hookEventName === 'BtwCaptured') {
          loadBtwNotesFromDisk();
          broadcastEvent('btw-updated', {
            conversationId: convId,
            btwNotes: btwNotesByConv.get(convId) || [],
          });
          return sendJson(res, 200, { ok: true });
        }

        if (convId) {
          let phase = 'idle';
          if (hookEventName === 'PreInvocation') phase = 'thinking';
          else if (hookEventName === 'PreToolUse') phase = 'running_tool';
          else if (hookEventName === 'PostToolUse') phase = 'tool_done';
          else if (hookEventName === 'PostInvocation') phase = 'idle';
          else if (hookEventName === 'Stop') phase = 'stopped';
          else if (hookEventName === 'SessionStart') phase = 'started';

          const hookState = {
            phase,
            hookEventName,
            toolName,
            error: payload.error || '',
            updatedAt: Date.now(),
          };
          liveHookStates.set(convId, hookState);
          broadcastEvent('hook', { conversationId: convId, hookState });

          const resolved = resolveConversationDir(convId);
          const tPath = payload.transcriptPath || (resolved ? resolveTranscriptPath(resolved.dir) : null);
          if (tPath && existsSync(tPath)) {
            const { view, updatedAt } = reader.read(tPath);
            broadcastEvent(
              'transcript',
              { conversationId: convId, flavor: resolved?.flavor || 'antigravity-cli', updatedAt, view, hookState },
              (c) => !c.convId || c.convId === convId
            );
          }
        }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/focus') {
      try {
        const body = await readJsonBody(req);
        if (body.openWindow && typeof body.url === 'string' && body.url.startsWith('http://127.0.0.1:')) {
          const launched = spawnAppWindow(body.url);
          return sendJson(res, 200, { ok: true, window: launched, clients: sseClients.size });
        }
        broadcastEvent('focus', body);
        return sendJson(res, 200, { ok: true, clients: sseClients.size });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const convId = url.searchParams.get('conv') || '';
      const previewId = url.searchParams.get('preview') || '';
      const flavorHint = url.searchParams.get('flavor') || undefined;
      if (convId) ensureTranscriptWatch(convId, flavorHint);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, convId, previewId })}\n\n`);

      const client = { res, convId, previewId };
      sseClients.add(client);
      req.on('close', () => {
        sseClients.delete(client);
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/preload.js') {
      return sendText(res, 200, 'window.__standalonePreviewMode = true;', 'application/javascript; charset=utf-8');
    }

    if (req.method === 'GET') {
      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const fullPath = resolve(PUBLIC_DIR, relPath);
      if (!fullPath.startsWith(PUBLIC_DIR)) {
        return sendText(res, 403, 'Forbidden');
      }
      if (existsSync(fullPath)) {
        const st = statSync(fullPath);
        if (st.isFile()) {
          const ext = extname(fullPath).toLowerCase();
          return res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          }).end(readFileSync(fullPath));
        }
      }
      return sendText(res, 404, 'Not Found');
    }

    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  function close() {
    clearInterval(heartbeat);
    for (const entry of watchers.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      try { entry.watcher.close(); } catch {}
    }
    watchers.clear();
    for (const client of sseClients) {
      try { client.res.end(); } catch {}
    }
    sseClients.clear();
  }

  return { handleRequest, close, customStore, reader };
}

export function startStandaloneServer({ port = 0, host = '127.0.0.1', storePersistPath } = {}) {
  const engine = createPreviewEngine({ storePersistPath });
  const server = createServer((req, res) => {
    engine.handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message });
      }
    });
  });

  return new Promise((resolveStart, rejectStart) => {
    server.on('error', rejectStart);
    server.listen(port, host, () => {
      const addr = server.address();
      resolveStart({ server, port: addr.port, host, engine });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const portArgIdx = process.argv.indexOf('--port');
  const port = portArgIdx !== -1 ? Number(process.argv[portArgIdx + 1]) || 0 : (Number(process.env.PREVIEW_PORT) || 0);
  const { port: boundPort } = await startStandaloneServer({ port });
  console.log(`[agy-session-preview] listening on http://127.0.0.1:${boundPort}`);
}
