#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const SERVER_ENTRY = join(PLUGIN_ROOT, 'server', 'app.mjs');
const RUNTIME_DIR = join(homedir(), '.gemini', 'cache', 'agy-session-preview');
const SERVER_JSON = join(RUNTIME_DIR, 'server.json');
const LEGACY_SERVER_JSON = join(homedir(), '.gemini', 'cache', 'agy-markdown-preview', 'server.json');
const SERVER_LOG = join(RUNTIME_DIR, 'server.log');

const DEFAULT_PORT = 19420;

function printHelp() {
  console.log(`Usage: agy-preview [file] [options]

Options:
  -c, --conv <id>       Preview a specific Antigravity conversation ID
  -f, --file <path>     Preview and live-watch a Markdown / JSONL / text file
  -t, --title <title>   Custom title for file or stdin preview
  -m, --mode <mode>     Parse mode: auto | markdown | stream-json (default: auto)
  -p, --port <port>     Preferred local server port (default: 19420)
      --flavor <name>   Antigravity flavor (default: antigravity-cli)
      --stdin           Read Markdown, CLI text, or stream-json from stdin
      --open            Open or focus preview window (enabled by default)
      --no-open         Start/sync server without opening a window
      --new-window      Always open a new standalone app window
      --foreground      Keep server in foreground (used by daemon mode)
      --status          Show running background preview server status
      --stop            Stop the background preview server
  -h, --help            Show this help message`);
}

function parseArgs(argv) {
  const opts = {
    conv: process.env.ANTIGRAVITY_CONVERSATION_ID || '',
    flavor: 'antigravity-cli',
    file: '',
    title: '',
    mode: 'auto',
    open: true,
    newWindow: false,
    foreground: false,
    stop: false,
    status: false,
    stdin: false,
    help: false,
    port: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--conv' || a === '-c') opts.conv = argv[++i] || '';
    else if (a === '--flavor') opts.flavor = argv[++i] || 'antigravity-cli';
    else if (a === '--file' || a === '-f') opts.file = argv[++i] || '';
    else if (a === '--title' || a === '-t') opts.title = argv[++i] || '';
    else if (a === '--mode' || a === '-m') opts.mode = argv[++i] || 'auto';
    else if (a === '--port' || a === '-p') opts.port = Number(argv[++i]) || 0;
    else if (a === '--open') opts.open = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--new-window') opts.newWindow = true;
    else if (a === '--foreground') opts.foreground = true;
    else if (a === '--stop') opts.stop = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--stdin') opts.stdin = true;
    else if (!a.startsWith('-') && !opts.file) opts.file = a;
  }
  return opts;
}

function httpJson(port, path, method = 'GET', body = null, timeoutMs = 1500) {
  return new Promise((resolveReq, rejectReq) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        timeout: timeoutMs,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolveReq({ status: res.statusCode, data: JSON.parse(text) });
          } catch {
            resolveReq({ status: res.statusCode, data: text });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', rejectReq);
    if (payload) req.write(payload);
    req.end();
  });
}

function findPreferredOrFreePort(preferred = DEFAULT_PORT) {
  return new Promise((resolvePort, rejectPort) => {
    const tryListen = (portToTry) => {
      const srv = createNetServer();
      srv.unref();
      srv.once('error', (err) => {
        if (portToTry !== 0) {
          tryListen(0);
        } else {
          rejectPort(err);
        }
      });
      srv.listen(portToTry, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolvePort(port));
      });
    };
    tryListen(preferred);
  });
}

async function getRunningServer() {
  for (const lockFile of [SERVER_JSON, LEGACY_SERVER_JSON]) {
    if (!existsSync(lockFile)) continue;
    try {
      const info = JSON.parse(readFileSync(lockFile, 'utf-8'));
      if (!info?.port) continue;
      const res = await httpJson(info.port, '/api/health', 'GET', null, 500);
      if (res.status === 200 && res.data?.ok) {
        return { ...info, clients: res.data.clients || 0 };
      }
    } catch {
      // Stale lock file
    }
  }
  return null;
}

