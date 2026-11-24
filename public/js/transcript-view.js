import { escapeHtml, isPreviewableFilePath, renderMarkdownHtml, enhanceMarkdownDom } from './markdown.js';

const CHEVRON_SVG = `<svg class="chevron-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg>`;

function formatCompactTokens(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms) {
  if (ms == null || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(ms < 10000 ? 1 : 0);
  return `${sec}s`;
}

function cleanTocSnippet(text, maxChars = 16) {
  if (!text || typeof text !== 'string') return '';
  const singleLine = text
    .replace(/@\[(.*?)\]/g, '$1')
    .replace(/[#>*`~_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!singleLine) return '';
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars)}…` : singleLine;
}

function computeLineDiff(before, after) {
  const oldLines = String(before ?? '').split(/\r?\n/);
  const newLines = String(after ?? '').split(/\r?\n/);
  const maxShow = 120;
  const out = [];
  for (let i = 0; i < Math.min(oldLines.length, maxShow); i++) {
    out.push({ type: 'del', text: oldLines[i] });
  }
  if (oldLines.length > maxShow) {
    out.push({ type: 'del', text: `… (${oldLines.length - maxShow} more deleted lines)` });
  }
  for (let i = 0; i < Math.min(newLines.length, maxShow); i++) {
    out.push({ type: 'add', text: newLines[i] });
  }
  if (newLines.length > maxShow) {
    out.push({ type: 'add', text: `… (${newLines.length - maxShow} more added lines)` });
  }
  return out;
}

function summarizeToolGroup(tools) {
  const counts = new Map();
  let errors = 0;
  let running = 0;
  for (const t of tools) {
    counts.set(t.name, (counts.get(t.name) || 0) + 1);
    if (t.status === 'error') errors++;
    if (t.status === 'running' || t.status === 'pending') running++;
  }
  const parts = Array.from(counts.entries())
    .slice(0, 3)
    .map(([name, cnt]) => (cnt > 1 ? `${name} ×${cnt}` : name));
  if (counts.size > 3) parts.push(`+${counts.size - 3} more`);
  return {
    label: `${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'} · ${parts.join(', ')}`,
    errors,
    running,
  };
}

function renderToolDetailHtml(tool, baseDir) {
  const parts = [];
  if (tool.diff) {
    const diffLines = computeLineDiff(tool.diff.before, tool.diff.after);
    parts.push(`<div class="tool-section-label">${tool.diff.isNewFile ? 'Write File' : 'Edit Diff'} · ${escapeHtml(tool.diff.path)}</div>`);
    parts.push(`<div class="diff-box">${diffLines.map((l) => `<div class="diff-line ${l.type}">${l.type === 'add' ? '+' : '-'} ${escapeHtml(l.text)}</div>`).join('')}</div>`);
  } else if (tool.args && Object.keys(tool.args).length > 0) {
    parts.push(`<div class="tool-section-label">Arguments</div>`);
    parts.push(`<pre class="tool-pre">${escapeHtml(JSON.stringify(tool.args, null, 2))}</pre>`);
  }

  if (tool.errorMsg) {
    parts.push(`<div class="tool-section-label" style="color:var(--error);">Error</div>`);
    parts.push(`<pre class="tool-pre" style="border-color:rgba(194,59,59,0.35);color:var(--error);">${escapeHtml(tool.errorMsg)}</pre>`);
  }

  if (tool.outputPreview && tool.outputPreview.text) {
    const truncNote = tool.outputPreview.truncated
      ? ` <span style="color:var(--text-faint);">(showing ${tool.outputPreview.text.length} / ${tool.outputPreview.totalLength} chars)</span>`
      : '';
    parts.push(`<div class="tool-section-label">Output${truncNote}</div>`);
    parts.push(`<pre class="tool-pre" data-tool-output-pre="true">${escapeHtml(tool.outputPreview.text)}</pre>`);
    if (tool.outputPreview.truncated && tool.resultStepIndex != null) {
      parts.push(`<div><button type="button" class="code-mini-btn" data-action="load-full-step" data-step="${tool.resultStepIndex}">Load full output</button></div>`);
    }
  }

  const extras = [];
  if (tool.subagentId) {
    extras.push(`<button type="button" class="open-sidebar-pill" data-open-conv="${escapeHtml(tool.subagentId)}">View Subagent</button>`);
  }
  if (tool.targetFile) {
    extras.push(`<button type="button" class="open-sidebar-pill" data-local-href="${escapeHtml(tool.targetFile)}" data-base-dir="${escapeHtml(baseDir)}" data-preview-mode="sidebar">Open in sidebar</button>`);
  }
  if (tool.spooledPath) {
    extras.push(`<button type="button" class="code-mini-btn" data-local-href="${escapeHtml(tool.spooledPath)}" data-base-dir="${escapeHtml(baseDir)}" data-preview-mode="popup">Open spooled output</button>`);
  }
  if (tool.taskLogPath) {
    extras.push(`<button type="button" class="code-mini-btn" data-local-href="${escapeHtml(tool.taskLogPath)}" data-base-dir="${escapeHtml(baseDir)}" data-preview-mode="popup">View task log</button>`);
  }
  if (extras.length > 0) {
    parts.push(`<div style="display:flex;gap:6px;flex-wrap:wrap;">${extras.join('')}</div>`);
  }

  return parts.join('') || '<div style="font-size:0.76rem;color:var(--text-faint);">No additional details recorded.</div>';
}

function buildProcessItemNode(item, { theme, baseDir, expandedState }) {
  if (item.kind === 'thinking') {
    const open = expandedState.has(item.id);
    const card = document.createElement('div');
    card.className = 'disclosure-card thinking-card';
    card.dataset.open = String(open);
    card.dataset.disclosureKey = item.id;
    const statusSuffix = item.status === 'RUNNING' ? ' · thinking…' : '';
    card.innerHTML = `
      <button type="button" class="disclosure-trigger" data-action="toggle-disclosure">
        ${CHEVON_ICON()}
        <span class="thinking-label">Thought${statusSuffix}</span>
        <span class="thinking-preview">${escapeHtml(item.firstLine || `${item.wordCount} words`)}</span>
        <span style="font-size:0.71rem;color:var(--text-faint);flex-shrink:0;">${item.wordCount}w</span>
      </button>
      <div class="thinking-body assistant-markdown">${open ? renderMarkdownHtml(item.text, { baseDir }) : ''}</div>
    `;
    card._lazyContent = () => renderMarkdownHtml(item.text, { baseDir });
    if (open) {
      const body = card.querySelector('.thinking-body');
      body.dataset.hydrated = 'true';
      enhanceMarkdownDom(body, theme);
    }
    return card;
  }

  if (item.kind === 'tool_group') {
    const groupOpen = expandedState.has(item.id);
    const summary = summarizeToolGroup(item.tools);
    const card = document.createElement('div');
    card.className = 'tool-group-card';
    card.dataset.open = String(groupOpen);
    card.dataset.disclosureKey = item.id;

    const badges = [];
    if (summary.running > 0) badges.push(`<span class="tool-status-pill running">running</span>`);
    if (summary.errors > 0) badges.push(`<span class="tool-status-pill error">${summary.errors} failed</span>`);
    if (summary.running === 0 && summary.errors === 0) badges.push(`<span class="tool-status-pill done">done</span>`);

    const rowsHtml = item.tools.map((tool) => {
      const rowOpen = expandedState.has(tool.id);
      const dur = formatDuration(tool.durationMs);
      const statusLabel = tool.status === 'error' ? 'error' : (tool.status === 'running' || tool.status === 'pending' ? 'running' : (dur || 'ok'));
      const showSidebarBtn = Boolean(tool.targetFile && isPreviewableFilePath(tool.targetFile));
      let actionBtnHtml = '';
      if (tool.subagentId) {
        actionBtnHtml = `<button type="button" class="open-sidebar-pill" data-open-conv="${escapeHtml(tool.subagentId)}" title="Preview subagent conversation">View Subagent</button>`;
      } else if (showSidebarBtn) {
        actionBtnHtml = `<button type="button" class="open-sidebar-pill" data-local-href="${escapeHtml(tool.targetFile)}" data-base-dir="${escapeHtml(baseDir)}" data-preview-mode="sidebar" title="Open ${escapeHtml(tool.targetFile)} in side panel">Open in sidebar</button>`;
      }

      return `<div class="tool-row" data-open="${rowOpen}" data-disclosure-key="${tool.id}">
        <div class="tool-row-header-wrap">
          <button type="button" class="tool-row-trigger" data-action="toggle-tool-row">
            <span class="tool-row-main">
              ${CHEVRON_SVG}
              <span class="tool-name-pill">${escapeHtml(tool.name)}</span>
              <span class="tool-target-text">${escapeHtml(tool.summary || '')}</span>
            </span>
            <span class="tool-status-pill ${tool.status}">${escapeHtml(statusLabel)}</span>
          </button>
          ${actionBtnHtml}
        </div>
        <div class="tool-row-detail">${rowOpen ? renderToolDetailHtml(tool, baseDir) : ''}</div>
      </div>`;
    }).join('');

    card.innerHTML = `
      <button type="button" class="tool-group-trigger" data-action="toggle-tool-group">
        <span class="tool-group-left">
          ${CHEVRON_SVG}
          <span class="tool-group-summary">${escapeHtml(summary.label)}</span>
        </span>
        <span class="tool-group-badges">${badges.join('')}</span>
      </button>
      <div class="tool-group-list">${rowsHtml}</div>
    `;

    card.querySelectorAll('.tool-row').forEach((rowEl, idx) => {
      const t = item.tools[idx];
      rowEl._lazyContent = () => renderToolDetailHtml(t, baseDir);
      if (expandedState.has(t.id)) {
        const d = rowEl.querySelector('.tool-row-detail');
        if (d) d.dataset.hydrated = 'true';
      }
    });

    return card;
  }

  if (item.kind === 'markdown') {
    // Intermediate progress note emitted mid-execution before final reply
    const noteEl = document.createElement('div');
    noteEl.className = 'process-intermediate-note assistant-markdown';
    noteEl.innerHTML = renderMarkdownHtml(item.text, { baseDir });
    enhanceMarkdownDom(noteEl, theme);
    return noteEl;
  }

  if (item.kind === 'error') {
    const errEl = document.createElement('div');
    errEl.className = 'notice-banner error';
    errEl.textContent = item.text;
    return errEl;
  }

  if (item.kind === 'system') {
    const open = expandedState.has(item.id);
    const card = document.createElement('div');
    card.className = 'disclosure-card thinking-card';
    card.dataset.open = String(open);
    card.dataset.disclosureKey = item.id;
    card.innerHTML = `
      <button type="button" class="disclosure-trigger" data-action="toggle-disclosure">
        ${CHEVRON_SVG}
        <span class="thinking-label">${escapeHtml(item.title)}</span>
        <span class="thinking-preview">System context</span>
      </button>
      <div class="thinking-body assistant-markdown">${open ? renderMarkdownHtml(item.text, { baseDir }) : ''}</div>
    `;
    card._lazyContent = () => renderMarkdownHtml(item.text, { baseDir });
    if (open) {
      const body = card.querySelector('.thinking-body');
      body.dataset.hydrated = 'true';
      enhanceMarkdownDom(body, theme);
    }
    return card;
  }

  return null;
}

function CHEVON_ICON() {
  return CHEVRON_SVG;
}

function summarizeProcessItems(processItems, stats, isTurnRunning) {
  const parts = [];
  const thoughts = stats?.thinkingCount || 0;
  const tools = stats?.toolCount || 0;
  const dur = formatDuration(stats?.durationMs || 0);
  if (thoughts > 0) parts.push(`${thoughts} ${thoughts === 1 ? 'thought' : 'thoughts'}`);
  if (tools > 0) parts.push(`${tools} tool ${tools === 1 ? 'call' : 'calls'}`);
  if (dur) parts.push(dur);
  if (parts.length === 0) {
    parts.push(`${processItems.length} ${processItems.length === 1 ? 'step' : 'steps'}`);
  }
  const prefix = isTurnRunning ? 'Working' : 'Execution process';
  return `${prefix} · ${parts.join(' · ')}`;
}

function buildTurnElement(turn, { theme, baseDir, expandedState, isTurnRunning }) {
  const el = document.createElement('section');
  el.className = 'turn-block';
  el.id = turn.id;
  el.dataset.turnId = turn.id;
  el.dataset.signature = `${turnSignature(turn)}:${isTurnRunning ? 'run' : 'done'}:${baseDir}`;

  const promptText = turn.user?.request || '';
  el.dataset.promptPreview = cleanTocSnippet(promptText, 18);
  el.dataset.promptFull = promptText.replace(/\s+/g, ' ').trim().slice(0, 140);

  if (turn.user) {
    // 1. Clean minimal User Input Card (metadata moved outside below!)
    const userCard = document.createElement('div');
    userCard.className = 'user-card';

    const timeStr = turn.createdAt ? new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    let mentionsHtml = '';
    if (turn.user.mentions?.length) {
      mentionsHtml = `<div class="mention-row">${turn.user.mentions.map((m) => {
        const sideBtn = isPreviewableFilePath(m.path)
          ? `<button type="button" class="open-sidebar-pill" data-local-href="${escapeHtml(m.path)}" data-base-dir="${escapeHtml(baseDir)}" data-preview-mode="sidebar" title="Open ${escapeHtml(m.path)} in side panel">Open in sidebar</button>`
          : '';
        return `<span class="code-link-group"><button type="button" class="mention-chip" data-local-href="${escapeHtml(m.path)}" data-base-dir="${escapeHtml(baseDir)}" data-preview-mode="popup" title="${escapeHtml(m.path)}">@${escapeHtml(m.label)}</button>${sideBtn}</span>`;
      }).join('')}</div>`;
    }

    userCard.innerHTML = `
      <div class="user-card-header">
        <span class="user-badge">You · Turn #${turn.index}</span>
        <span>${escapeHtml(timeStr)}</span>
      </div>
      <div class="user-prompt-text">${escapeHtml(promptText || '(empty input)')}</div>
      ${mentionsHtml}
    `;
    el.appendChild(userCard);

    // 2. Additional Metadata placed cleanly OUTSIDE and underneath the User Card
    if (turn.user.metadataBlocks?.length) {
      const metaWrap = document.createElement('div');
      metaWrap.className = 'user-meta-outside';
      const metaKey = `${turn.id}:user-meta`;
      const open = expandedState.has(metaKey);
      const labels = turn.user.metadataBlocks.map((m) => m.label).join(' · ');

      const card = document.createElement('div');
      card.className = 'disclosure-card user-meta-card';
      card.dataset.open = String(open);
      card.dataset.disclosureKey = metaKey;

      const buildMetaBody = () => turn.user.metadataBlocks.map((mb) =>
        `<div class="meta-subblock"><div class="tool-section-label">${escapeHtml(mb.label)}</div><pre class="tool-pre">${escapeHtml(mb.content)}</pre></div>`
      ).join('');

      card.innerHTML = `
        <button type="button" class="disclosure-trigger meta-trigger" data-action="toggle-disclosure">
          ${CHEVRON_SVG}
          <span class="thinking-preview">${escapeHtml(labels)}</span>
        </button>
        <div class="thinking-body">${open ? buildMetaBody() : ''}</div>
      `;
      card._lazyContent = buildMetaBody;
      if (open) card.querySelector('.thinking-body').dataset.hydrated = 'true';
      metaWrap.appendChild(card);
      el.appendChild(metaWrap);
    }
  }

  // Partition turn items into High-Level Execution Process vs Final Assistant Response
  const processItems = [];
  const finalItems = [];
  for (const item of turn.items) {
    if (item.kind === 'markdown' && !item.intermediate) {
      finalItems.push(item);
    } else {
      processItems.push(item);
    }
  }

  // 3. High-Level Collapsible Execution Process Container (collapsed by default!)
  if (processItems.length > 0) {
    const procKey = `${turn.id}:process`;
    const procOpen = expandedState.has(procKey);
    const procCard = document.createElement('div');
    procCard.className = `process-fold-card${isTurnRunning ? ' running' : ''}`;
    procCard.dataset.open = String(procOpen);
    procCard.dataset.disclosureKey = procKey;

    const procLabel = summarizeProcessItems(processItems, turn.stats, isTurnRunning);
    const errCount = turn.stats?.errorCount || 0;
    const badges = [];
    if (isTurnRunning) badges.push(`<span class="tool-status-pill running">running</span>`);
    if (errCount > 0) badges.push(`<span class="tool-status-pill error">${errCount} ${errCount === 1 ? 'error' : 'errors'}</span>`);

    procCard.innerHTML = `
      <button type="button" class="process-fold-trigger" data-action="toggle-process">
        <span class="tool-group-left">
          ${CHEVRON_SVG}
          <span class="process-fold-title">${escapeHtml(procLabel)}</span>
        </span>
        <span class="tool-group-badges">${badges.join('')}</span>
      </button>
      <div class="process-fold-body"></div>
    `;

    const bodyEl = procCard.querySelector('.process-fold-body');
    const populateProcessChildren = () => {
      bodyEl.innerHTML = '';
      for (const pItem of processItems) {
        const child = buildProcessItemNode(pItem, { theme, baseDir, expandedState });
        if (child) bodyEl.appendChild(child);
      }
      bodyEl.dataset.hydrated = 'true';
    };

    procCard._hydrateProcess = populateProcessChildren;
    if (procOpen) {
      populateProcessChildren();
    }
    el.appendChild(procCard);
  }

  // 4. Final Assistant Markdown Responses (always clean and prominently visible)
  for (const item of finalItems) {
    const mdEl = document.createElement('div');
    mdEl.className = 'assistant-markdown';
    mdEl.dataset.stepIndex = String(item.stepIndex);
    mdEl.innerHTML = renderMarkdownHtml(item.text, { baseDir });
    enhanceMarkdownDom(mdEl, theme);
    el.appendChild(mdEl);
  }

  return el;
}

function turnSignature(turn) {
  const lastItem = turn.items[turn.items.length - 1];
  const lastTextLen = lastItem?.text?.length || lastItem?.tools?.length || 0;
  return `${turn.items.length}:${turn.stats.thinkingCount}:${turn.stats.toolCount}:${turn.stats.errorCount}:${lastTextLen}:${lastItem?.status || ''}:${JSON.stringify(lastItem?.tools?.map((t) => `${t.status}:${t.durationMs}`) || [])}`;
}

function renderCliInsightsHtml(tab, view, cliInsights, artifacts, baseDir) {
  const s = view?.summary || {};
  const ctx = s.contextWindow || {};
  const cats = ctx.categories || {};

  if (tab === 'context') {
    const limit = Math.max(1, ctx.limit || 1_000_000);
    const sysCells = Math.round(((cats.systemOverhead || 0) / limit) * 100);
    const userCells = Math.round(((cats.userMessages || 0) / limit) * 100);
    const agentCells = Math.round(((cats.agentResponses || 0) / limit) * 100);
    const toolCells = Math.round(((cats.toolCalls || 0) / limit) * 100);
    const cells = [];
    const pushCells = (cls, count) => {
      for (let i = 0; i < count && cells.length < 100; i++) cells.push(`<span class="ctx-cell ${cls}"></span>`);
    };
    pushCells('sys', sysCells);
    pushCells('user', userCells);
    pushCells('agent', agentCells);
    pushCells('tool', toolCells);
    if ((ctx.used || 0) > 0 && cells.length === 0) cells.push(`<span class="ctx-cell agent"></span>`);
    while (cells.length < 100) cells.push(`<span class="ctx-cell free"></span>`);

    const pct = ((ctx.usageRatio || 0) * 100).toFixed(1);
    const cachePct = ((ctx.cacheHitRatio || 0) * 100).toFixed(1);

    const artifactsHtml = (artifacts || []).length > 0
      ? `<div style="border-top:1px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:6px;">
          <div class="tool-section-label">Tracked Artifacts (${artifacts.length})</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${artifacts.map((a) => `<span class="code-link-group"><a href="#" class="local-file-link" style="font-size:0.78rem;" data-local-href="${escapeHtml(a.path)}" data-base-dir="${escapeHtml(baseDir)}" data-preview-mode="popup">${escapeHtml(a.filename)}</a><button type="button" class="open-sidebar-pill" data-local-href="${escapeHtml(a.path)}" data-base-dir="${escapeHtml(baseDir)}" data-preview-mode="sidebar">Open in sidebar</button></span>`).join('')}
          </div>
        </div>`
      : '';

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:0.8rem;">
        <div><strong>Active Model:</strong> <code>${escapeHtml(ctx.model || 'N/A')}</code> · <strong>${formatCompactTokens(ctx.used)}</strong> / ${formatCompactTokens(ctx.limit)} tokens (${pct}%)</div>
        <div style="color:var(--text-muted);">Prompt Cache Hit: <strong>${cachePct}%</strong> (${formatCompactTokens(ctx.latestCacheRead)} cached · ${formatCompactTokens(ctx.latestUncachedInput)} new)</div>
      </div>
      <div class="context-layout">
        <div class="context-grid-wrap">
          <div class="context-grid-10x10" title="100 cells = ${formatCompactTokens(ctx.limit)} context window">${cells.join('')}</div>
          <span style="font-size:0.69rem;color:var(--text-faint);text-align:center;">1 cell ≈ ${formatCompactTokens(Math.round(limit / 100))} tokens</span>
        </div>
        <div class="context-breakdown-table">
          <div class="ctx-row"><span><span class="ctx-dot" style="background:#7b8494;"></span>⛁ System, Tools &amp; Customizations</span><strong>${formatCompactTokens(cats.systemOverhead)}</strong></div>
          <div class="ctx-row"><span><span class="ctx-dot" style="background:var(--info);"></span>◉ User messages</span><strong>${formatCompactTokens(cats.userMessages)}</strong></div>
          <div class="ctx-row"><span><span class="ctx-dot" style="background:var(--accent);"></span>◉ Agent responses &amp; thinking</span><strong>${formatCompactTokens(cats.agentResponses)}</strong></div>
          <div class="ctx-row"><span><span class="ctx-dot" style="background:var(--warning);"></span>◉ Tool calls &amp; outputs</span><strong>${formatCompactTokens(cats.toolCalls)}</strong></div>
          <div class="ctx-row"><span><span class="ctx-dot" style="border:1px solid var(--border-strong);background:var(--bg-surface);"></span>□ Free context capacity</span><strong>${formatCompactTokens(cats.freeSpace)}</strong></div>
          ${ctx.checkpointCount ? `<div class="ctx-row"><span>⊠ Checkpoints compacted (${ctx.checkpointCount})</span><strong>${formatCompactTokens(ctx.checkpointBufferTokens)} buffer</strong></div>` : ''}
        </div>
      </div>
      ${artifactsHtml}
    `;
  }

  if (tab === 'usage') {
    const gu = cliInsights?.globalUsage || {};
    const w5 = gu.window5h || { total: {}, families: [] };
    const w7 = gu.window7d || { total: {}, families: [] };
    const models = s.modelBreakdown || [];

    const renderWinCard = (label, win) => {
      const fams = (win.families || []).map((f) =>
        `<div style="display:flex;justify-content:space-between;font-size:0.75rem;"><span>${escapeHtml(f.family)} (${f.calls} calls)</span><strong>${formatCompactTokens(f.totalTokens)}</strong></div>`
      ).join('') || `<div style="font-size:0.75rem;color:var(--text-faint);">No recorded token activity in window</div>`;
      return `<div class="usage-window-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="tool-section-label">${escapeHtml(label)}</span>
          <span style="font-size:0.72rem;color:var(--text-muted);">${win.total?.sessions || 0} sessions · ${win.total?.calls || 0} calls</span>
        </div>
        <div style="font-size:1.02rem;font-weight:650;color:var(--text-main);">${formatCompactTokens(win.total?.totalTokens || 0)} <span style="font-size:0.74rem;font-weight:400;color:var(--text-muted);">tokens (${formatCompactTokens(win.total?.outputTokens || 0)} out)</span></div>
        ${fams}
      </div>`;
    };

    const rows = models.map((m) => `
      <tr>
        <td><code>${escapeHtml(m.model)}</code></td>
        <td>${m.calls}</td>
        <td>${formatCompactTokens(m.inputTokens)}</td>
        <td>${formatCompactTokens(m.cacheReadTokens)} (${(m.cacheHitRate * 100).toFixed(0)}%)</td>
        <td>${formatCompactTokens(m.outputTokens)}</td>
        <td><strong>${formatCompactTokens(m.totalTokens)}</strong></td>
      </tr>
    `).join('') || `<tr><td colspan="6" style="color:var(--text-faint);">No model token telemetry recorded in this session yet.</td></tr>`;

    return `
      <div class="usage-window-grid">
        ${renderWinCard('Last 5 Hours (Shared 5h Window)', w5)}
        ${renderWinCard('Last 7 Days (Shared Weekly Window)', w7)}
      </div>
      <div class="tool-section-label" style="margin-top:4px;">Current Session Per-Model Consumption</div>
      <div class="table-wrap" style="border:1px solid var(--border);border-radius:8px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.78rem;">
          <thead>
            <tr style="background:var(--bg-sidebar);text-align:left;">
              <th style="padding:6px 10px;border-bottom:1px solid var(--border);">Model</th>
              <th style="padding:6px 10px;border-bottom:1px solid var(--border);">Calls</th>
              <th style="padding:6px 10px;border-bottom:1px solid var(--border);">Uncached In</th>
              <th style="padding:6px 10px;border-bottom:1px solid var(--border);">Cache Read</th>
              <th style="padding:6px 10px;border-bottom:1px solid var(--border);">Output</th>
              <th style="padding:6px 10px;border-bottom:1px solid var(--border);">Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="font-size:0.73rem;color:var(--text-faint);">Tip: Local rolling token totals are aggregated directly from session logs; run <code>/usage</code> in the interactive CLI to refresh live cloud quota percentages.</div>
    `;
  }

  // tab === 'btw'
  const cmds = (cliInsights?.btwCommands || []).filter((c) => c.isQuery);
  const notes = cliInsights?.btwNotes || [];

  const cmdItemsHtml = cmds.map((c, idx) => {
    const tStr = c.timestamp ? new Date(c.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const matchedNote = notes.find((n) => n.question === c.question);
    return `<div class="btw-item-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:0.82rem;font-weight:600;color:var(--text-main);"><code>/btw</code> ${escapeHtml(c.question)}</span>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <span style="font-size:0.7rem;color:var(--text-faint);">${escapeHtml(tStr)}</span>
          ${!matchedNote ? `<button type="button" class="code-mini-btn" data-action="prefill-btw-question" data-question="${escapeHtml(c.question)}">📋 Attach /copy btw</button>` : ''}
        </div>
      </div>
      ${matchedNote ? `<div class="assistant-markdown" style="font-size:0.86rem;padding-top:6px;border-top:1px solid var(--border);">${renderMarkdownHtml(matchedNote.answer, { baseDir })}</div>` : `<div style="font-size:0.73rem;color:var(--text-faint);">CLI keeps <code>/btw</code> answers ephemeral out of main context. Run <code>/copy btw</code> in CLI and click <strong>Attach /copy btw</strong> to pin the answer here.</div>`}
    </div>`;
  }).join('');

  const standaloneNotesHtml = notes
    .filter((n) => !cmds.some((c) => c.question === n.question))
    .map((n) => `<div class="btw-item-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="font-size:0.81rem;"><code>/btw</code> ${escapeHtml(n.question || 'Saved Side Answer')}</strong>
        <button type="button" class="code-mini-btn" data-action="delete-btw-note" data-note-id="${escapeHtml(n.id)}">Remove</button>
      </div>
      <div class="assistant-markdown" style="font-size:0.86rem;padding-top:6px;border-top:1px solid var(--border);">${renderMarkdownHtml(n.answer, { baseDir })}</div>
    </div>`).join('');

  return `
    ${cmdItemsHtml || standaloneNotesHtml ? (cmdItemsHtml + standaloneNotesHtml) : `<div style="font-size:0.8rem;color:var(--text-muted);">No <code>/btw &lt;question&gt;</code> commands recorded in CLI history for this conversation yet.</div>`}
    <details style="margin-top:4px;">
      <summary style="cursor:pointer;font-size:0.76rem;color:var(--accent);font-weight:600;">+ Save a <code>/copy btw</code> Side Question &amp; Answer to this session</summary>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px;">
        <input type="text" class="input-sm" data-btw-q-input placeholder="Side question (optional)">
        <textarea class="paste-area" style="min-height:90px;" data-btw-a-input placeholder="Run '/copy btw' in Antigravity CLI, then paste the Markdown answer here…"></textarea>
        <div style="display:flex;justify-content:flex-end;gap:6px;">
          <button type="button" class="code-mini-btn" data-action="paste-clipboard-btw">Paste from Clipboard</button>
          <button type="button" class="pill-btn primary" data-action="save-btw-note">Save /btw Answer</button>
        </div>
      </div>
    </details>
  `;
}

export class TranscriptRenderer {
  constructor(container, { theme = 'light', onLoadFullStep, onTocChanged, onSaveBtwNote, onDeleteBtwNote } = {}) {
    this.container = container;
    this.theme = theme;
    this.baseDir = '';
    this.onLoadFullStep = onLoadFullStep;
    this.onTocChanged = onTocChanged;
    this.onSaveBtwNote = onSaveBtwNote;
    this.onDeleteBtwNote = onDeleteBtwNote;
    this.expandedState = new Set();
    this.wasRunningTurns = new Set();
    this.userClosedWhileRunning = new Set();
    this.activeCliTab = null; // null | 'btw' | 'context' | 'usage'
    this.windowLimit = 35;
    this.currentConversationId = null;
    this.lastView = null;
    this.lastIsRunning = false;
    this._bindEvents();
  }

  setTheme(theme) {
    this.theme = theme;
  }

  setBaseDir(baseDir) {
    this.baseDir = baseDir || '';
  }

  _bindEvents() {
    this.container.addEventListener('click', async (e) => {
      if (e.target.closest('[data-local-href], [data-open-conv]')) {
        return; // Handled by attachCodeCardInteractions
      }

      const cliTabBtn = e.target.closest('[data-cli-tab]');
      if (cliTabBtn) {
        const nextTab = cliTabBtn.dataset.cliTab;
        if (cliTabBtn.classList.contains('cli-cmd-pill') && this.activeCliTab === nextTab) {
          this.activeCliTab = null;
        } else {
          this.activeCliTab = nextTab;
        }
        this._rerenderCurrent();
        return;
      }

      if (e.target.closest('[data-action="close-cli-insights"]')) {
        this.activeCliTab = null;
        this._rerenderCurrent();
        return;
      }

      const prefillBtw = e.target.closest('[data-action="prefill-btw-question"]');
      if (prefillBtw) {
        const card = this.container.querySelector('.cli-insights-card');
        const det = card?.querySelector('details');
        if (det) det.open = true;
        const qIn = card?.querySelector('[data-btw-q-input]');
        const aIn = card?.querySelector('[data-btw-a-input]');
        if (qIn) qIn.value = prefillBtw.dataset.question || '';
        try {
          const clip = await navigator.clipboard.readText();
          if (clip && aIn && !aIn.value) aIn.value = clip;
        } catch {}
        aIn?.focus();
        return;
      }

      if (e.target.closest('[data-action="paste-clipboard-btw"]')) {
        const aIn = this.container.querySelector('[data-btw-a-input]');
        try {
          const clip = await navigator.clipboard.readText();
          if (clip && aIn) aIn.value = clip;
        } catch {}
        return;
      }

      if (e.target.closest('[data-action="save-btw-note"]')) {
        const q = this.container.querySelector('[data-btw-q-input]')?.value || '';
        const a = this.container.querySelector('[data-btw-a-input]')?.value || '';
        if (a.trim() && this.onSaveBtwNote) {
          await this.onSaveBtwNote(q, a);
        }
        return;
      }

      const delBtw = e.target.closest('[data-action="delete-btw-note"]');
      if (delBtw && this.onDeleteBtwNote) {
        await this.onDeleteBtwNote(delBtw.dataset.noteId);
        return;
      }

      const procTrigger = e.target.closest('[data-action="toggle-process"]');
      if (procTrigger) {
        const card = procTrigger.closest('.process-fold-card');
        if (!card) return;
        const key = card.dataset.disclosureKey;
        const nextOpen = card.dataset.open !== 'true';
        card.dataset.open = String(nextOpen);
        if (nextOpen) {
          this.expandedState.add(key);
          this.userClosedWhileRunning.delete(key);
          const body = card.querySelector(':scope > .process-fold-body');
          if (body && !body.dataset.hydrated && card._hydrateProcess) {
            card._hydrateProcess();
          }
        } else {
          this.expandedState.delete(key);
          if (card.classList.contains('running')) {
            this.userClosedWhileRunning.add(key);
          }
        }
        return;
      }

      const disclosureTrigger = e.target.closest('[data-action="toggle-disclosure"]');
      if (disclosureTrigger) {
        const card = disclosureTrigger.closest('[data-disclosure-key]');
        if (!card) return;
        const nextOpen = card.dataset.open !== 'true';
        card.dataset.open = String(nextOpen);
        if (nextOpen) {
          this.expandedState.add(card.dataset.disclosureKey);
          const body = card.querySelector(':scope > .thinking-body');
          if (body && !body.dataset.hydrated && card._lazyContent) {
            body.innerHTML = card._lazyContent();
            body.dataset.hydrated = 'true';
            enhanceMarkdownDom(body, this.theme);
          }
        } else {
          this.expandedState.delete(card.dataset.disclosureKey);
        }
        return;
      }

      const groupTrigger = e.target.closest('[data-action="toggle-tool-group"]');
      if (groupTrigger) {
        const card = groupTrigger.closest('.tool-group-card');
        if (!card) return;
        const nextOpen = card.dataset.open !== 'true';
        card.dataset.open = String(nextOpen);
        if (nextOpen) this.expandedState.add(card.dataset.disclosureKey);
        else this.expandedState.delete(card.dataset.disclosureKey);
        return;
      }

      const rowTrigger = e.target.closest('[data-action="toggle-tool-row"]');
      if (rowTrigger) {
        const row = rowTrigger.closest('.tool-row');
        if (!row) return;
        const nextOpen = row.dataset.open !== 'true';
        row.dataset.open = String(nextOpen);
        if (nextOpen) {
          this.expandedState.add(row.dataset.disclosureKey);
          const detail = row.querySelector(':scope > .tool-row-detail');
          if (detail && !detail.dataset.hydrated && row._lazyContent) {
            detail.innerHTML = row._lazyContent();
            detail.dataset.hydrated = 'true';
          }
        } else {
          this.expandedState.delete(row.dataset.disclosureKey);
        }
        return;
      }

      const loadMoreBtn = e.target.closest('[data-action="load-earlier-turns"]');
      if (loadMoreBtn) {
        this.windowLimit += 40;
        this._rerenderCurrent();
        return;
      }

      const loadFullBtn = e.target.closest('[data-action="load-full-step"]');
      if (loadFullBtn && this.onLoadFullStep) {
        const stepIdx = Number(loadFullBtn.dataset.step);
        const pre = loadFullBtn.closest('.tool-row-detail')?.querySelector('[data-tool-output-pre]');
        loadFullBtn.disabled = true;
        loadFullBtn.textContent = 'Loading…';
        try {
          const full = await this.onLoadFullStep(stepIdx);
          if (pre && full?.content != null) {
            pre.textContent = full.content;
          }
          loadFullBtn.remove();
        } catch {
          loadFullBtn.textContent = 'Retry load';
          loadFullBtn.disabled = false;
        }
      }
    });
  }

  expandAll() {
    this.container.querySelectorAll('.process-fold-card').forEach((procCard) => {
      procCard.dataset.open = 'true';
      if (procCard.dataset.disclosureKey) this.expandedState.add(procCard.dataset.disclosureKey);
      const body = procCard.querySelector(':scope > .process-fold-body');
      if (body && !body.dataset.hydrated && procCard._hydrateProcess) {
        procCard._hydrateProcess();
      }
    });
    this.container.querySelectorAll('.disclosure-card, .tool-group-card, .tool-row').forEach((node) => {
      node.dataset.open = 'true';
      if (node.dataset.disclosureKey) this.expandedState.add(node.dataset.disclosureKey);
      const body = node.querySelector(':scope > .thinking-body, :scope > .tool-row-detail');
      if (body && !body.dataset.hydrated && node._lazyContent) {
        body.innerHTML = node._lazyContent();
        body.dataset.hydrated = 'true';
        enhanceMarkdownDom(body, this.theme);
      }
    });
  }

  collapseAll() {
    this.expandedState.clear();
    this.container.querySelectorAll('.process-fold-card, .disclosure-card, .tool-group-card, .tool-row').forEach((node) => {
      node.dataset.open = 'false';
      if (node.classList.contains('running') && node.dataset.disclosureKey) {
        this.userClosedWhileRunning.add(node.dataset.disclosureKey);
      }
    });
  }

  _rerenderCurrent() {
    if (!this.lastView) return;
    this.render(this.currentConversationId, this.lastView, {
      isRunning: this.lastIsRunning,
      baseDir: this.baseDir,
      subagents: this.lastSubagents,
      parentSession: this.lastParentSession,
      cliInsights: this.lastCliInsights,
      artifacts: this.lastArtifacts,
    });
  }

  expandWindowForSearch() {
    const total = this.lastView?.turns?.length || 0;
    if (total > this.windowLimit) {
      this.windowLimit = total;
      this._rerenderCurrent();
    }
  }

  render(convId, view, { isRunning = false, baseDir, subagents = [], parentSession = null, cliInsights = null, artifacts = [] } = {}) {
    if (baseDir !== undefined) this.baseDir = baseDir || '';
    this.lastSubagents = subagents;
    this.lastParentSession = parentSession;
    if (cliInsights !== null) this.lastCliInsights = cliInsights;
    if (artifacts) this.lastArtifacts = artifacts;
    if (convId !== this.currentConversationId) {
      this.currentConversationId = convId;
      this.expandedState.clear();
      this.wasRunningTurns.clear();
      this.userClosedWhileRunning.clear();
      this.activeCliTab = null;
      this.windowLimit = 35;
      this.container.innerHTML = '';
    }
    this.lastView = view;
    this.lastIsRunning = isRunning;

    const turns = view?.turns || [];
    if (turns.length === 0) {
      this.container.innerHTML = `<div class="empty-state"><strong>Empty conversation</strong><span>Waiting for the first message or tool output…</span></div>`;
      this.onTocChanged?.([]);
      return;
    }

    const startIdx = Math.max(0, turns.length - this.windowLimit);
    const visibleTurns = turns.slice(startIdx);
    const lastTurn = turns[turns.length - 1];

    // Keep execution process collapsed by default; if user manually expanded an active turn, auto-collapse once finished!
    for (const turn of visibleTurns) {
      const procKey = `${turn.id}:process`;
      const hasFinalMarkdown = turn.items.some((it) => it.kind === 'markdown' && !it.intermediate);
      const turnRunning = turn.id === lastTurn?.id && (isRunning || view?.summary?.activeStatus === 'running') && !hasFinalMarkdown;

      if (turnRunning) {
        this.wasRunningTurns.add(turn.id);
      } else if (this.wasRunningTurns.has(turn.id)) {
        this.wasRunningTurns.delete(turn.id);
        this.expandedState.delete(procKey);
      }
    }

    let ribbon = this.container.querySelector(':scope > .session-ribbon');
    if (!ribbon) {
      ribbon = document.createElement('div');
      ribbon.className = 'session-ribbon';
      this.container.prepend(ribbon);
    }
    const s = view.summary || {};
    const ctxPct = s.contextWindow?.limit ? `${((s.contextWindow.usageRatio || 0) * 100).toFixed(1)}%` : '';
    const btwCount = ((this.lastCliInsights?.btwCommands || []).filter((c) => c.isQuery).length) +
      ((this.lastCliInsights?.btwNotes || []).filter((n) => !(this.lastCliInsights?.btwCommands || []).some((c) => c.question === n.question)).length);
    const totalTokens = (s.totalInputTokens || 0) + (s.totalCacheReadTokens || 0) + (s.totalOutputTokens || 0);
    const parentLinkHtml = parentSession
      ? `<button type="button" class="open-sidebar-pill" data-open-conv="${escapeHtml(parentSession.id)}" title="Return to parent session">← Parent: ${escapeHtml(parentSession.title.slice(0, 32))}</button>`
      : '';
    ribbon.innerHTML = `
      <div class="ribbon-stats">
        ${parentLinkHtml}
        <span class="ribbon-stat"><strong>${s.totalTurns || 0}</strong> turns</span>
        <span class="ribbon-stat"><strong>${s.totalSteps || 0}</strong> steps</span>
        <span class="ribbon-stat"><strong>${s.totalToolCalls || 0}</strong> tools</span>
        ${subagents.length > 0 ? `<span class="ribbon-stat"><strong>${subagents.length}</strong> subagents</span>` : ''}
        ${s.totalErrors ? `<span class="ribbon-stat" style="color:var(--error);"><strong>${s.totalErrors}</strong> errors</span>` : ''}
      </div>
      <div class="ribbon-cli-pills">
        <button type="button" class="cli-cmd-pill ${this.activeCliTab === 'btw' ? 'active' : ''}" data-cli-tab="btw" title="Inspect /btw side questions &amp; attach /copy btw answers">/btw${btwCount > 0 ? ` (${btwCount})` : ''}</button>
        <button type="button" class="cli-cmd-pill ${this.activeCliTab === 'context' ? 'active' : ''}" data-cli-tab="context" title="Inspect /context window usage grid &amp; breakdown">/context${ctxPct ? ` · ${ctxPct}` : ''}</button>
        <button type="button" class="cli-cmd-pill ${this.activeCliTab === 'usage' ? 'active' : ''}" data-cli-tab="usage" title="Inspect /usage 5h &amp; 7d model token consumption">/usage${totalTokens > 0 ? ` · ${formatCompactTokens(totalTokens)}` : ''}</button>
      </div>
    `;

    // Interactive /btw, /context, /usage Inspector Card
    let cliCard = this.container.querySelector(':scope > .cli-insights-card');
    if (this.activeCliTab) {
      if (!cliCard) {
        cliCard = document.createElement('div');
        cliCard.className = 'cli-insights-card';
        ribbon.after(cliCard);
      }
      cliCard.innerHTML = `
        <div class="cli-insights-header">
          <div class="cli-insights-tabs">
            <button type="button" class="cli-tab-btn ${this.activeCliTab === 'btw' ? 'active' : ''}" data-cli-tab="btw">💬 /btw</button>
            <button type="button" class="cli-tab-btn ${this.activeCliTab === 'context' ? 'active' : ''}" data-cli-tab="context">⛁ /context</button>
            <button type="button" class="cli-tab-btn ${this.activeCliTab === 'usage' ? 'active' : ''}" data-cli-tab="usage">📊 /usage</button>
          </div>
          <button type="button" class="icon-btn sm" data-action="close-cli-insights" title="Close panel">✕</button>
        </div>
        <div class="cli-insights-body">${renderCliInsightsHtml(this.activeCliTab, view, this.lastCliInsights, this.lastArtifacts, this.baseDir)}</div>
      `;
      enhanceMarkdownDom(cliCard, this.theme);
    } else if (cliCard) {
      cliCard.remove();
      cliCard = null;
    }

    const afterCliAnchor = cliCard && cliCard.parentElement ? cliCard : ribbon;

    // Subagents collapsible overview card inside Session Preview (collapsed by default!)
    let subBanner = this.container.querySelector(':scope > .subagents-preview-card');
    if (subagents.length > 0) {
      const subKey = `${convId}:subagents-banner`;
      const subOpen = this.expandedState.has(subKey);
      if (!subBanner) {
        subBanner = document.createElement('div');
        subBanner.className = 'process-fold-card subagents-preview-card';
        afterCliAnchor.after(subBanner);
      }
      subBanner.dataset.open = String(subOpen);
      subBanner.dataset.disclosureKey = subKey;
      subBanner.innerHTML = `
        <button type="button" class="process-fold-trigger" data-action="toggle-process">
          <span class="tool-group-left">
            ${CHEVRON_SVG}
            <span class="process-fold-title">Subagents invoked in this session (${subagents.length})</span>
          </span>
          <span class="tool-status-pill done">${subagents.length}</span>
        </button>
        <div class="process-fold-body" data-hydrated="true">
          ${subagents.map((sub) => `
            <div class="subagent-inline-item">
              <div style="min-width:0;flex:1;">
                <div style="font-size:0.8rem;font-weight:550;color:var(--text-main);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(sub.title)}</div>
                <div style="font-size:0.71rem;color:var(--text-faint);">${escapeHtml(sub.agentName || 'subagent')} · ${sub.stepCount || 0} steps · ${escapeHtml(sub.id.slice(0, 8))}</div>
              </div>
              <button type="button" class="open-sidebar-pill" data-open-conv="${escapeHtml(sub.id)}">Open Subagent</button>
            </div>
          `).join('')}
        </div>
      `;
    } else if (subBanner) {
      subBanner.remove();
    }

    const anchorAfterRibbon = subBanner && subBanner.parentElement ? subBanner : afterCliAnchor;
    let loadBtn = this.container.querySelector(':scope > .load-earlier-btn');
    if (startIdx > 0) {
      if (!loadBtn) {
        loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'load-earlier-btn';
        loadBtn.dataset.action = 'load-earlier-turns';
        anchorAfterRibbon.after(loadBtn);
      }
      loadBtn.textContent = `Show earlier turns (${startIdx} hidden for speed)`;
    } else if (loadBtn) {
      loadBtn.remove();
    }

    const existingById = new Map();
    this.container.querySelectorAll(':scope > .turn-block').forEach((node) => {
      existingById.set(node.dataset.turnId, node);
    });

    const visibleIds = new Set(visibleTurns.map((t) => t.id));
    for (const [id, node] of existingById.entries()) {
      if (!visibleIds.has(id)) node.remove();
    }

    for (const turn of visibleTurns) {
      const hasFinalMarkdown = turn.items.some((it) => it.kind === 'markdown' && !it.intermediate);
      const isTurnRunning = turn.id === lastTurn?.id && (isRunning || view?.summary?.activeStatus === 'running') && !hasFinalMarkdown;
      const sig = `${turnSignature(turn)}:${isTurnRunning ? 'run' : 'done'}:${this.baseDir}`;
      const existing = existingById.get(turn.id);
      if (existing && existing.dataset.signature === sig) {
        continue;
      }
      const freshNode = buildTurnElement(turn, {
        theme: this.theme,
        baseDir: this.baseDir,
        expandedState: this.expandedState,
        isTurnRunning,
      });
      if (existing) {
        existing.replaceWith(freshNode);
      } else {
        this.container.appendChild(freshNode);
      }
    }

    this.onTocChanged?.(this.extractToc());
  }

  extractToc() {
    const items = [];
    let headingIdx = 0;
    this.container.querySelectorAll('.turn-block').forEach((turnEl) => {
      const badge = turnEl.querySelector('.user-badge')?.textContent || turnEl.id;
      const snippet = turnEl.dataset.promptPreview || '';
      const fullTitle = turnEl.dataset.promptFull ? `${badge}: ${turnEl.dataset.promptFull}` : badge;
      const label = snippet ? `${badge} · ${snippet}` : badge;
      items.push({ id: turnEl.id, label, fullTitle, level: 0, isTurn: true });
      turnEl.querySelectorAll(':scope > .assistant-markdown h1, :scope > .assistant-markdown h2, :scope > .assistant-markdown h3').forEach((h) => {
        if (!h.id) h.id = `hd-${++headingIdx}`;
        const level = Number(h.tagName.slice(1));
        items.push({ id: h.id, label: h.textContent.trim(), fullTitle: h.textContent.trim(), level, isTurn: false });
      });
    });
    return items;
  }
}
