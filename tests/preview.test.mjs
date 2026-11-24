import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet, request as httpRequest } from 'node:http';
import {
  TranscriptReader,
  buildNormalizedView,
  normalizeToolArgs,
  unquoteToolArg,
} from '../server/transcript.mjs';
import {
  CustomPreviewStore,
  locateDroppedFileOnDisk,
  migrateLegacyDataDirIfNeeded,
  parseRawInput,
  stripAnsi,
} from '../server/custom-preview.mjs';
import { resolveSafeFilePath, startStandaloneServer } from '../server/app.mjs';
import { classifyHref, isCodeFilePath, isPreviewableFilePath } from '../public/js/markdown.js';

test('unquoteToolArg and normalizeToolArgs handle JSON-quoted and plain strings', () => {
  assert.equal(unquoteToolArg('"C:\\\\Users\\\\foo.txt"'), 'C:\\Users\\foo.txt');
  assert.equal(unquoteToolArg('plain-text'), 'plain-text');
  const norm = normalizeToolArgs({ Path: '"src/app.js"', WaitMsBeforeAsync: 5000 });
  assert.equal(norm.Path, 'src/app.js');
  assert.equal(norm.WaitMsBeforeAsync, 5000);
});

test('buildNormalizedView marks intermediate vs final markdown and extracts targetFile + diffs', () => {
  const view = buildNormalizedView([
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T10:00:00Z',
      content: '<USER_REQUEST>\nFix @[train.py]\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n@[train.py] is a [File]:\nE:\\proj\\train.py\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T10:00:01Z',
      thinking: 'Inspecting train.py first.',
      content: 'Checking train.py before editing...',
      tool_calls: [
        {
          name: 'edit_file',
          args: { Path: '"E:\\\\proj\\\\train.py"', Target: '"oldLine()"', Replacement: '"newLine()"' },
        },
      ],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-24T10:00:02Z',
      content: 'Created At: 2026-11-24T10:00:01Z\nCompleted At: 2026-11-24T10:00:03Z\nMade 1 replacement.',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T10:00:04Z',
      thinking: 'All checks passed.',
      content: 'Updated `train.py` cleanly.',
    },
  ]);

  assert.equal(view.turns.length, 1);
  const turn = view.turns[0];
  assert.equal(turn.user.request, 'Fix @[train.py]');
  assert.equal(turn.user.metadataBlocks.length, 1);

  const mdItems = turn.items.filter((i) => i.kind === 'markdown');
  assert.equal(mdItems.length, 2);
  assert.equal(mdItems[0].intermediate, true);
  assert.equal(mdItems[1].intermediate, false);

  const tg = turn.items.find((i) => i.kind === 'tool_group');
  assert.equal(tg.tools[0].targetFile, 'E:\\proj\\train.py');
  assert.equal(tg.tools[0].diff.before, 'oldLine()');
  assert.equal(tg.tools[0].durationMs, 2000);
  assert.equal(turn.stats.durationMs, 2000);
});

test('classifyHref and isCodeFilePath identify relative docs, Python files, conversation://, anchors, and external links', () => {
  assert.equal(classifyHref('#install').kind, 'anchor');
  assert.equal(classifyHref('https://example.com/a').kind, 'external');
  assert.equal(classifyHref('javascript:alert(1)').kind, 'unsafe');

  const convLink = classifyHref('conversation://fc6930db-d01d-441e-896b-9a9f0f7405f3');
  assert.equal(convLink.kind, 'conversation');
  assert.equal(convLink.convId, 'fc6930db-d01d-441e-896b-9a9f0f7405f3');

  const relDoc = classifyHref('isaacgymenvs/README.md');
  assert.equal(relDoc.kind, 'local');
  assert.equal(relDoc.isCode, false);
  assert.equal(relDoc.isPreviewable, true);
  assert.equal(isPreviewableFilePath('assets/diagram.png'), true);
  assert.equal(isPreviewableFilePath('isaacgymenvs'), true);
  assert.equal(isPreviewableFilePath('weights/model.pt'), false);
  assert.equal(isPreviewableFilePath('archive/bundle.zip'), false);

  const pyFile = classifyHref('isaacgymenvs/train.py#L10-L25');
  assert.equal(pyFile.kind, 'local');
  assert.equal(pyFile.isCode, true);
  assert.equal(isCodeFilePath('E:\\Projects\\demo\\model.py'), true);
});