async function ensureServerRunning(preferredPort = 0, foreground = false) {
  const existing = await getRunningServer();
  if (existing) return { ...existing, reused: true };

  mkdirSync(RUNTIME_DIR, { recursive: true });
  const targetPort = await findPreferredOrFreePort(preferredPort || DEFAULT_PORT);

  if (foreground) {
    const { startStandaloneServer } = await import('../server/app.mjs');
    const started = await startStandaloneServer({ port: targetPort });
    const info = { pid: process.pid, port: started.port, startedAt: new Date().toISOString() };
    writeFileSync(SERVER_JSON, JSON.stringify(info, null, 2), 'utf-8');
    const cleanup = () => {
      try {
        if (existsSync(SERVER_JSON)) {
          const cur = JSON.parse(readFileSync(SERVER_JSON, 'utf-8'));
          if (cur.pid === process.pid) rmSync(SERVER_JSON, { force: true });
        }
      } catch {}
      started.engine.close();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    return { ...info, clients: 0, reused: false, inProcess: true };
  }

  const logFd = openSync(SERVER_LOG, 'a');
  const child = spawn(process.execPath, [SERVER_ENTRY, '--port', String(targetPort)], {
    cwd: PLUGIN_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await httpJson(targetPort, '/api/health', 'GET', null, 400);
      if (res.status === 200 && res.data?.ok) {
        const info = { pid: child.pid, port: targetPort, startedAt: new Date().toISOString() };
        writeFileSync(SERVER_JSON, JSON.stringify(info, null, 2), 'utf-8');
        return { ...info, clients: 0, reused: false };
      }
    } catch {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  throw new Error(`Timed out waiting for preview server on port ${targetPort}`);
}

function findAppBrowser() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return candidates.find((p) => existsSync(p)) || '';
  }
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return candidates.find((p) => existsSync(p)) || '';
  }
  return '';
}

function launchStandaloneWindow(url) {
  const browser = findAppBrowser();
  if (browser) {
    const child = spawn(browser, [`--app=${url}`, '--new-window'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { launchedWith: browser, mode: 'app-window' };
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    return { launchedWith: 'default-browser', mode: 'browser' };
  }

  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
  child.unref();
  return { launchedWith: opener, mode: 'browser' };
}

function readStdinAll() {
  return new Promise((resolveRead) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolveRead(Buffer.concat(chunks).toString('utf-8')));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.stop) {
    const running = await getRunningServer();
    if (running?.pid) {
      try { process.kill(running.pid); } catch {}
    }
    for (const lockFile of [SERVER_JSON, LEGACY_SERVER_JSON]) {
      if (existsSync(lockFile)) rmSync(lockFile, { force: true });
    }
    console.log(JSON.stringify({ stopped: true }));
    return;
  }

  if (opts.status) {
    const running = await getRunningServer();
    console.log(JSON.stringify({ running: Boolean(running), ...(running || {}) }));
    return;
  }

  const serverInfo = await ensureServerRunning(opts.port, opts.foreground);
  let targetUrl = `http://127.0.0.1:${serverInfo.port}/`;
  const focusPayload = {};

  if (opts.file) {
    const absFile = resolve(opts.file);
    const created = await httpJson(serverInfo.port, '/api/previews', 'POST', {
      filePath: absFile,
      title: opts.title,
      mode: opts.mode,
    });
    if (created.status !== 200) {
      throw new Error(created.data?.error || `Failed to load file ${absFile}`);
    }
    targetUrl += `?preview=${encodeURIComponent(created.data.id)}`;
    focusPayload.previewId = created.data.id;
  } else if (opts.stdin || (!process.stdin.isTTY && !opts.conv)) {
    const piped = await readStdinAll();
    if (piped.trim()) {
      const created = await httpJson(serverInfo.port, '/api/previews', 'POST', {
        content: piped,
        title: opts.title || 'CLI Stream Output',
        mode: opts.mode,
      });
      if (created.status !== 200) {
        throw new Error(created.data?.error || 'Failed to push stdin preview');
      }
      targetUrl += `?preview=${encodeURIComponent(created.data.id)}`;
      focusPayload.previewId = created.data.id;
    }
  } else if (opts.conv) {
    targetUrl += `?conv=${encodeURIComponent(opts.conv)}&flavor=${encodeURIComponent(opts.flavor)}`;
    focusPayload.conversationId = opts.conv;
    focusPayload.flavor = opts.flavor;
  }

  let windowResult = { mode: 'already-open' };
  if (opts.open) {
    if (!opts.newWindow && serverInfo.clients > 0 && (focusPayload.conversationId || focusPayload.previewId)) {
      await httpJson(serverInfo.port, '/api/focus', 'POST', focusPayload).catch(() => {});
      windowResult = { mode: 'focused-existing-window', clients: serverInfo.clients };
    } else if (serverInfo.reused) {
      // Ask the persistent daemon process itself to spawn the app window so short-lived CLI job teardown never kills it
      const resp = await httpJson(serverInfo.port, '/api/focus', 'POST', { openWindow: true, url: targetUrl }).catch(() => null);
      windowResult = resp?.data?.window || launchStandaloneWindow(targetUrl);
    } else {
      windowResult = launchStandaloneWindow(targetUrl);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    url: targetUrl,
    port: serverInfo.port,
    pid: serverInfo.pid,
    window: windowResult,
  }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
