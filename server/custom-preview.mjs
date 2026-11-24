import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { buildNormalizedView, getGeminiRoot, listConversations } from './transcript.mjs';

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const SKIP_WALK_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.idea', '.vscode',
]);

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

function cleanSingleLinePathCandidate(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r') || trimmed.length > 520) return '';
  let unquoted = trimmed;
  if (
    (unquoted.startsWith('"') && unquoted.endsWith('"')) ||
    (unquoted.startsWith("'") && unquoted.endsWith("'"))
  ) {
    unquoted = unquoted.slice(1, -1).trim();
  }
  if (unquoted.startsWith('file:///')) {
    try {
      let p = decodeURIComponent(new URL(unquoted).pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      unquoted = p;
    } catch {
      return '';
    }
  }
  if (/^(?:[a-zA-Z]:[\\/]|\/|\.{1,2}[\\/])/.test(unquoted)) {
    try {
      const resolved = resolve(unquoted);
      if (existsSync(resolved) && statSync(resolved).isFile()) {
        return resolved;
      }
    } catch {
      return '';
    }
  }
  return '';
}

function collectKnownWorkspaceRoots() {
  const directRoots = [];
  const parentRoots = [];
  const seen = new Set();
  const addRoot = (p, bucket = directRoots) => {
    if (!p || typeof p !== 'string') return;
    try {
      const r = resolve(p);
      const key = process.platform === 'win32' ? r.toLowerCase() : r;
      if (seen.has(key)) return;
      if (existsSync(r) && statSync(r).isDirectory()) {
        seen.add(key);
        bucket.push(r);
      }
    } catch {}
  };

  // 1. ~/.gemini/antigravity-cli/settings.json trustedWorkspaces
  const cliSettings = join(getGeminiRoot(), 'antigravity-cli', 'settings.json');
  if (existsSync(cliSettings)) {
    try {
      const data = JSON.parse(readFileSync(cliSettings, 'utf-8'));
      if (Array.isArray(data?.trustedWorkspaces)) {
        for (const ws of data.trustedWorkspaces) addRoot(ws, directRoots);
      }
    } catch {}
  }

  // 2. ~/.gemini/config/projects/*.json folder URIs
  const projectsDir = join(getGeminiRoot(), 'config', 'projects');
  if (existsSync(projectsDir)) {
    try {
      for (const f of readdirSync(projectsDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(readFileSync(join(projectsDir, f), 'utf-8'));
          for (const res of data?.projectResources?.resources || []) {
            const uri = res?.folderUri || res?.gitFolder?.folderUri || '';
            if (uri.startsWith('file:///')) {
              let p = decodeURIComponent(new URL(uri).pathname);
              if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
              addRoot(p, directRoots);
            }
          }
        } catch {}
      }
    } catch {}
  }

  // 3. Active conversation workspaceUris across flavors
  for (const flavor of ['antigravity-cli', 'antigravity']) {
    try {
      for (const conv of listConversations(flavor, 300)) {
        if (conv.workspaceUri) addRoot(conv.workspaceUri, directRoots);
      }
    } catch {}
  }

  // 4. Parent project containers (e.g. E:\Projects, E:\OpenSources2) + common user folders
  for (const ws of directRoots) {
    const parent = dirname(ws);
    if (parent && parent !== ws && !/^[a-zA-Z]:[\\/]?$/.test(parent) && parent !== '/') {
      addRoot(parent, parentRoots);
    }
  }
  for (const std of ['Desktop', 'Documents', 'Downloads']) {
    addRoot(join(homedir(), std), parentRoots);
  }

  return [...directRoots, ...parentRoots];
}

/**
 * When a file is dragged from OS Explorer into a browser window, Chromium hides `file.path`.
 * Match `{ filename, content }` byte-for-byte against known workspaces so relative links resolve
 * against the true source directory!
 */
export function locateDroppedFileOnDisk(filename, content, extraRoots = []) {
  if (!filename || typeof filename !== 'string' || typeof content !== 'string') return '';
  const cleanName = basename(filename);
  const normTarget = content.replace(/\r\n/g, '\n');
  const roots = [...extraRoots.filter(Boolean), ...collectKnownWorkspaceRoots()];

  const matchesContent = (candidatePath) => {
    try {
      const st = statSync(candidatePath);
      if (!st.isFile()) return false;
      // Fast size pre-check (allow CRLF vs LF difference up to ~10% + 64 bytes)
      const byteLen = Buffer.byteLength(content, 'utf-8');
      if (Math.abs(st.size - byteLen) > Math.max(64, Math.ceil(byteLen * 0.12))) return false;
      const diskText = readFileSync(candidatePath, 'utf-8').replace(/\r\n/g, '\n');
      return diskText === normTarget;
    } catch {
      return false;
    }
  };

  // Pass 1: Direct root check (<root>/<filename>) — catches 90% of project READMEs in <2ms
  for (const r of roots) {
    const direct = join(r, cleanName);
    if (existsSync(direct) && matchesContent(direct)) {
      return direct;
    }
  }

  // Pass 2: Bounded BFS up to depth 3 inside known workspaces (capped at 150ms & 800 dirs)
  const deadline = Date.now() + 180;
  let visitedDirs = 0;
  const queue = roots.map((r) => ({ dir: r, depth: 0 }));
  const visitedSet = new Set();

  while (queue.length > 0 && visitedDirs < 800 && Date.now() < deadline) {
    const { dir, depth } = queue.shift();
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (visitedSet.has(key)) continue;
    visitedSet.add(key);
    visitedDirs++;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (ent.isFile() && ent.name.toLowerCase() === cleanName.toLowerCase()) {
        const full = join(dir, ent.name);
        if (matchesContent(full)) return full;
      } else if (ent.isDirectory() && depth < 3 && !SKIP_WALK_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
        queue.push({ dir: join(dir, ent.name), depth: depth + 1 });
      }
    }
  }

  return '';
}

