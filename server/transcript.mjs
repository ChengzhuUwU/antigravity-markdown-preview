import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ALLOWED_FLAVORS = ['antigravity-cli', 'antigravity', 'antigravity-ide', 'jetski'];
const SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;
const INLINE_TOOL_OUTPUT_LIMIT = 4096;

export function getGeminiRoot() {
  return join(homedir(), '.gemini');
}

export function getBrainRoot(flavor = 'antigravity-cli') {
  const safeFlavor = ALLOWED_FLAVORS.includes(flavor) ? flavor : 'antigravity-cli';
  return join(getGeminiRoot(), safeFlavor, 'brain');
}

export function detectFlavors() {
  const root = getGeminiRoot();
  const found = [];
  for (const flavor of ALLOWED_FLAVORS) {
    const dir = join(root, flavor);
    if (existsSync(join(dir, 'brain')) || existsSync(join(dir, 'conversation_summaries.db'))) {
      found.push(flavor);
    }
  }
  return found.length > 0 ? found : ['antigravity-cli'];
}

export function resolveConversationDir(convId, flavorHint) {
  if (!convId || typeof convId !== 'string' || !SAFE_ID_RE.test(convId)) {
    return null;
  }
  const order = flavorHint && ALLOWED_FLAVORS.includes(flavorHint)
    ? [flavorHint, ...ALLOWED_FLAVORS.filter((f) => f !== flavorHint)]
    : ALLOWED_FLAVORS;

  for (const flavor of order) {
    const brainRoot = getBrainRoot(flavor);
    const candidate = resolve(brainRoot, convId);
    if (candidate.startsWith(resolve(brainRoot)) && existsSync(candidate)) {
      return { dir: candidate, flavor };
    }
  }
  return null;
}

export function resolveTranscriptPath(convDir) {
  if (!convDir) return null;
  const full = join(convDir, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (existsSync(full)) return full;
  const regular = join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (existsSync(regular)) return regular;
  return null;
}

const PLACEHOLDER_PROJECT_IDS = new Set(['default-cli-project', 'outside-of-project']);

function normalizeFolderKey(p) {
  if (!p || typeof p !== 'string') return '';
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function loadProjectMetadata() {
  const namesById = new Map();
  const namesByFolder = new Map();
  const projectsDir = join(getGeminiRoot(), 'config', 'projects');
  if (!existsSync(projectsDir)) return { namesById, namesByFolder };

  try {
    for (const entry of readdirSync(projectsDir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(projectsDir, entry), 'utf-8'));
        const id = typeof data?.id === 'string' ? data.id : '';
        const name = typeof data?.name === 'string' ? data.name.trim() : '';
        if (id && name && !PLACEHOLDER_PROJECT_IDS.has(id)) {
          namesById.set(id, name);
        }
        const resources = data?.projectResources?.resources;
        if (Array.isArray(resources)) {
          for (const r of resources) {
            const uri = r?.folderUri || r?.gitFolder?.folderUri;
            if (typeof uri === 'string' && name && !PLACEHOLDER_PROJECT_IDS.has(id)) {
              const folderKey = normalizeFolderKey(decodeUriPath(uri));
              if (folderKey) namesByFolder.set(folderKey, name);
            }
          }
        }
      } catch {
        // Ignore malformed project JSON
      }
    }
  } catch {
    // Ignore inaccessible directory
  }
  return { namesById, namesByFolder };
}

function decodeUriPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (uri.startsWith('file:///')) {
    try {
      const url = new URL(uri);
      let p = decodeURIComponent(url.pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
        p = p.slice(1);
      }
      return p;
    } catch {
      return uri.replace(/^file:\/\//, '');
    }
  }
  return uri;
}

function parseWorkspaceUri(rawJson) {
  if (!rawJson || rawJson === '[]') return '';
  try {
    const arr = JSON.parse(rawJson);
    if (Array.isArray(arr) && arr.length > 0) {
      return decodeUriPath(arr[0]);
    }
  } catch {
    return decodeUriPath(rawJson);
  }
  return '';
}

