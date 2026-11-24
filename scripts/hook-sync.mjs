import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SERVER_JSON = join(homedir(), '.gemini', 'cache', 'agy-session-preview', 'server.json');
const LEGACY_SERVER_JSON = join(homedir(), '.gemini', 'cache', 'agy-markdown-preview', 'server.json');

function resolveOsDataDir(folderName) {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), folderName);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', folderName);
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), folderName);
}

function getDocsDataDir() {
  if (process.env.AGY_PREVIEW_DATA_DIR) return resolve(process.env.AGY_PREVIEW_DATA_DIR);
  return resolveOsDataDir('agy-session-preview');
}

function getLegacyDocsDataDir() {
  if (process.env.AGY_PREVIEW_DATA_DIR) return '';
  return resolveOsDataDir('agy-markdown-preview');
}

function readLocalCliToken() {
  for (const dir of [getDocsDataDir(), getLegacyDocsDataDir()]) {
    if (!dir) continue;
    try {
      const authPath = join(dir, 'auth-config.json');
      if (!existsSync(authPath)) continue;
      const parsed = JSON.parse(readFileSync(authPath, 'utf-8'));
      if (typeof parsed?.cliToken === 'string' && parsed.cliToken) {
        return parsed.cliToken;
      }
    } catch {}
  }
  return '';
}

function readStdinSyncFast() {
  return new Promise((resolveRead) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolveRead(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolveRead(''));
  });
}

function expandTilde(p) {
  if (!p || typeof p !== 'string') return '';
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function readTailUtf8(filePath, maxBytes = 24576) {
  let fd;
  try {
    const st = statSync(filePath);
    if (st.size === 0) return '';
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = openSync(filePath, 'r');
    readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function tryCaptureBtwSideAnswer(payload) {
  try {
    const forkConvId = payload?.conversationId || '';
    const rawTPath = expandTilde(payload?.transcriptPath || '');
    if (!forkConvId || !rawTPath) return null;

    const fullTPath = rawTPath.replace(/transcript\.jsonl$/i, 'transcript_full.jsonl');
    const actualTPath = existsSync(fullTPath) ? fullTPath : (existsSync(rawTPath) ? rawTPath : '');
    if (!actualTPath) return null;

    const brainIdx = actualTPath.toLowerCase().indexOf(`${process.platform === 'win32' ? '\\brain\\' : '/brain/'}`);
    const flavorRoot = brainIdx !== -1
      ? actualTPath.slice(0, brainIdx)
      : join(homedir(), '.gemini', 'antigravity-cli');
    const histPath = join(flavorRoot, 'history.jsonl');
    if (!existsSync(histPath)) return null;

    const now = Date.now();
    const recentBtw = [];
    for (const line of readTailUtf8(histPath, 32768).split(/\r?\n/)) {
      if (!line.includes('/btw')) continue;
      try {
        const h = JSON.parse(line);
        if (
          h?.conversationId &&
          h.conversationId !== forkConvId &&
          typeof h.display === 'string' &&
          h.display.trim().toLowerCase().startsWith('/btw ') &&
          now - (h.timestamp || 0) < 20 * 60 * 1000
        ) {
          recentBtw.push({
            parentConvId: h.conversationId,
            question: h.display.trim().slice(4).trim(),
            timestamp: h.timestamp || now,
          });
        }
      } catch {}
    }
    if (recentBtw.length === 0) return null;

    const steps = readFileSync(actualTPath, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (steps.length === 0) return null;

    let lastUserIdx = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].type === 'USER_INPUT' || steps[i].source === 'USER_EXPLICIT') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return null;

    const userPrompt = String(steps[lastUserIdx].content || '');
    const matched = [...recentBtw].reverse().find((b) => b.question && userPrompt.includes(b.question));
    if (!matched) return null;

    let latestAnswer = '';
    let toolCallsCount = 0;
    for (let i = lastUserIdx + 1; i < steps.length; i++) {
      const st = steps[i];
      if (Array.isArray(st.tool_calls)) toolCallsCount += st.tool_calls.length;
      if ((st.type === 'PLANNER_RESPONSE' || st.type === 'MESSAGE') && typeof st.content === 'string' && st.content.trim()) {
        latestAnswer = st.content.trim();
      }
    }
    if (!latestAnswer) return null;

    const btwStorePath = join(getDocsDataDir(), 'btw-notes.json');
    mkdirSync(dirname(btwStorePath), { recursive: true });
    let allNotes = {};
    const legacyBtwPath = getLegacyDocsDataDir() ? join(getLegacyDocsDataDir(), 'btw-notes.json') : '';
    const loadPath = existsSync(btwStorePath) ? btwStorePath : (legacyBtwPath && existsSync(legacyBtwPath) ? legacyBtwPath : '');
    if (loadPath) {
      try { allNotes = JSON.parse(readFileSync(loadPath, 'utf-8')) || {}; } catch { allNotes = {}; }
    }
    const convList = Array.isArray(allNotes[matched.parentConvId]) ? allNotes[matched.parentConvId] : [];
    const existingIdx = convList.findIndex((n) => n.id === `btw-${forkConvId}` || n.question === matched.question);
    const entry = {
      id: `btw-${forkConvId}`,
      question: matched.question,
      answer: latestAnswer,
      toolCount: toolCallsCount,
      model: payload.modelName || '',
      autoCaptured: true,
      createdAt: matched.timestamp || now,
    };
    if (existingIdx >= 0) convList[existingIdx] = entry;
    else convList.push(entry);
    allNotes[matched.parentConvId] = convList;

    const tmp = `${btwStorePath}.tmp.${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(allNotes, null, 2), 'utf-8');
      renameSync(tmp, btwStorePath);
    } catch {
      try { rmSync(tmp, { force: true }); } catch {}
      writeFileSync(btwStorePath, JSON.stringify(allNotes, null, 2), 'utf-8');
    }
    return { parentConvId: matched.parentConvId, entry };
  } catch {
    return null;
  }
}

function forwardToServer(port, payloadObj, cliToken = '') {
  return new Promise((resolveReq) => {
    const payloadRaw = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payloadRaw),
    };
    if (cliToken) {
      headers['X-Preview-Cli-Token'] = cliToken;
    }
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/hook-event',
        method: 'POST',
        timeout: 250,
        headers,
      },
      (res) => {
        res.resume();
        resolveReq();
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolveReq();
    });
    req.on('error', () => resolveReq());
    req.write(payloadRaw);
    req.end();
  });
}

async function main() {
  try {
    const raw = await readStdinSyncFast();
    if (!raw.trim()) {
      process.stdout.write('{}');
      return;
    }

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const capturedBtw = parsed ? tryCaptureBtwSideAnswer(parsed) : null;

    const activeServerJson = existsSync(SERVER_JSON) ? SERVER_JSON : (existsSync(LEGACY_SERVER_JSON) ? LEGACY_SERVER_JSON : '');
    if (activeServerJson) {
      const info = JSON.parse(readFileSync(activeServerJson, 'utf-8'));
      if (info?.port) {
        const cliToken = readLocalCliToken();
        await forwardToServer(info.port, raw, cliToken);
        if (capturedBtw) {
          await forwardToServer(info.port, {
            hookEventName: 'BtwCaptured',
            conversationId: capturedBtw.parentConvId,
            btwEntry: capturedBtw.entry,
          }, cliToken);
        }
      }
    }
  } catch {
    // Hooks must fail open and never disrupt the agent loop
  }
  process.stdout.write('{}');
}

main();