export function parseRawInput(rawText, hintMode = 'auto', title = 'Preview') {
  const cleaned = stripAnsi(rawText || '').replace(/\r\n/g, '\n');
  const trimmed = cleaned.trim();
  if (!trimmed) {
    return { mode: 'markdown', title, markdown: '', view: null };
  }

  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  const looksLikeJsonl = hintMode === 'stream-json' || (
    lines.length > 0 &&
    lines[0].startsWith('{') &&
    lines.slice(0, Math.min(5, lines.length)).every((l) => l.startsWith('{') && l.endsWith('}'))
  );

  if (looksLikeJsonl) {
    const parsedObjs = [];
    for (const l of lines) {
      try {
        parsedObjs.push(JSON.parse(l));
      } catch {}
    }
    if (parsedObjs.length > 0) {
      if (parsedObjs[0]?.type && parsedObjs[0]?.source) {
        return {
          mode: 'transcript',
          title,
          view: buildNormalizedView(parsedObjs),
          rawText: cleaned,
        };
      }
      const syntheticSteps = convertStreamJsonToSteps(parsedObjs);
      return {
        mode: 'transcript',
        title,
        view: buildNormalizedView(syntheticSteps),
        rawText: cleaned,
      };
    }
  }

  return {
    mode: 'markdown',
    title,
    markdown: cleaned,
    thinkingBlocks: extractXmlThinkingBlocks(cleaned),
    view: null,
  };
}

function extractXmlThinkingBlocks(md) {
  const blocks = [];
  const re = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(md)) !== null) {
    blocks.push(m[2].trim());
  }
  return blocks;
}

function convertStreamJsonToSteps(events) {
  const steps = [];
  let idx = 0;
  let accThinking = '';
  let accContent = '';

  const flushModel = () => {
    if (accThinking || accContent) {
      steps.push({
        step_index: idx++,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        thinking: accThinking,
        content: accContent,
      });
      accThinking = '';
      accContent = '';
    }
  };

  for (const ev of events) {
    const t = ev?.type || ev?.event || '';
    if (t === 'user' || t === 'user_message') {
      flushModel();
      steps.push({
        step_index: idx++,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: ev.timestamp || new Date().toISOString(),
        content: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.message || ev),
      });
    } else if (t === 'thinking' || ev?.delta?.type === 'thinking_delta') {
      accThinking += ev.thinking || ev.text || ev.delta?.thinking || '';
    } else if (t === 'text' || t === 'assistant' || t === 'message' || ev?.delta?.type === 'text_delta') {
      const txt = ev.text || ev.content || ev.delta?.text || ev?.message?.content?.[0]?.text || '';
      if (typeof txt === 'string') accContent += txt;
    } else if (t === 'tool_use' || t === 'tool_call') {
      flushModel();
      steps.push({
        step_index: idx++,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        tool_calls: [{ name: ev.name || 'tool', args: ev.input || ev.args || {} }],
      });
    } else if (t === 'tool_result') {
      steps.push({
        step_index: idx++,
        source: 'MODEL',
        type: 'GENERIC',
        status: ev.is_error ? 'ERROR' : 'DONE',
        created_at: new Date().toISOString(),
        content: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content || ev.output || ''),
        error: ev.is_error ? String(ev.error || ev.content || '') : '',
      });
    } else if (t === 'result' && typeof ev.result === 'string') {
      if (!accContent) accContent = ev.result;
    }
  }
  flushModel();
  return steps;
}