function parseTimestampMs(ts) {
  if (!ts || typeof ts !== 'string') return 0;
  const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function cleanSnippet(raw, maxLen = 84) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw
    .replace(/<USER_REQUEST>\s*/gi, '')
    .replace(/<\/USER_REQUEST>[\s\S]*/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen)}…`;
  }
  return text;
}

function extractFallbackSummary(convDir, id) {
  const shortTitlePath = join(convDir, '.system_generated', 'logs', 'short_title.txt');
  if (existsSync(shortTitlePath)) {
    try {
      const text = readFileSync(shortTitlePath, 'utf-8').trim();
      if (text) return text;
    } catch {
      // Ignore
    }
  }
  const transcriptPath = resolveTranscriptPath(convDir);
  if (transcriptPath) {
    let fd;
    try {
      fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(16384);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString('utf-8', 0, bytesRead);
      for (const line of head.split(/\r?\n/)) {
        if (!line.includes('"USER_INPUT"')) continue;
        const obj = JSON.parse(line);
        if (obj?.type === 'USER_INPUT' && obj?.content) {
          const cleaned = cleanSnippet(obj.content);
          if (cleaned) return cleaned;
        }
      }
    } catch {
      // Ignore
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
  }
  return `Conversation ${id.slice(0, 8)}`;
}

export function listConversations(flavor = 'antigravity-cli', limit = 1000) {
  const safeFlavor = ALLOWED_FLAVORS.includes(flavor) ? flavor : 'antigravity-cli';
  const brainRoot = getBrainRoot(safeFlavor);
  const dbPath = join(getGeminiRoot(), safeFlavor, 'conversation_summaries.db');
  const projects = loadProjectMetadata();
  const seen = new Set();
  const items = [];

  if (existsSync(dbPath)) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });

      // Load user_body search index from conversations_fts so sidebar search matches all user inputs
      const userBodyByConv = new Map();
      try {
        const ftsRows = db.prepare(`
          SELECT conversation_id, substr(GROUP_CONCAT(user_body, '\n'), 1, 4000) AS all_user_text
          FROM conversations_fts
          GROUP BY conversation_id
        `).all();
        for (const fr of ftsRows) {
          if (fr.conversation_id && fr.all_user_text) {
            userBodyByConv.set(fr.conversation_id, String(fr.all_user_text));
          }
        }
      } catch {
        // Ignore if FTS table is absent on older DB versions
      }

      const rows = db.prepare(`
        SELECT conversation_id, title, preview, step_count, last_modified_time,
               last_user_input_time, status, workspace_uris, parent_conversation_id,
               nesting_depth, agent_name, project_id, not_fully_idle
        FROM conversation_summaries
        ORDER BY last_modified_time DESC
        LIMIT ?
      `).all(Math.max(limit, 2000));

      for (const r of rows) {
        const id = r.conversation_id;
        if (!id) continue;
        const convDir = join(brainRoot, id);
        if (!existsSync(convDir)) continue;
        const tPath = resolveTranscriptPath(convDir);
        if (!tPath) continue;

        seen.add(id);
        let updatedAt = parseTimestampMs(r.last_modified_time) || parseTimestampMs(r.last_user_input_time);
        if (!updatedAt) {
          try {
            updatedAt = statSync(tPath).mtimeMs;
          } catch {
            updatedAt = 0;
          }
        }
        const workspaceUri = parseWorkspaceUri(r.workspace_uris);
        const folderKey = normalizeFolderKey(workspaceUri);
        const parentId = (r.parent_conversation_id || '').trim();
        const isSubagent = Boolean(parentId);
        const agentName = (r.agent_name || '').trim();
        let title = (r.title || '').trim();
        if (!title) {
          const prev = cleanSnippet(r.preview || '');
          title = prev
            ? (isSubagent && agentName ? `[${agentName}] ${prev}` : prev)
            : (isSubagent && agentName ? `Subagent (${agentName})` : extractFallbackSummary(convDir, id));
        }

        let projectName = '';
        if (r.project_id && !PLACEHOLDER_PROJECT_IDS.has(r.project_id) && projects.namesById.has(r.project_id)) {
          projectName = projects.namesById.get(r.project_id);
        } else if (folderKey && projects.namesByFolder.has(folderKey)) {
          projectName = projects.namesByFolder.get(folderKey);
        } else if (workspaceUri) {
          const cleanedWs = workspaceUri.replace(/[\\/]+$/, '');
          projectName = basename(cleanedWs) || cleanedWs;
        }

        items.push({
          id,
          flavor: safeFlavor,
          title,
          preview: cleanSnippet(r.preview || '', 160),
          userSearchText: userBodyByConv.get(id) || cleanSnippet(r.preview || '', 500),
          stepCount: Number(r.step_count || 0),
          updatedAt,
          status: r.status || '',
          active: Boolean(r.not_fully_idle) || r.status === 'CASCADE_RUN_STATUS_RUNNING',
          workspaceUri,
          parentConversationId: parentId,
          nestingDepth: Number(r.nesting_depth || 0),
          agentName,
          isSubagent,
          projectId: r.project_id || '',
          projectName,
        });
      }
    } catch {
      // Fallback to filesystem scan below if DB is temporarily locked
    } finally {
      if (db) {
        try { db.close(); } catch {}
      }
    }
  }

  if (existsSync(brainRoot)) {
    try {
      for (const id of readdirSync(brainRoot)) {
        if (seen.has(id) || !SAFE_ID_RE.test(id)) continue;
        const convDir = join(brainRoot, id);
        const tPath = resolveTranscriptPath(convDir);
        if (!tPath) continue;
        try {
          const st = statSync(tPath);
          if (!st.isFile() || st.size === 0) continue;
          items.push({
            id,
            flavor: safeFlavor,
            title: extractFallbackSummary(convDir, id),
            preview: '',
            stepCount: 0,
            updatedAt: st.mtimeMs,
            status: '',
            active: false,
            workspaceUri: '',
            parentConversationId: '',
            nestingDepth: 0,
            agentName: '',
            isSubagent: false,
            projectId: '',
            projectName: '',
          });
        } catch {
          // Ignore unreadable dirs
        }
      }
    } catch {
      // Ignore
    }
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items.slice(0, limit);
}

/**
 * Antigravity transcripts serialize tool string arguments as JSON-quoted strings
 * in some versions (`"\"foo\""`) and plain strings in others. Unquote safely.
 */
export function unquoteToolArg(val) {
  if (typeof val !== 'string') return val;
  if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
    try {
      const parsed = JSON.parse(val);
      return typeof parsed === 'string' ? parsed : val;
    } catch {
      return val;
    }
  }
  return val;
}

export function normalizeToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = unquoteToolArg(v);
  }
  return out;
}

function shortPath(p) {
  if (!p || typeof p !== 'string') return '';
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return norm;
  return `${parts.slice(-2).join('/')}`;
}

function summarizeToolCall(name, args) {
  const lower = (name || '').toLowerCase();
  if (lower === 'run_command') {
    const summary = args.toolSummary || '';
    const cmd = args.CommandLine || args.command || '';
    return summary ? `${summary} · ${cmd.slice(0, 60)}` : cmd.slice(0, 80);
  }
  if (lower === 'read_file' || lower === 'view_file') {
    const p = args.Path || args.AbsolutePath || args.file_path || '';
    const range = args.StartLine ? `:${args.StartLine}-${args.EndLine || ''}` : '';
    return `${shortPath(p)}${range}`;
  }
  if (lower === 'edit_file' || lower === 'replace_file_content' || lower === 'multi_replace_file_content' || lower === 'write_file' || lower === 'write_to_file') {
    const p = args.Path || args.TargetFile || args.file_path || '';
    return shortPath(p);
  }
  if (lower === 'grep_search' || lower === 'find_by_name') {
    const q = args.Query || args.Pattern || '';
    const s = args.SearchPath || args.SearchDirectory || '';
    return `${q}${s ? ` in ${shortPath(s)}` : ''}`.slice(0, 80);
  }
  if (lower === 'search_web' || lower === 'read_url_content') {
    return (args.query || args.Url || '').slice(0, 80);
  }
  if (lower === 'invoke_subagent') {
    return `${args.Role || args.TypeName || 'subagent'}`;
  }
  if (lower === 'ask_question') {
    const qs = Array.isArray(args.questions) ? args.questions.length : 1;
    return `${qs} question(s)`;
  }
  const firstVal = Object.values(args).find((v) => typeof v === 'string' && v.trim());
  return firstVal ? String(firstVal).slice(0, 64) : '';
}

function parseToolContentMetadata(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    return { body: '', durationMs: null, statusText: '', errorMsg: '', spooledPath: '', taskLogPath: '' };
  }
  let text = rawContent;
  let created = '';
  let completed = '';
  let errorMsg = '';

  const metaRegex = /^(?:Created At:\s*(.*?)\r?\n)?(?:Completed At:\s*(.*?)\r?\n)?(?:Encountered error in step execution:\s*(.*?\r?\n))?/;
  const m = text.match(metaRegex);
  if (m && m[0]) {
    created = (m[1] || '').trim();
    completed = (m[2] || '').trim();
    errorMsg = (m[3] || '').trim();
    text = text.slice(m[0].length);
  }
  // Sometimes Antigravity duplicates Created At / Completed At headers twice
  const m2 = text.match(metaRegex);
  if (m2 && (m2[1] || m2[2])) {
    if (!created) created = (m2[1] || '').trim();
    if (!completed) completed = (m2[2] || '').trim();
    if (!errorMsg && m2[3]) errorMsg = m2[3].trim();
    text = text.slice(m2[0].length);
  }

  let durationMs = null;
  if (created && completed) {
    const s = Date.parse(created);
    const e = Date.parse(completed);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
      durationMs = e - s;
    }
  }

  let statusText = '';
  const statusMatch = text.match(/^\s*(The command (?:completed successfully\.|failed with exit code: \d+))/m);
  if (statusMatch) {
    statusText = statusMatch[1].trim();
    text = text.replace(statusMatch[0], '');
  }

  const spooledMatch = text.match(/(?:saved to|spooled to):\s*(?:file:\/\/\/?)?([^\s\r\n]+[/\\]\.system_generated[/\\]steps[/\\]\d+[/\\][a-zA-Z0-9_.-]+)/i);
  const taskLogMatch = text.match(/(?:Task logs are available at:|Log:)\s*(?:file:\/\/\/?)?([^\s\r\n]+[/\\]\.system_generated[/\\]tasks[/\\]task-[^\s\r\n]+\.log)/i);

  const cleanedBody = text
    .replace(/^\t{1,4}/gm, '')
    .replace(/^(?:Command exited with code \d+\.?\r?\n?)/m, (line) => {
      if (!statusText) statusText = line.trim();
      return '';
    })
    .replace(/^(?:Command output|Output|Stdout|Stderr):\s*\r?\n?/gm, '')
    .trim();

  return {
    body: cleanedBody,
    durationMs,
    statusText,
    errorMsg,
    spooledPath: spooledMatch ? spooledMatch[1] : '',
    taskLogPath: taskLogMatch ? taskLogMatch[1] : '',
  };
}

function parseUserInput(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    return { request: '', mentions: [], metadataBlocks: [] };
  }

  const mentions = [];
  const fileMap = new Map();
  const metaMatch = rawContent.match(/<ADDITIONAL_METADATA>([\s\S]*?)<\/ADDITIONAL_METADATA>/);
  if (metaMatch) {
    const mentionRegex = /@\[(.*?)\] is a \[(.*?)\]:\s*\r?\n([^\r\n]+)/g;
    let mm;
    while ((mm = mentionRegex.exec(metaMatch[1])) !== null) {
      const label = mm[1].trim();
      const kind = mm[2].trim();
      const targetPath = mm[3].trim();
      fileMap.set(label, { label, kind, path: targetPath });
      mentions.push({ label, kind, path: targetPath });
    }
  }

  let request = '';
  const metadataBlocks = [];
  const tagRegex = /<([A-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
  let lastIndex = 0;
  let match;
  let foundTags = false;

  while ((match = tagRegex.exec(rawContent)) !== null) {
    foundTags = true;
    if (match.index > lastIndex) {
      const between = rawContent.slice(lastIndex, match.index).trim();
      if (between) {
        request = request ? `${request}\n\n${between}` : between;
      }
    }
    const tagName = match[1];
    const inner = match[2].trim();
    if (tagName === 'USER_REQUEST') {
      request = request ? `${request}\n\n${inner}` : inner;
    } else if (inner) {
      metadataBlocks.push({
        label: tagName.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(' '),
        content: inner,
      });
    }
    lastIndex = tagRegex.lastIndex;
  }

  if (!foundTags) {
    request = rawContent.trim();
  } else if (lastIndex < rawContent.length) {
    const tail = rawContent.slice(lastIndex).trim();
    if (tail) {
      request = request ? `${request}\n\n${tail}` : tail;
    }
  }

  return { request, mentions, metadataBlocks };
}

function extractTargetFile(name, args) {
  const lower = (name || '').toLowerCase();
  if (['read_file', 'view_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'write_file', 'write_to_file'].includes(lower)) {
    return String(args.Path || args.AbsolutePath || args.TargetFile || args.file_path || '');
  }
  return '';
}

function extractEditDiff(name, args) {
  const lower = (name || '').toLowerCase();
  if (lower === 'edit_file') {
    if (typeof args.Target === 'string' || typeof args.Replacement === 'string') {
      return {
        path: args.Path || '',
        before: args.Target || '',
        after: args.Replacement || '',
      };
    }
  }
  if (lower === 'replace_file_content') {
    return {
      path: args.TargetFile || '',
      before: args.TargetContent || '',
      after: args.ReplacementContent || '',
    };
  }
  if (lower === 'write_file' || lower === 'write_to_file') {
    const content = args.Content ?? args.CodeContent ?? '';
    if (content) {
      return {
        path: args.Path || args.TargetFile || '',
        before: '',
        after: String(content),
        isNewFile: true,
      };
    }
  }
  return null;
}

function truncatePreview(text, limit = INLINE_TOOL_OUTPUT_LIMIT) {
  if (!text || text.length <= limit) {
    return { text: text || '', truncated: false, totalLength: (text || '').length };
  }
  return {
    text: text.slice(0, limit),
    truncated: true,
    totalLength: text.length,
  };
}

/**
 * Group flat transcript steps into structured conversational turns:
 * Each turn starts with USER_INPUT (or implicit session start) and organizes
 * interleaved thinking, paired tool calls, checkpoints, errors, and final markdown.
 */
function inferModelContextLimit(modelName = '') {
  const m = String(modelName).toLowerCase();
  if (m.includes('claude')) return 200_000;
  if (m.includes('gpt')) return 128_000;
  return 1_000_000; // Gemini 3.8 / 4 family default 1M context window
}

function classifyModelFamily(modelName = '') {
  const m = String(modelName).toLowerCase();
  if (m.includes('claude')) return 'Claude Models';
  if (m.includes('gpt')) return 'GPT Models';
  if (m.includes('gemini') || m.includes('orchestrator')) return 'Gemini Models';
  return 'Other Models';
}

export function buildNormalizedView(rawSteps) {
  const turns = [];
  let currentTurn = null;
  let pendingToolsQueue = [];
  let totalThinkingChars = 0;
  let totalToolCalls = 0;
  let totalErrors = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let activeStatus = 'idle';

  // Telemetry accumulators for /context and /usage
  const modelUsageMap = new Map(); // model -> { model, family, calls, inputTokens, cacheReadTokens, outputTokens }
  let latestModelStep = null;
  let firstPostCheckpointModelStep = null;
  let firstPostCheckpointUserChars = 0;
  let postCheckpointUserChars = 0;
  let postCheckpointAgentChars = 0;
  let postCheckpointToolChars = 0;
  let postCheckpointSystemChars = 0;
  let checkpointBufferChars = 0;
  const checkpoints = [];

  const ensureTurn = (step) => {
    if (!currentTurn) {
      currentTurn = {
        id: `turn-0`,
        index: 1,
        createdAt: step?.created_at || '',
        user: null,
        items: [],
        stats: { thinkingCount: 0, toolCount: 0, errorCount: 0, tokensIn: 0, tokensOut: 0 },
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    if (!step || typeof step !== 'object') continue;

    const stepIndex = Number.isInteger(step.step_index) ? step.step_index : i;
    const type = step.type || 'UNKNOWN';
    const source = step.source || 'UNKNOWN';
    const status = step.status || 'DONE';
    const createdAt = step.created_at || '';

    if (status === 'RUNNING') {
      activeStatus = 'running';
    }

    if (typeof step.input_tokens === 'number') totalInputTokens += step.input_tokens;
    if (typeof step.output_tokens === 'number') totalOutputTokens += step.output_tokens;
    if (typeof step.cache_read_tokens === 'number') totalCacheReadTokens += step.cache_read_tokens;

    if (step.model || typeof step.input_tokens === 'number' || typeof step.output_tokens === 'number') {
      const mName = step.model || 'unknown';
      const rec = modelUsageMap.get(mName) || {
        model: mName,
        family: classifyModelFamily(mName),
        calls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
      };
      rec.calls += 1;
      rec.inputTokens += step.input_tokens || 0;
      rec.cacheReadTokens += step.cache_read_tokens || 0;
      rec.outputTokens += step.output_tokens || 0;
      modelUsageMap.set(mName, rec);

      if ((step.input_tokens || 0) + (step.cache_read_tokens || 0) > 0) {
        latestModelStep = step;
        if (!firstPostCheckpointModelStep) {
          firstPostCheckpointModelStep = step;
          firstPostCheckpointUserChars = postCheckpointUserChars;
        }
      }
    }

    if (source === 'USER_EXPLICIT' || type === 'USER_INPUT') {
      postCheckpointUserChars += (step.content || '').length;
      pendingToolsQueue = [];
      const parsedUser = parseUserInput(step.content || '');
      currentTurn = {
        id: `turn-${stepIndex}`,
        index: turns.length + 1,
        stepIndex,
        createdAt,
        user: parsedUser,
        items: [],
        stats: { thinkingCount: 0, toolCount: 0, errorCount: 0, tokensIn: 0, tokensOut: 0 },
      };
      turns.push(currentTurn);
      continue;
    }

    const turn = ensureTurn(step);
    if (typeof step.input_tokens === 'number') turn.stats.tokensIn += step.input_tokens;
    if (typeof step.output_tokens === 'number') turn.stats.tokensOut += step.output_tokens;

    if (type === 'PLANNER_RESPONSE' || (source === 'MODEL' && type === 'MESSAGE')) {
      const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : '';
      postCheckpointAgentChars += thinking.length + (typeof step.content === 'string' ? step.content.length : 0);
      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        try { postCheckpointToolChars += JSON.stringify(step.tool_calls).length; } catch {}
      }
      if (thinking) {
        totalThinkingChars += thinking.length;
        turn.stats.thinkingCount += 1;
        turn.items.push({
          kind: 'thinking',
          id: `think-${stepIndex}`,
          stepIndex,
          createdAt,
          status,
          model: step.model || '',
          text: thinking,
          wordCount: thinking.split(/\s+/).filter(Boolean).length,
          firstLine: thinking.split(/\r?\n/)[0]?.slice(0, 120) || '',
        });
      }

      const content = typeof step.content === 'string' ? step.content.trim() : '';
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (content) {
        turn.items.push({
          kind: 'markdown',
          id: `md-${stepIndex}`,
          stepIndex,
          createdAt,
          status,
          model: step.model || '',
          text: content,
          intermediate: toolCalls.length > 0,
        });
      }

      if (toolCalls.length > 0) {
        pendingToolsQueue = [];
        const entries = toolCalls.map((tc, tcIdx) => {
          totalToolCalls += 1;
          turn.stats.toolCount += 1;
          const name = tc?.name || tc?.function?.name || 'tool';
          const args = normalizeToolArgs(tc?.args || tc?.arguments || {});
          const entry = {
            id: `tool-${stepIndex}-${tcIdx}`,
            stepIndex,
            resultStepIndex: null,
            name,
            summary: summarizeToolCall(name, args),
            targetFile: extractTargetFile(name, args),
            args,
            diff: extractEditDiff(name, args),
            createdAt,
            status: status === 'RUNNING' ? 'running' : 'pending',
            durationMs: null,
            statusText: '',
            errorMsg: '',
            outputPreview: null,
            spooledPath: '',
            taskLogPath: '',
          };
          pendingToolsQueue.push(entry);
          return entry;
        });

        turn.items.push({
          kind: 'tool_group',
          id: `tg-${stepIndex}`,
          stepIndex,
          createdAt,
          tools: entries,
        });
      }
      continue;
    }

    if (type === 'GENERIC') {
      postCheckpointToolChars += (step.content || '').length;
      const meta = parseToolContentMetadata(step.content || '');
      const hasError = status === 'ERROR' || status === 'INVALID' || Boolean(step.error) || Boolean(meta.errorMsg) || /failed with exit code/i.test(meta.statusText);
      if (hasError) {
        totalErrors += 1;
        turn.stats.errorCount += 1;
      }

      const preview = truncatePreview(meta.body);
      const subagentMatch = (step.content || '').match(/"conversationId"\s*:\s*"([0-9a-f-]{8,})"/i);
      const targetTool = pendingToolsQueue.shift();
      if (targetTool) {
        targetTool.resultStepIndex = stepIndex;
        targetTool.status = status === 'RUNNING' ? 'running' : (hasError ? 'error' : 'done');
        targetTool.durationMs = meta.durationMs;
        targetTool.statusText = meta.statusText;
        targetTool.errorMsg = step.error || meta.errorMsg || '';
        targetTool.outputPreview = preview;
        targetTool.spooledPath = meta.spooledPath;
        targetTool.taskLogPath = meta.taskLogPath;
        if (subagentMatch) {
          targetTool.subagentId = subagentMatch[1];
        }
      } else {
        // Standalone GENERIC output (e.g., after a restart or orphaned tool result)
        turn.stats.toolCount += 1;
        totalToolCalls += 1;
        turn.items.push({
          kind: 'tool_group',
          id: `tg-${stepIndex}`,
          stepIndex,
          createdAt,
          tools: [{
            id: `tool-orphan-${stepIndex}`,
            stepIndex,
            resultStepIndex: stepIndex,
            name: 'tool_output',
            summary: meta.statusText || meta.body.split(/\r?\n/)[0]?.slice(0, 72) || `Step #${stepIndex}`,
            args: {},
            diff: null,
            createdAt,
            status: status === 'RUNNING' ? 'running' : (hasError ? 'error' : 'done'),
            durationMs: meta.durationMs,
            statusText: meta.statusText,
            errorMsg: step.error || meta.errorMsg || '',
            outputPreview: preview,
            spooledPath: meta.spooledPath,
            taskLogPath: meta.taskLogPath,
          }],
        });
      }
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      totalErrors += 1;
      turn.stats.errorCount += 1;
      turn.items.push({
        kind: 'error',
        id: `err-${stepIndex}`,
        stepIndex,
        createdAt,
        text: step.error || step.content || 'Unknown error',
      });
      continue;
    }

    if (type === 'CHECKPOINT' || type === 'SYSTEM_MESSAGE') {
      const content = typeof step.content === 'string' ? step.content.trim() : '';
      if (type === 'CHECKPOINT') {
        checkpoints.push({
          stepIndex,
          createdAt,
          chars: content.length,
        });
        checkpointBufferChars = content.length;
        // Reset post-checkpoint accumulators since older turns were compacted into this checkpoint
        firstPostCheckpointModelStep = null;
        firstPostCheckpointUserChars = 0;
        postCheckpointUserChars = 0;
        postCheckpointAgentChars = 0;
        postCheckpointToolChars = 0;
        postCheckpointSystemChars = 0;
      } else {
        postCheckpointSystemChars += content.length;
      }
      if (content) {
        turn.items.push({
          kind: 'system',
          id: `sys-${stepIndex}`,
          stepIndex,
          type,
          createdAt,
          title: type === 'CHECKPOINT' ? 'Context Compaction Checkpoint' : 'System Notice',
          text: content,
        });
      }
    }
  }

  if (rawSteps.length > 0 && rawSteps[rawSteps.length - 1]?.status !== 'RUNNING') {
    activeStatus = 'idle';
  }

  // Mark any markdown item followed by further thinking or tool_group in the same turn as intermediate,
  // and compute per-turn process duration & counts for high-level process folding.
  for (const t of turns) {
    let seenProcessAfter = false;
    for (let k = t.items.length - 1; k >= 0; k--) {
      const it = t.items[k];
      if (it.kind === 'thinking' || it.kind === 'tool_group') {
        seenProcessAfter = true;
      } else if (it.kind === 'markdown' && seenProcessAfter) {
        it.intermediate = true;
      }
    }
    let durationMs = 0;
    for (const it of t.items) {
      if (it.kind === 'tool_group') {
        for (const tool of it.tools) {
          if (typeof tool.durationMs === 'number' && tool.durationMs > 0) {
            durationMs += tool.durationMs;
          }
        }
      }
    }
    t.stats.durationMs = durationMs;
  }

  // Compute /context window breakdown and /usage model table
  const activeModel = latestModelStep?.model || Array.from(modelUsageMap.keys())[0] || '';
  const contextLimit = inferModelContextLimit(activeModel);
  const latestPromptTokens = latestModelStep
    ? (latestModelStep.input_tokens || 0) + (latestModelStep.cache_read_tokens || 0)
    : 0;
  const activeContextTokens = latestPromptTokens + (latestModelStep?.output_tokens || 0);
  const cacheHitRatio = latestPromptTokens > 0
    ? (latestModelStep?.cache_read_tokens || 0) / latestPromptTokens
    : (totalInputTokens + totalCacheReadTokens > 0 ? totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens) : 0);

  const firstPromptTokens = firstPostCheckpointModelStep
    ? (firstPostCheckpointModelStep.input_tokens || 0) + (firstPostCheckpointModelStep.cache_read_tokens || 0)
    : 0;
  const estFirstUserAndCheckpointTokens = Math.round((firstPostCheckpointUserChars + checkpointBufferChars) / 3.8);
  const systemOverheadTokens = Math.max(
    0,
    Math.min(activeContextTokens, firstPromptTokens > estFirstUserAndCheckpointTokens ? firstPromptTokens - estFirstUserAndCheckpointTokens : Math.round(firstPromptTokens * 0.72))
  );
  const checkpointTokens = Math.round(checkpointBufferChars / 3.8);
  const conversationalPool = Math.max(0, activeContextTokens - systemOverheadTokens);
  const totalConvChars = Math.max(1, postCheckpointUserChars + postCheckpointAgentChars + postCheckpointToolChars + postCheckpointSystemChars);

  const userMessagesTokens = Math.round(conversationalPool * (postCheckpointUserChars / totalConvChars));
  const agentResponsesTokens = Math.round(conversationalPool * (postCheckpointAgentChars / totalConvChars));
  const systemMessagesTokens = Math.round(conversationalPool * (postCheckpointSystemChars / totalConvChars));
  const toolCallsTokens = Math.max(0, conversationalPool - userMessagesTokens - agentResponsesTokens - systemMessagesTokens);
  const freeTokens = Math.max(0, contextLimit - activeContextTokens);

  const modelBreakdown = Array.from(modelUsageMap.values())
    .map((m) => ({
      ...m,
      totalPromptTokens: m.inputTokens + m.cacheReadTokens,
      totalTokens: m.inputTokens + m.cacheReadTokens + m.outputTokens,
      cacheHitRate: m.inputTokens + m.cacheReadTokens > 0 ? m.cacheReadTokens / (m.inputTokens + m.cacheReadTokens) : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    turns,
    summary: {
      totalSteps: rawSteps.length,
      totalTurns: turns.length,
      totalThinkingChars,
      totalToolCalls,
      totalErrors,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      activeStatus,
      activeModel,
      contextWindow: {
        model: activeModel,
        limit: contextLimit,
        used: activeContextTokens,
        free: freeTokens,
        usageRatio: contextLimit > 0 ? activeContextTokens / contextLimit : 0,
        cacheHitRatio,
        latestUncachedInput: latestModelStep?.input_tokens || 0,
        latestCacheRead: latestModelStep?.cache_read_tokens || 0,
        latestOutput: latestModelStep?.output_tokens || 0,
        checkpointCount: checkpoints.length,
        checkpointBufferTokens: checkpointTokens,
        categories: {
          systemOverhead: systemOverheadTokens,
          userMessages: userMessagesTokens,
          agentResponses: agentResponsesTokens,
          toolCalls: toolCallsTokens,
          systemMessages: systemMessagesTokens,
          freeSpace: freeTokens,
        },
      },
      modelBreakdown,
    },
  };
}

/**
 * Incremental JSONL cache keyed by transcript path.
 * Uses byte-offset append reading whenever the log only grew and the tail wasn't mutating in-place.
 */
export class TranscriptReader {
  #cache = new Map(); // path -> { bytesRead, mtimeMs, partial, steps, view }

  read(transcriptPath) {
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return { rawSteps: [], view: buildNormalizedView([]), updatedAt: 0 };
    }

    const st = statSync(transcriptPath);
    const cached = this.#cache.get(transcriptPath);

    if (cached && st.size === cached.bytesRead && st.mtimeMs === cached.mtimeMs) {
      return { rawSteps: cached.steps, view: cached.view, updatedAt: st.mtimeMs };
    }

    const lastStepRunning = cached?.steps?.length > 0 && cached.steps[cached.steps.length - 1]?.status === 'RUNNING';
    let steps = cached ? cached.steps : [];
    let partial = cached ? cached.partial : '';
    let readFrom = cached ? cached.bytesRead : 0;

    // Full re-parse only if file shrank, first read, or a RUNNING tail might have updated in place
    if (!cached || st.size < cached.bytesRead || (lastStepRunning && st.size === cached.bytesRead)) {
      steps = [];
      partial = '';
      readFrom = 0;
    }

    if (st.size > readFrom) {
      let fd;
      try {
        fd = openSync(transcriptPath, 'r');
        const deltaLen = st.size - readFrom;
        const buf = Buffer.allocUnsafe(deltaLen);
        const bytesRead = readSync(fd, buf, 0, deltaLen, readFrom);
        const chunk = partial + buf.toString('utf-8', 0, bytesRead);
        const lines = chunk.split('\n');
        partial = lines.pop() ?? '';

        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (!trimmed) continue;
          try {
            steps.push(JSON.parse(trimmed));
          } catch {
            // Skip malformed line rather than failing whole transcript
          }
        }
        readFrom += bytesRead;
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); } catch {}
        }
      }
    }

    const view = buildNormalizedView(steps);
    this.#cache.set(transcriptPath, {
      bytesRead: readFrom,
      mtimeMs: st.mtimeMs,
      partial,
      steps,
      view,
    });

    if (this.#cache.size > 24) {
      const oldestKey = this.#cache.keys().next().value;
      this.#cache.delete(oldestKey);
    }

    return { rawSteps: steps, view, updatedAt: st.mtimeMs };
  }

  getStepOutput(transcriptPath, stepIndex) {
    const { rawSteps } = this.read(transcriptPath);
    const step = rawSteps.find((s, idx) => (Number.isInteger(s?.step_index) ? s.step_index : idx) === stepIndex);
    if (!step) return null;
    const meta = parseToolContentMetadata(step.content || '');
    return {
      stepIndex,
      type: step.type,
      status: step.status,
      content: meta.body || step.content || '',
      error: step.error || meta.errorMsg || '',
      spooledPath: meta.spooledPath,
      taskLogPath: meta.taskLogPath,
    };
  }
}