test('buildNormalizedView extracts subagentId and computes /context + /usage telemetry', () => {
  const subUuid = '12345678-aaaa-bbbb-cccc-1234567890ab';
  const view = buildNormalizedView([
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Delegate research' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-carbon-high',
      input_tokens: 4000,
      cache_read_tokens: 96000,
      output_tokens: 1500,
      tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Explorer', Prompt: 'Scan repo' } }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: `Created At: 2026-11-24T10:00:00Z\nCompleted At: 2026-11-24T10:00:01Z\n{"conversationId":"${subUuid}"}`,
    },
  ]);
  const tg = view.turns[0].items.find((i) => i.kind === 'tool_group');
  assert.equal(tg.tools[0].subagentId, subUuid);
  assert.equal(view.summary.contextWindow.model, 'gemini-4-carbon-high');
  assert.equal(view.summary.contextWindow.used, 101500);
  assert.equal(view.summary.modelBreakdown[0].calls, 1);
  assert.equal(view.summary.modelBreakdown[0].totalTokens, 101500);
});

test('resolveSafeFilePath, locateDroppedFileOnDisk, and CustomPreviewStore resolve dropped files, relative links, bare files, and manage docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'amp-rel-'));
  try {
    mkdirSync(join(root, 'isaacgymenvs', 'pce'), { recursive: true });
    const readmeText = '# HUAWEI Precision\n[Sub](isaacgymenvs/README.md)\n[Contracts](pce_contracts.py#L10-L20)\n![pic](isaacgymenvs/pic.svg)';
    writeFileSync(join(root, 'README.md'), readmeText);
    writeFileSync(join(root, 'isaacgymenvs', 'README.md'), '# Sub README');
    writeFileSync(join(root, 'isaacgymenvs', 'train.py'), 'print("ok")\n');
    writeFileSync(join(root, 'isaacgymenvs', 'pce', 'pce_contracts.py'), 'class Contract:\n    pass\n');
    writeFileSync(join(root, 'isaacgymenvs', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    // 1. Single-line pasted path auto-loads file and sets baseDir
    const store = new CustomPreviewStore({ persistPath: '' });
    const doc = store.createOrUpdate({ content: `"${join(root, 'README.md')}"` });
    assert.equal(doc.filePath, join(root, 'README.md'));
    assert.equal(doc.baseDir, root);

    // 2. Dragged file without browser filePath resolves true source folder on disk!
    const storeDrop = new CustomPreviewStore({ persistPath: '' });
    const dropped = storeDrop.createOrUpdate({
      title: 'README.md',
      droppedFilename: 'README.md',
      content: readmeText,
      extraRoots: [root],
    });
    assert.equal(locateDroppedFileOnDisk('README.md', readmeText, [root]), join(root, 'README.md'));
    assert.equal(dropped.filePath, join(root, 'README.md'));
    assert.equal(dropped.baseDir, root);

    // 3. Relative link + line anchor resolution
    const resolvedSub = resolveSafeFilePath('isaacgymenvs/train.py#L1-L5', dropped.baseDir);
    assert.equal(resolvedSub.status, 200);
    assert.equal(resolvedSub.resolvedPath, join(root, 'isaacgymenvs', 'train.py'));
    assert.equal(resolvedSub.hashPart, 'L1-L5');

    // 4. Bare filename inside nested project subdirectory (e.g. `pce_contracts.py#L10-L20`)
    const resolvedBare = resolveSafeFilePath('pce_contracts.py#L10-L20', dropped.baseDir);
    assert.equal(resolvedBare.status, 200);
    assert.equal(resolvedBare.resolvedPath, join(root, 'isaacgymenvs', 'pce', 'pce_contracts.py'));
    assert.equal(resolvedBare.hashPart, 'L10-L20');

    // 5. Directory link resolves to README.md inside directory
    const resolvedDir = resolveSafeFilePath('isaacgymenvs', dropped.baseDir);
    assert.equal(resolvedDir.status, 200);
    assert.equal(resolvedDir.resolvedPath, join(root, 'isaacgymenvs', 'README.md'));

    // 6. Docs/Clips management & disk persistence across restarts: excerpt, rename, reorder, delete
    const persistFile = join(root, 'store-data', 'docs-store.json');
    const persistedStore1 = new CustomPreviewStore({ persistPath: persistFile });
    const pDoc1 = persistedStore1.createOrUpdate({ filePath: join(root, 'README.md') });
    const pClip2 = persistedStore1.createOrUpdate({ title: 'Inline Clip', content: '# Saved Inline\nPersists across restarts!' });
    persistedStore1.reorder([pDoc1.id, pClip2.id]);
    persistedStore1.updateMeta(pClip2.id, { title: 'Renamed Inline Clip' });

    // Reload in a brand-new store instance pointing to the same persistPath
    const persistedStore2 = new CustomPreviewStore({ persistPath: persistFile });
    const reloadedList = persistedStore2.list();
    assert.deepEqual(reloadedList.map((x) => x.id), [pDoc1.id, pClip2.id]);
    assert.equal(persistedStore2.get(pClip2.id).title, 'Renamed Inline Clip');
    assert.match(persistedStore2.get(pClip2.id).rawText, /Persists across restarts!/);
    assert.equal(persistedStore2.delete(pClip2.id), true);
    assert.equal(new CustomPreviewStore({ persistPath: persistFile }).list().length, 1);

    // 7. Blocked system path rejected
    const blocked = resolveSafeFilePath('C:\\Windows\\System32\\drivers\\etc\\hosts');
    assert.equal(blocked.status, 403);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TranscriptReader reads incrementally when JSONL grows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amp-test-'));
  const file = join(dir, 'transcript_full.jsonl');
  try {
    writeFileSync(
      file,
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Hi' }) + '\n'
    );
    const reader = new TranscriptReader();
    const first = reader.read(file);
    assert.equal(first.rawSteps.length, 1);

    appendFileSync(
      file,
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Hello!' }) + '\n'
    );
    const second = reader.read(file);
    assert.equal(second.rawSteps.length, 2);
    assert.equal(second.view.turns[0].items[0].text, 'Hello!');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseRawInput strips ANSI and parses stream-json NDJSON cleanly', () => {
  assert.equal(stripAnsi('\x1b[32mOK\x1b[0m done'), 'OK done');

  const ndjson = [
    JSON.stringify({ type: 'user', content: 'Explain X' }),
    JSON.stringify({ type: 'thinking', thinking: 'Step 1...' }),
    JSON.stringify({ type: 'tool_use', name: 'read_file', input: { Path: 'a.md' } }),
    JSON.stringify({ type: 'tool_result', content: 'hello world' }),
    JSON.stringify({ type: 'text', text: '# Heading\n\nAnswer' }),
  ].join('\n');

  const parsed = parseRawInput(ndjson, 'auto', 'Stream Test');
  assert.equal(parsed.mode, 'transcript');
  assert.equal(parsed.view.turns.length, 1);
});

test('Standalone server serves file-info, raw-file images, SSE hook stream, and blocks restricted paths', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'amp-srv-'));
  writeFileSync(join(tmp, 'demo.py'), 'x = 1\ny = 2\n');
  writeFileSync(join(tmp, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');

  const { server, port, engine } = await startStandaloneServer({ port: 0, storePersistPath: join(tmp, 'docs-store.json') });
  try {
    // Test Docs/Clips HTTP management routes (POST, PATCH, reorder, DELETE)
    const createRes = await fetch(`http://127.0.0.1:${port}/api/previews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Doc 1', content: '# Hello Doc 1' }),
    });
    assert.equal(createRes.status, 200);
    const createdDoc = await createRes.json();

    const patchRes = await fetch(`http://127.0.0.1:${port}/api/previews/${createdDoc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Doc 1 Updated', baseDir: tmp }),
    });
    assert.equal(patchRes.status, 200);
    const patchedDoc = await patchRes.json();
    assert.equal(patchedDoc.title, 'Doc 1 Updated');
    assert.equal(patchedDoc.baseDir, tmp);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/previews`);
    const listData = await listRes.json();
    assert.equal(listData.previews.length, 1);
    assert.match(listData.previews[0].excerpt, /Hello Doc 1/);

    const delRes = await fetch(`http://127.0.0.1:${port}/api/previews/${createdDoc.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);

    // Test reveal-in-folder (dryRun) + security check + /btw notes API
    const revOk = await fetch(`http://127.0.0.1:${port}/api/reveal-in-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'demo.py', base: tmp, dryRun: true }),
    });
    assert.equal(revOk.status, 200);
    const revData = await revOk.json();
    assert.equal(revData.folder, tmp);

    const revBlocked = await fetch(`http://127.0.0.1:${port}/api/reveal-in-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', dryRun: true }),
    });
    assert.equal(revBlocked.status, 403);

    const btwRes = await fetch(`http://127.0.0.1:${port}/api/conversations/test-conv/btw-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Where is retry?', answer: 'In `client.ts` line 42.' }),
    });
    assert.equal(btwRes.status, 200);
    const btwData = await btwRes.json();
    assert.equal(btwData.notes.length, 1);
    const fiRes = await fetch(`http://127.0.0.1:${port}/api/file-info?path=${encodeURIComponent('demo.py#L2')}&base=${encodeURIComponent(tmp)}`);
    assert.equal(fiRes.status, 200);
    const fi = await fiRes.json();
    assert.equal(fi.kind, 'code');
    assert.equal(fi.lang, 'python');
    assert.equal(fi.hash, 'L2');
    assert.match(fi.content, /x = 1/);

    const imgRes = await fetch(`http://127.0.0.1:${port}/api/raw-file?path=icon.svg&base=${encodeURIComponent(tmp)}`);
    assert.equal(imgRes.status, 200);
    assert.match(imgRes.headers.get('content-type') || '', /image\/svg\+xml/);

    const unsafeRes = await fetch(`http://127.0.0.1:${port}/api/file-info?path=C:\\Windows\\System32\\drivers\\etc\\hosts`);
    assert.equal(unsafeRes.status, 403);

    await new Promise((resolveSse, rejectSse) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectSse(new Error('SSE hook event timeout'));
        }
      }, 3000);
      const sseReq = httpGet(`http://127.0.0.1:${port}/api/events?conv=test-conv`, (res) => {
        let buf = '';
        res.on('error', () => {});
        res.on('data', (chunk) => {
          if (settled) return;
          buf += chunk.toString('utf-8');
          if (buf.includes('event: connected') && !buf.includes('__hook_sent__')) {
            buf += '__hook_sent__';
            const postReq = httpRequest(
              {
                hostname: '127.0.0.1',
                port,
                path: '/api/hook-event',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
              },
              (pr) => pr.resume()
            );
            postReq.on('error', () => {});
            postReq.end(JSON.stringify({ conversationId: 'test-conv', hookEventName: 'PreInvocation' }));
          }
          if (buf.includes('event: hook') && buf.includes('"phase":"thinking"')) {
            settled = true;
            clearTimeout(timer);
            res.destroy();
            sseReq.destroy();
            resolveSse();
          }
        });
      });
      sseReq.on('error', (e) => {
        if (!settled && e.code !== 'ECONNRESET') {
          settled = true;
          clearTimeout(timer);
          rejectSse(e);
        }
      });
    });
  } finally {
    engine.close();
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrateLegacyDataDirIfNeeded copies legacy agy-markdown-preview docs, clips, and btw-notes non-destructively', () => {
  const root = mkdtempSync(join(tmpdir(), 'amp-mig-'));
  try {
    const legacyDir = join(root, 'agy-markdown-preview');
    const targetDir = join(root, 'agy-session-preview');
    mkdirSync(join(legacyDir, 'clips'), { recursive: true });
    writeFileSync(join(legacyDir, 'docs-store.json'), JSON.stringify({ counter: 2, items: [{ id: 'doc-1', title: 'Old' }] }));
    writeFileSync(join(legacyDir, 'clips', 'doc-1.txt'), '# Migrated Clip');
    writeFileSync(join(legacyDir, 'btw-notes.json'), JSON.stringify({ c1: [{ id: 'btw-1', question: 'Q', answer: 'A' }] }));

    assert.equal(migrateLegacyDataDirIfNeeded(targetDir, legacyDir), true);
    assert.equal(existsSync(join(targetDir, 'docs-store.json')), true);
    assert.equal(readFileSync(join(targetDir, 'clips', 'doc-1.txt'), 'utf-8'), '# Migrated Clip');
    assert.match(readFileSync(join(targetDir, 'btw-notes.json'), 'utf-8'), /btw-1/);

    // Subsequent run must not overwrite newer files in targetDir
    writeFileSync(join(targetDir, 'btw-notes.json'), JSON.stringify({ c1: [{ id: 'btw-2', question: 'New', answer: 'B' }] }));
    assert.equal(migrateLegacyDataDirIfNeeded(targetDir, legacyDir), false);
    assert.match(readFileSync(join(targetDir, 'btw-notes.json'), 'utf-8'), /btw-2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