export function getDefaultDocsDataDir() {
  if (process.env.AGY_PREVIEW_DATA_DIR) {
    return resolve(process.env.AGY_PREVIEW_DATA_DIR);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'agy-markdown-preview');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'agy-markdown-preview');
  }
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdgData, 'agy-markdown-preview');
}

const DEFAULT_PERSIST_PATH = join(getDefaultDocsDataDir(), 'docs-store.json');
const LEGACY_CACHE_PERSIST_PATH = join(homedir(), '.gemini', 'cache', 'agy-markdown-preview', 'docs-store.json');

export class CustomPreviewStore {
  #items = new Map(); // id -> { id, title, filePath, baseDir, mode, rawText, parsed, updatedAt, sortOrder }
  #counter = 1;
  #persistPath;
  #clipsDir;
  #lastLoadedMtimeMs = 0;

  constructor({ persistPath = DEFAULT_PERSIST_PATH } = {}) {
    this.#persistPath = persistPath;
    this.#clipsDir = persistPath ? join(dirname(persistPath), 'clips') : '';
    this.#migrateLegacyCacheIfNeeded();
    this.#loadFromDisk();
  }

  get persistPath() {
    return this.#persistPath;
  }

  #migrateLegacyCacheIfNeeded() {
    if (
      this.#persistPath === DEFAULT_PERSIST_PATH &&
      !existsSync(this.#persistPath) &&
      existsSync(LEGACY_CACHE_PERSIST_PATH)
    ) {
      try {
        mkdirSync(dirname(this.#persistPath), { recursive: true });
        writeFileSync(this.#persistPath, readFileSync(LEGACY_CACHE_PERSIST_PATH, 'utf-8'), 'utf-8');
      } catch {}
    }
  }

  #syncWithDiskIfChanged() {
    if (!this.#persistPath || !existsSync(this.#persistPath)) return;
    try {
      const st = statSync(this.#persistPath);
      if (st.mtimeMs > this.#lastLoadedMtimeMs + 1) {
        this.#loadFromDisk();
      }
    } catch {}
  }

  #loadFromDisk() {
    if (!this.#persistPath || !existsSync(this.#persistPath)) return;
    try {
      const st = statSync(this.#persistPath);
      const raw = JSON.parse(readFileSync(this.#persistPath, 'utf-8'));
      this.#items.clear();
      if (typeof raw?.counter === 'number') this.#counter = Math.max(1, raw.counter);
      if (Array.isArray(raw?.items)) {
        for (const saved of raw.items) {
          if (!saved?.id) continue;
          let rawText = saved.rawText || '';
          if (saved.clipFile && this.#clipsDir) {
            const clipPath = join(this.#clipsDir, basename(saved.clipFile));
            if (existsSync(clipPath)) {
              try { rawText = readFileSync(clipPath, 'utf-8'); } catch {}
            }
          }
          if (saved.filePath && existsSync(saved.filePath)) {
            try { rawText = readFileSync(saved.filePath, 'utf-8'); } catch {}
          }
          const parsed = parseRawInput(rawText, saved.mode || 'auto', saved.title || 'Preview');
          this.#items.set(saved.id, {
            id: saved.id,
            title: saved.title || 'Preview',
            filePath: saved.filePath || '',
            baseDir: saved.baseDir || (saved.filePath ? dirname(saved.filePath) : ''),
            mode: saved.mode || 'auto',
            rawText,
            parsed,
            updatedAt: saved.updatedAt || Date.now(),
            sortOrder: typeof saved.sortOrder === 'number' ? saved.sortOrder : 0,
          });
        }
      }
      this.#lastLoadedMtimeMs = st.mtimeMs;
    } catch {
      // Ignore corrupted store file
    }
  }

  #saveToDisk() {
    if (!this.#persistPath) return;
    try {
      mkdirSync(dirname(this.#persistPath), { recursive: true });
      if (this.#clipsDir) mkdirSync(this.#clipsDir, { recursive: true });

      const serializable = Array.from(this.#items.values()).map((it) => {
        let clipFile = '';
        // Persist inline clips (or fallback snapshot) into dedicated clips/<id>.txt so docs-store.json stays compact and lossless
        if (!it.filePath && it.rawText && this.#clipsDir) {
          clipFile = `${it.id.replace(/[^a-zA-Z0-9._-]/g, '_')}.txt`;
          try {
            writeFileSync(join(this.#clipsDir, clipFile), it.rawText, 'utf-8');
          } catch {
            clipFile = '';
          }
        }
        return {
          id: it.id,
          title: it.title,
          filePath: it.filePath,
          baseDir: it.baseDir,
          mode: it.mode,
          clipFile,
          rawText: clipFile || it.filePath ? '' : (it.rawText || ''),
          updatedAt: it.updatedAt,
          sortOrder: it.sortOrder,
        };
      });

      const jsonText = JSON.stringify(
        { version: 1, updatedAt: new Date().toISOString(), counter: this.#counter, items: serializable },
        null,
        2
      );
      const tmpPath = `${this.#persistPath}.tmp.${process.pid}`;
      try {
        writeFileSync(tmpPath, jsonText, 'utf-8');
        renameSync(tmpPath, this.#persistPath);
      } catch {
        try { rmSync(tmpPath, { force: true }); } catch {}
        writeFileSync(this.#persistPath, jsonText, 'utf-8');
      }
      try {
        this.#lastLoadedMtimeMs = statSync(this.#persistPath).mtimeMs;
      } catch {}
    } catch {
      // Ignore write error in read-only environments
    }
  }

  createOrUpdate({ id, title, filePath, droppedFilename = '', baseDir = '', extraRoots = [], mode = 'auto', content }) {
    this.#syncWithDiskIfChanged();
    let resolvedPath = '';
    let text = content;
    let displayTitle = title;

    const detectedSingleLine = !filePath ? cleanSingleLinePathCandidate(content) : '';
    let effectiveFilePath = filePath || detectedSingleLine;

    // If file was dragged & dropped without browser filePath, locate the exact file on disk!
    if (!effectiveFilePath && droppedFilename && typeof content === 'string' && content.length > 0) {
      const located = locateDroppedFileOnDisk(droppedFilename, content, extraRoots);
      if (located) {
        effectiveFilePath = located;
      }
    }

    if (effectiveFilePath) {
      resolvedPath = resolve(effectiveFilePath);
      if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${resolvedPath}`);
      }
      const st = statSync(resolvedPath);
      if (st.isDirectory()) {
        const readmeCandidate = ['README.md', 'readme.md', 'INDEX.md'].map((n) => resolve(resolvedPath, n)).find((p) => existsSync(p));
        if (!readmeCandidate) {
          throw new Error(`Directory has no README.md: ${resolvedPath}`);
        }
        resolvedPath = readmeCandidate;
      }
      text = readFileSync(resolvedPath, 'utf-8');
      if (!displayTitle) displayTitle = basename(resolvedPath);
    }

    let resolvedBaseDir = '';
    if (resolvedPath) {
      resolvedBaseDir = dirname(resolvedPath);
    } else if (baseDir && typeof baseDir === 'string' && baseDir.trim()) {
      const candidateBase = resolve(baseDir.trim().replace(/^["']|["']$/g, ''));
      if (existsSync(candidateBase)) {
        resolvedBaseDir = statSync(candidateBase).isDirectory() ? candidateBase : dirname(candidateBase);
      }
    }

    let targetId = id;
    if (!targetId && resolvedPath) {
      for (const [existingId, item] of this.#items.entries()) {
        if (item.filePath === resolvedPath) {
          targetId = existingId;
          break;
        }
      }
    }

    const existingEntry = targetId ? this.#items.get(targetId) : null;
    if (!targetId) {
      targetId = `doc-${this.#counter++}`;
    }

    const minOrder = this.#items.size > 0
      ? Math.min(...Array.from(this.#items.values()).map((x) => x.sortOrder ?? 0))
      : 1;

    const finalTitle = displayTitle || existingEntry?.title || (resolvedPath ? basename(resolvedPath) : `Clip #${this.#counter}`);
    const parsed = parseRawInput(text || '', mode, finalTitle);
    const entry = {
      id: targetId,
      title: finalTitle,
      filePath: resolvedPath,
      baseDir: resolvedBaseDir,
      mode,
      rawText: text || '',
      parsed,
      updatedAt: Date.now(),
      sortOrder: existingEntry ? existingEntry.sortOrder : minOrder - 1,
    };
    this.#items.set(targetId, entry);
    this.#saveToDisk();
    return entry;
  }

  updateMeta(id, { title, baseDir } = {}) {
    this.#syncWithDiskIfChanged();
    const existing = this.#items.get(id);
    if (!existing) return null;
    if (typeof title === 'string' && title.trim()) {
      existing.title = title.trim();
      if (existing.parsed) existing.parsed.title = existing.title;
    }
    if (typeof baseDir === 'string') {
      const trimmed = baseDir.trim().replace(/^["']|["']$/g, '');
      if (!trimmed) {
        existing.baseDir = '';
      } else {
        const candidate = resolve(trimmed);
        if (existsSync(candidate)) {
          existing.baseDir = statSync(candidate).isDirectory() ? candidate : dirname(candidate);
        }
      }
    }
    this.#items.set(id, existing);
    this.#saveToDisk();
    return existing;
  }

  delete(id) {
    this.#syncWithDiskIfChanged();
    const deleted = this.#items.delete(id);
    if (deleted) {
      if (this.#clipsDir) {
        const clipPath = join(this.#clipsDir, `${String(id).replace(/[^a-zA-Z0-9._-]/g, '_')}.txt`);
        try { rmSync(clipPath, { force: true }); } catch {}
      }
      this.#saveToDisk();
    }
    return deleted;
  }

  reorder(orderedIds) {
    this.#syncWithDiskIfChanged();
    if (!Array.isArray(orderedIds)) return;
    let rank = 0;
    for (const id of orderedIds) {
      const item = this.#items.get(id);
      if (item) {
        item.sortOrder = rank++;
      }
    }
    for (const item of this.#items.values()) {
      if (!orderedIds.includes(item.id)) {
        item.sortOrder = rank++;
      }
    }
    this.#saveToDisk();
  }

  refreshFromFile(id) {
    this.#syncWithDiskIfChanged();
    const existing = this.#items.get(id);
    if (!existing || !existing.filePath || !existsSync(existing.filePath)) return null;
    try {
      const st = statSync(existing.filePath);
      if (st.mtimeMs <= existing.updatedAt) return existing;
      const text = readFileSync(existing.filePath, 'utf-8');
      const parsed = parseRawInput(text, existing.mode, existing.title);
      const updated = {
        ...existing,
        rawText: text,
        parsed,
        updatedAt: st.mtimeMs,
      };
      this.#items.set(id, updated);
      return updated;
    } catch {
      return existing;
    }
  }

  get(id) {
    this.#syncWithDiskIfChanged();
    return this.#items.get(id) || null;
  }

  list() {
    this.#syncWithDiskIfChanged();
    return Array.from(this.#items.values())
      .sort((a, b) => {
        const oa = a.sortOrder ?? 0;
        const ob = b.sortOrder ?? 0;
        if (oa !== ob) return oa - ob;
        return b.updatedAt - a.updatedAt;
      })
      .map(({ id, title, filePath, baseDir, mode, updatedAt, sortOrder, rawText, parsed }) => ({
        id,
        title,
        filePath,
        baseDir,
        mode: parsed?.mode || mode,
        updatedAt,
        sortOrder: sortOrder ?? 0,
        excerpt: (parsed?.markdown || rawText || '').slice(0, 1400),
      }));
  }
}