export function listArtifacts(convDir) {
  if (!convDir || !existsSync(convDir)) return [];
  const artifacts = [];
  try {
    for (const filename of readdirSync(convDir)) {
      if (!filename.endsWith('.md')) continue;
      const fullPath = join(convDir, filename);
      try {
        const st = statSync(fullPath);
        if (!st.isFile()) continue;
        let metadata = null;
        const meta1 = join(convDir, `${filename}.metadata.json`);
        const meta2 = join(convDir, `${filename.slice(0, -3)}.metadata.json`);
        const metaPath = existsSync(meta1) ? meta1 : (existsSync(meta2) ? meta2 : null);
        if (metaPath) {
          try { metadata = JSON.parse(readFileSync(metaPath, 'utf-8')); } catch {}
        }
        artifacts.push({
          filename,
          path: fullPath,
          size: st.size,
          updatedAt: st.mtimeMs,
          metadata,
        });
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }
  artifacts.sort((a, b) => b.updatedAt - a.updatedAt);
  return artifacts;
}

/**
 * Extract `/btw <question>` slash commands recorded in `~/.gemini/<flavor>/history.jsonl` for a conversation.
 */
export function listBtwCommands(convId, flavor = 'antigravity-cli') {
  if (!convId) return [];
  const safeFlavor = ALLOWED_FLAVORS.includes(flavor) ? flavor : 'antigravity-cli';
  const flavorRoot = join(getGeminiRoot(), safeFlavor);
  const histPath = join(flavorRoot, 'history.jsonl');
  if (!existsSync(histPath)) return [];

  const results = [];
  try {
    const raw = readFileSync(histPath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.includes(convId) || !line.includes('/btw')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.conversationId !== convId || typeof obj?.display !== 'string') continue;
        const trimmed = obj.display.trim();
        if (!trimmed.toLowerCase().startsWith('/btw')) continue;
        const question = trimmed.slice(4).trim();
        results.push({
          timestamp: obj.timestamp || 0,
          rawCommand: trimmed,
          question: question || '(Reopened last /btw card)',
          isQuery: Boolean(question),
          durationText: '',
          toolCalls: null,
          status: '',
        });
      } catch {}
    }
  } catch {}

  results.sort((a, b) => a.timestamp - b.timestamp);

  // Enrich with completion duration & tool-call count from ~/.gemini/<flavor>/log/cli-*.log when available
  const logDir = join(flavorRoot, 'log');
  if (results.some((r) => r.isQuery) && existsSync(logDir)) {
    try {
      const logFiles = readdirSync(logDir).filter((f) => f.startsWith('cli-') && f.endsWith('.log')).sort().slice(-3);
      const completions = [];
      for (const fn of logFiles) {
        const yearMatch = fn.match(/^cli-(\d{4})/);
        const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
        const txt = readFileSync(join(logDir, fn), 'utf-8');
        for (const l of txt.split(/\r?\n/)) {
          if (!l.includes('btw side question')) continue;
          const m = l.match(/^I(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2}).*?btw side question\s+([0-9a-f-]+)\s+ended after\s+([^\s]+)\s+and\s+(\d+)\s+tool calls:\s+(\w+)/i);
          if (m) {
            const endMs = new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
            completions.push({ endMs, forkId: m[6], durationText: m[7], toolCalls: Number(m[8]), status: m[9] });
          }
        }
      }
      for (const r of results) {
        if (!r.isQuery || !r.timestamp) continue;
        const hit = completions.find((c) => c.endMs >= r.timestamp - 2000 && c.endMs <= r.timestamp + 20 * 60 * 1000 && !c._used);
        if (hit) {
          hit._used = true;
          r.durationText = hit.durationText;
          r.toolCalls = hit.toolCalls;
          r.status = hit.status;
        }
      }
    } catch {}
  }

  return results;
}

const rollingUsageCache = new Map(); // flavor -> { computedAt, data }

/**
 * Compute local 5-Hour & 7-Day rolling token consumption grouped by Model Family & Model
 * across recent sessions in `~/.gemini/<flavor>/brain/` (mirrors `/usage` 5h & weekly windows).
 */
export function getRollingUsageStats(flavor = 'antigravity-cli') {
  const safeFlavor = ALLOWED_FLAVORS.includes(flavor) ? flavor : 'antigravity-cli';
  const cached = rollingUsageCache.get(safeFlavor);
  if (cached && Date.now() - cached.computedAt < 15000) {
    return cached.data;
  }

  const now = Date.now();
  const cutoff5h = now - 5 * 3600 * 1000;
  const cutoff7d = now - 7 * 24 * 3600 * 1000;
  const brainRoot = getBrainRoot(safeFlavor);

  const makeBucket = () => ({ calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, sessions: 0 });
  const win5h = { total: makeBucket(), byFamily: new Map(), byModel: new Map() };
  const win7d = { total: makeBucket(), byFamily: new Map(), byModel: new Map() };

  const addStepToWindow = (win, model, inTok, cacheTok, outTok) => {
    const tot = inTok + cacheTok + outTok;
    win.total.calls += 1;
    win.total.inputTokens += inTok;
    win.total.cacheReadTokens += cacheTok;
    win.total.outputTokens += outTok;
    win.total.totalTokens += tot;

    const fam = classifyModelFamily(model);
    const fRec = win.byFamily.get(fam) || { family: fam, ...makeBucket() };
    fRec.calls += 1;
    fRec.inputTokens += inTok;
    fRec.cacheReadTokens += cacheTok;
    fRec.outputTokens += outTok;
    fRec.totalTokens += tot;
    win.byFamily.set(fam, fRec);

    const mRec = win.byModel.get(model) || { model, family: fam, ...makeBucket() };
    mRec.calls += 1;
    mRec.inputTokens += inTok;
    mRec.cacheReadTokens += cacheTok;
    mRec.outputTokens += outTok;
    mRec.totalTokens += tot;
    win.byModel.set(model, mRec);
  };

  if (existsSync(brainRoot)) {
    try {
      for (const cid of readdirSync(brainRoot)) {
        const tPath = resolveTranscriptPath(join(brainRoot, cid));
        if (!tPath) continue;
        let st;
        try { st = statSync(tPath); } catch { continue; }
        if (st.mtimeMs < cutoff7d) continue;

        let touched5h = false;
        let touched7d = false;
        try {
          const content = readFileSync(tPath, 'utf-8');
          for (const line of content.split(/\r?\n/)) {
            if (!line.includes('input_tokens') && !line.includes('output_tokens')) continue;
            try {
              const step = JSON.parse(line);
              const stepMs = parseTimestampMs(step.created_at) || st.mtimeMs;
              if (stepMs < cutoff7d) continue;
              const model = step.model || 'unknown';
              const inTok = step.input_tokens || 0;
              const cacheTok = step.cache_read_tokens || 0;
              const outTok = step.output_tokens || 0;
              if (inTok + cacheTok + outTok === 0) continue;

              touched7d = true;
              addStepToWindow(win7d, model, inTok, cacheTok, outTok);
              if (stepMs >= cutoff5h) {
                touched5h = true;
                addStepToWindow(win5h, model, inTok, cacheTok, outTok);
              }
            } catch {}
          }
        } catch {}
        if (touched7d) win7d.total.sessions += 1;
        if (touched5h) win5h.total.sessions += 1;
      }
    } catch {}
  }

  let configuredModel = '';
  let configuredEffort = '';
  const settingsPath = join(getGeminiRoot(), safeFlavor, 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      configuredModel = s?.model || s?.defaultModel || '';
      configuredEffort = s?.effort || s?.reasoningEffort || '';
    } catch {}
  }

  const serializeWin = (w) => ({
    total: w.total,
    families: Array.from(w.byFamily.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    models: Array.from(w.byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens),
  });

  const data = {
    flavor: safeFlavor,
    configuredModel,
    configuredEffort,
    window5h: serializeWin(win5h),
    window7d: serializeWin(win7d),
    updatedAt: now,
  };
  rollingUsageCache.set(safeFlavor, { computedAt: now, data });
  return data;
}
