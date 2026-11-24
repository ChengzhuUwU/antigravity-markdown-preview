import { applyStaticI18n, getLang, setLang, t } from './i18n.js';
import {
  escapeHtml,
  slugifyHeading,
  renderMarkdownHtml,
  enhanceMarkdownDom,
  attachCodeCardInteractions,
  bindPanZoomViewport,
  downloadSvgElement,
  rethemeMermaidDiagrams,
} from './markdown.js';
import { TranscriptRenderer, formatCompactTokens, renderCliInsightsHtml } from './transcript-view.js';

const isSidecar = Boolean(window.sidecar && typeof window.sidecar.fetch === 'function');
const apiFetch = (url, opts) => (isSidecar ? window.sidecar.fetch(url, opts) : fetch(url, opts));
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const CHEVRON_SVG = `<svg class="chevron-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg>`;

const THEME_PALETTES = [
  { id: 'parchment', lightBg: '#faf9f5', darkBg: '#141413', accent: '#c96442' },
  { id: 'lavender', lightBg: '#f8f6fc', darkBg: '#14121b', accent: '#7c5cbf' },
  { id: 'sakura', lightBg: '#fcf6f8', darkBg: '#191215', accent: '#c9597a' },
  { id: 'matcha', lightBg: '#f5f9f6', darkBg: '#111714', accent: '#3b825f' },
  { id: 'glacier', lightBg: '#f4f8fc', darkBg: '#11161d', accent: '#3874b5' },
  { id: 'amber', lightBg: '#fcf8f2', darkBg: '#181410', accent: '#b87328' },
  { id: 'celadon', lightBg: '#f3f9f9', darkBg: '#101718', accent: '#298088' },
  { id: 'slate', lightBg: '#f8f9fa', darkBg: '#121316', accent: '#475569' },
];

function initialThemeMode() {
  const saved = localStorage.getItem('amp-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const state = {
  mode: 'sessions', // 'sessions' | 'docs'
  flavor: localStorage.getItem('amp-flavor') || 'antigravity-cli',
  theme: initialThemeMode(), // 'light' | 'dark' (2 brightness modes)
  palette: localStorage.getItem('amp-palette') || 'parchment', // 8 color palettes
  width: localStorage.getItem('amp-width') || 'normal',
  tables: localStorage.getItem('amp-tables') || 'compact',
  prose: localStorage.getItem('amp-prose') || 'sans',
  autoFollow: true,
  activeConvId: null,
  activePreviewId: localStorage.getItem('amp-last-preview') || null,
  currentBaseDir: '',
  docsStoragePath: '',
  conversations: [],
  customPreviews: [],
  projectExpanded: new Map(), // projectKey -> bool
  showOlderInProject: new Set(), // projectKey
  expandedSubagentGroups: new Set(), // parentConvId or projectKey:subagents
  docsManageMode: false,
  renamingDocId: null,
  dragDocId: null,
  currentViewData: null,
  currentCustomDoc: null,
  eventSource: null,
  findHits: [],
  findIndex: -1,
  // Side Preview Pane history stack
  sideHistory: [],
  sideHistoryIdx: -1,
  sideCurrent: null,
  // Popup File Preview Modal state
  popupCurrent: null,
  // Topbar CLI Tools Inspector tab ('btw' | 'context' | 'usage' | null)
  activeCliToolTab: null,
};

const el = (id) => document.getElementById(id);

function resolvedTheme() {
  return state.theme === 'dark' ? 'dark' : 'light';
}

function renderPrefsMenu() {
  const menu = el('prefs-menu');
  if (!menu) return;
  const isDark = resolvedTheme() === 'dark';
  const lang = getLang();

  const langSegHtml = `
    <div class="prefs-control-row">
      <span class="prefs-control-label">${escapeHtml(t('secLanguage'))}</span>
      <div class="prefs-seg-group">
        <button type="button" class="prefs-seg-btn ${lang === 'en' ? 'active' : ''}" data-pref-lang="en">English</button>
        <button type="button" class="prefs-seg-btn ${lang === 'zh' ? 'active' : ''}" data-pref-lang="zh">简体中文</button>
      </div>
    </div>
  `;

  const typoRowsHtml = `
    <div class="prefs-control-row">
      <span class="prefs-control-label">${escapeHtml(t('lblFont'))}</span>
      <div class="prefs-seg-group">
        <button type="button" class="prefs-seg-btn ${state.prose === 'sans' ? 'active' : ''}" data-pref-prose="sans">${escapeHtml(t('fontSans'))}</button>
        <button type="button" class="prefs-seg-btn ${state.prose === 'serif' ? 'active' : ''}" data-pref-prose="serif">${escapeHtml(t('fontSerif'))}</button>
      </div>
    </div>
    <div class="prefs-control-row">
      <span class="prefs-control-label">${escapeHtml(t('lblWidth'))}</span>
      <div class="prefs-seg-group">
        <button type="button" class="prefs-seg-btn ${state.width === 'normal' ? 'active' : ''}" data-pref-width="normal">${escapeHtml(t('widthNormal'))}</button>
        <button type="button" class="prefs-seg-btn ${state.width === 'wide' ? 'active' : ''}" data-pref-width="wide">${escapeHtml(t('widthWide'))}</button>
      </div>
    </div>
    <div class="prefs-control-row">
      <span class="prefs-control-label">${escapeHtml(t('lblTables'))}</span>
      <div class="prefs-seg-group">
        <button type="button" class="prefs-seg-btn ${state.tables === 'compact' ? 'active' : ''}" data-pref-tables="compact">${escapeHtml(t('tablesFit'))}</button>
        <button type="button" class="prefs-seg-btn ${state.tables === 'expand' ? 'active' : ''}" data-pref-tables="expand">${escapeHtml(t('tablesExpand'))}</button>
      </div>
    </div>
  `;

  const modeItemsHtml = [
    { id: 'light', label: t('modeLight') },
    { id: 'dark', label: t('modeDark') },
  ].map((m) => {
    const active = state.theme === m.id;
    return `<button type="button" class="theme-menu-item ${active ? 'active' : ''}" data-theme-mode="${m.id}">
      <span>${escapeHtml(m.label)}</span>
      <span>${active ? '✓' : ''}</span>
    </button>`;
  }).join('');

  const paletteItemsHtml = THEME_PALETTES.map((p) => {
    const active = state.palette === p.id;
    const bgHex = isDark ? p.darkBg : p.lightBg;
    const grad = `linear-gradient(135deg, ${bgHex} 50%, ${p.accent} 50%)`;
    return `<button type="button" class="theme-menu-item ${active ? 'active' : ''}" data-theme-palette="${p.id}">
      <span class="theme-menu-item-left">
        <span class="palette-dual-swatch" style="background:${grad};"></span>
        <span>${escapeHtml(t(`pal_${p.id}`))}</span>
      </span>
      <span>${active ? '✓' : ''}</span>
    </button>`;
  }).join('');

  menu.innerHTML = `
    ${langSegHtml}
    <div class="theme-menu-divider"></div>
    <div class="theme-menu-section-label">${escapeHtml(t('secTypography'))}</div>
    ${typoRowsHtml}
    <div class="theme-menu-divider"></div>
    <div class="theme-menu-section-label">${escapeHtml(t('secMode'))}</div>
    ${modeItemsHtml}
    <div class="theme-menu-divider"></div>
    <div class="theme-menu-section-label">${escapeHtml(t('secPalette'))}</div>
    ${paletteItemsHtml}
  `;
}

function applyAppearance() {
  const effectiveTheme = resolvedTheme();
  const validPalette = THEME_PALETTES.some((p) => p.id === state.palette) ? state.palette : 'parchment';
  state.palette = validPalette;

  document.documentElement.setAttribute('data-theme', effectiveTheme);
  document.documentElement.setAttribute('data-palette', validPalette);
  document.documentElement.setAttribute('data-width', state.width);
  document.documentElement.setAttribute('data-tables', state.tables);
  document.documentElement.setAttribute('data-prose', state.prose);

  const hljsLight = el('hljs-light-css');
  const hljsDark = el('hljs-dark-css');
  if (hljsLight && hljsDark) {
    hljsLight.disabled = effectiveTheme === 'dark';
    hljsDark.disabled = effectiveTheme !== 'dark';
  }

  const palObj = THEME_PALETTES.find((p) => p.id === validPalette) || THEME_PALETTES[0];
  const swatchEl = el('prefs-btn-swatch');
  if (swatchEl) {
    const bgHex = effectiveTheme === 'dark' ? palObj.darkBg : palObj.lightBg;
    swatchEl.style.background = `linear-gradient(135deg, ${bgHex} 50%, ${palObj.accent} 50%)`;
  }
  const prefsLabel = el('prefs-btn-label');
  if (prefsLabel) {
    prefsLabel.textContent = t('prefsBtn');
  }
  renderPrefsMenu();
  transcriptRenderer?.setTheme(effectiveTheme);
  rethemeMermaidDiagrams(effectiveTheme);
}

function applyLanguage(nextLang) {
  setLang(nextLang);
  applyStaticI18n();
  const manageBtn = el('docs-manage-btn');
  if (manageBtn) {
    manageBtn.textContent = state.docsManageMode ? t('manageDoneBtn') : t('manageBtn');
  }
  const popupWrap = el('popup-wrap-btn');
  if (popupWrap) {
    popupWrap.textContent = el('popup-code-view')?.classList.contains('wrapped') ? t('unwrapBtn') : t('wrapBtn');
  }
  const sideWrap = el('side-wrap-btn');
  if (sideWrap) {
    sideWrap.textContent = el('side-code-view')?.classList.contains('wrapped') ? t('unwrapBtn') : t('wrapBtn');
  }
  applyAppearance();
  if (state.eventSource) {
    applyHookPhase(state.currentViewData?.hookState);
  }
  renderSidebarList();
  renderCliToolsDrawer();

  if (state.mode === 'sessions' && transcriptRenderer?.lastView) {
    transcriptRenderer._rerenderCurrent();
  } else if (state.mode === 'docs') {
    if (state.currentCustomDoc) {
      renderCustomPreview(state.currentCustomDoc);
    } else {
      el('doc-title').textContent = t('tabDocs');
      el('reader-column').innerHTML = `<div class="empty-state"><strong>${escapeHtml(t('docsEmptyTitle'))}</strong><span>${t('docsEmptyHint')}</span></div>`;
    }
  }
  if (state.sideCurrent && !el('side-preview-pane')?.classList.contains('hidden')) {
    populatePreviewBody(el('side-preview-body'), state.sideCurrent, 'side-code-view');
  }
  if (state.popupCurrent && !el('file-preview-modal')?.classList.contains('hidden')) {
    populatePreviewBody(el('popup-preview-body'), state.popupCurrent, 'popup-code-view');
  }
}

let transcriptRenderer = null;
let hoverTimer = null;

function setLiveBadge(text, kind = 'idle') {
  const pill = el('live-pill');
  if (!pill) return;
  pill.textContent = text;
  pill.className = 'live-pill';
  if (kind === 'live') pill.classList.add('live');
  else if (kind === 'active') pill.classList.add('active-phase');
}

function formatCompactDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const locale = getLang() === 'zh' ? 'zh-CN' : 'en-US';
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  const diffDays = Math.floor((Date.now() - ms) / (24 * 3600 * 1000));
  if (diffDays < 7) {
    if (getLang() === 'zh') {
      return diffDays === 0 ? '今天' : `${diffDays}天前`;
    }
    return diffDays === 0 ? 'Today' : `${diffDays}d ago`;
  }
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function renderToc(items) {
  const list = el('toc-list');
  if (!list) return;
  if (!items || items.length === 0) {
    list.innerHTML = `<div style="font-size:0.75rem;color:var(--text-faint);padding:4px 6px;">${escapeHtml(t('noOutline'))}</div>`;
    return;
  }
  list.innerHTML = items.map((it) =>
    `<button type="button" class="toc-link ${it.isTurn ? 'turn-item' : `level-${it.level}`}" data-target-id="${escapeHtml(it.id)}" title="${escapeHtml(it.fullTitle || it.label)}">${escapeHtml(it.label)}</button>`
  ).join('');
}

async function loadFlavors() {
  try {
    const res = await apiFetch('/api/flavors');
    if (!res.ok) return;
    const { flavors } = await res.json();
    const select = el('flavor-select');
    if (!select || !flavors?.length) return;
    select.innerHTML = flavors.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
    if (flavors.includes(state.flavor)) select.value = state.flavor;
    else state.flavor = flavors[0];
  } catch {}
}

async function loadConversations() {
  try {
    const res = await apiFetch(`/api/conversations?flavor=${encodeURIComponent(state.flavor)}`);
    if (!res.ok) return;
    const data = await res.json();
    state.conversations = data.conversations || [];
    if (state.mode === 'sessions') renderSidebarList();
  } catch {}
}

async function loadCustomPreviews() {
  try {
    const res = await apiFetch('/api/previews');
    if (!res.ok) return;
    const data = await res.json();
    state.customPreviews = data.previews || [];
    if (data.storagePath) state.docsStoragePath = data.storagePath;
    if (state.mode === 'docs') renderSidebarList();
  } catch {}
}

function resolveProjectLabel(c) {
  if (c.projectName && c.projectName.trim()) return c.projectName.trim();
  if (c.workspaceUri && c.workspaceUri.trim()) {
    const parts = c.workspaceUri.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return 'Unassigned';
}

function renderSessionButtonHtml(c) {
  const active = c.id === state.activeConvId ? 'active' : '';
  const sub = c.isSubagent ? 'is-subagent' : '';
  const dotClass = c.active ? 'running' : '';
  const timeStr = formatCompactDate(c.updatedAt);
  return `<button type="button" class="session-item ${active} ${sub}" data-conv-id="${escapeHtml(c.id)}" title="${escapeHtml(c.title)}">
    <div class="session-title-line">
      <span class="status-dot ${dotClass}"></span>
      <span class="session-title-text">${escapeHtml(c.title)}</span>
    </div>
    <div class="session-meta-line">
      <span>${escapeHtml(c.id.slice(0, 8))}${c.stepCount ? ` · ${c.stepCount} ${escapeHtml(t('stepsStat'))}` : ''}</span>
      <span>${escapeHtml(timeStr)}</span>
    </div>
  </button>`;
}

function hideDocHoverPopover() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  el('doc-hover-popover')?.classList.add('hidden');
}

function showDocHoverPopover(docId, cardEl) {
  if (state.docsManageMode || state.renamingDocId) return;
  const doc = state.customPreviews.find((d) => d.id === docId);
  if (!doc) return;
  const pop = el('doc-hover-popover');
  const sidebar = el('sidebar');
  if (!pop || !sidebar) return;

  el('doc-hover-title').textContent = doc.title;
  el('doc-hover-path').textContent = doc.filePath || doc.baseDir || doc.mode || 'Inline Clip';
  const bodyEl = el('doc-hover-body');
  bodyEl.innerHTML = doc.excerpt
    ? renderMarkdownHtml(doc.excerpt, { baseDir: doc.baseDir || '' })
    : `<span style="color:var(--text-faint);">(Empty document)</span>`;
  enhanceMarkdownDom(bodyEl, resolvedTheme());

  pop.classList.remove('hidden');
  const sideRect = sidebar.getBoundingClientRect();
  const cardRect = cardEl.getBoundingClientRect();
  const popHeight = Math.min(420, pop.offsetHeight || 320);
  const top = Math.max(12, Math.min(window.innerHeight - popHeight - 12, cardRect.top));
  pop.style.left = `${Math.round(sideRect.right + 10)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function renderSidebarList() {
  hideDocHoverPopover();
  const container = el('session-list');
  if (!container) return;
  const query = (el('sidebar-search')?.value || '').trim().toLowerCase();

  if (state.mode === 'docs') {
    const filtered = state.customPreviews.filter((p) =>
      !query ||
      p.title.toLowerCase().includes(query) ||
      (p.filePath || '').toLowerCase().includes(query) ||
      (p.excerpt || '').toLowerCase().includes(query)
    );
    if (filtered.length === 0) {
      container.innerHTML = `<div style="padding:16px 10px;font-size:0.78rem;color:var(--text-faint);">${t('noDocsYet')}</div>`;
      return;
    }

    const storageFooterHtml = state.docsStoragePath
      ? `<div style="margin-top:auto;padding:10px 6px 4px;font-size:0.68rem;color:var(--text-faint);border-top:1px dashed var(--border);word-break:break-all;" title="${escapeHtml(state.docsStoragePath)}">${escapeHtml(t('savedIn'))} <code>${escapeHtml(state.docsStoragePath)}</code></div>`
      : '';

    container.innerHTML = filtered.map((doc) => {
      const active = doc.id === state.activePreviewId ? 'active' : '';
      const timeStr = formatCompactDate(doc.updatedAt);
      const isRenaming = state.renamingDocId === doc.id;
      const draggableAttr = state.docsManageMode && !isRenaming ? 'draggable="true"' : '';

      const dragHandleHtml = state.docsManageMode
        ? `<span class="doc-drag-handle" title="Drag to reorder">⠿</span>`
        : '';

      const mainInnerHtml = isRenaming
        ? `<input type="text" class="doc-rename-input" data-rename-input="${escapeHtml(doc.id)}" value="${escapeHtml(doc.title)}">`
        : `<div class="session-title-line">
            <span class="session-title-text">${escapeHtml(doc.title)}</span>
          </div>
          <div class="session-meta-line">
            <span class="session-project-pill">${escapeHtml(doc.baseDir ? doc.baseDir.split(/[\\/]/).pop() : doc.mode)}</span>
            <span>${escapeHtml(timeStr)}</span>
          </div>`;

      const manageBtnsHtml = state.docsManageMode && !isRenaming
        ? `<div class="doc-manage-actions">
            <button type="button" class="doc-action-btn" data-doc-rename="${escapeHtml(doc.id)}" title="Rename">✎</button>
            <button type="button" class="doc-action-btn danger" data-doc-delete="${escapeHtml(doc.id)}" title="Delete">🗑</button>
          </div>`
        : '';

      return `<div class="doc-item-card ${active}" data-doc-card="${escapeHtml(doc.id)}" ${draggableAttr}>
        ${dragHandleHtml}
        <div class="doc-item-main" data-preview-id="${escapeHtml(doc.id)}">${mainInnerHtml}</div>
        ${manageBtnsHtml}
      </div>`;
    }).join('') + (state.docsManageMode ? storageFooterHtml : '');

    if (state.renamingDocId) {
      const inp = container.querySelector(`[data-rename-input="${CSS.escape(state.renamingDocId)}"]`);
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
    return;
  }

  // Sessions mode: include user inputs (`preview` & `userSearchText`) in search!
  const filtered = state.conversations.filter((c) => {
    if (!query) return true;
    const proj = resolveProjectLabel(c).toLowerCase();
    return (
      c.title.toLowerCase().includes(query) ||
      c.id.toLowerCase().includes(query) ||
      proj.includes(query) ||
      (c.preview || '').toLowerCase().includes(query) ||
      (c.userSearchText || '').toLowerCase().includes(query)
    );
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding:16px 10px;font-size:0.78rem;color:var(--text-faint);">${escapeHtml(t('noSessionsMatch'))}</div>`;
    return;
  }

  const groupsMap = new Map();
  for (const c of filtered) {
    const projectLabel = resolveProjectLabel(c);
    let grp = groupsMap.get(projectLabel);
    if (!grp) {
      grp = { key: projectLabel, label: projectLabel, workspaceUri: c.workspaceUri || '', latestUpdatedAt: 0, items: [] };
      groupsMap.set(projectLabel, grp);
    }
    if (!grp.workspaceUri && c.workspaceUri) grp.workspaceUri = c.workspaceUri;
    grp.items.push(c);
    if ((c.updatedAt || 0) > grp.latestUpdatedAt) {
      grp.latestUpdatedAt = c.updatedAt || 0;
    }
  }

  const sortedGroups = Array.from(groupsMap.values()).sort((a, b) => {
    if (a.key === 'Unassigned' && b.key !== 'Unassigned') return 1;
    if (b.key === 'Unassigned' && a.key !== 'Unassigned') return -1;
    return b.latestUpdatedAt - a.latestUpdatedAt;
  });

  const cutoffMs = Date.now() - THREE_DAYS_MS;

  container.innerHTML = sortedGroups.map((grp) => {
    grp.items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const activeWithin3d = grp.latestUpdatedAt >= cutoffMs;
    const containsActiveConv = grp.items.some((s) => s.id === state.activeConvId);

    const isOpen = query
      ? true
      : (state.projectExpanded.has(grp.key)
          ? state.projectExpanded.get(grp.key)
          : (activeWithin3d || containsActiveConv));

    // Separate root sessions vs subagents (subagents collapsed by default!)
    const rootAll = grp.items.filter((s) => !s.isSubagent);
    const subAll = grp.items.filter((s) => s.isSubagent);
    const subsByParent = new Map();
    const rootIdSet = new Set(rootAll.map((r) => r.id));
    const orphanSubs = [];

    for (const sub of subAll) {
      if (sub.parentConversationId && rootIdSet.has(sub.parentConversationId)) {
        const list = subsByParent.get(sub.parentConversationId) || [];
        list.push(sub);
        subsByParent.set(sub.parentConversationId, list);
      } else {
        orphanSubs.push(sub);
      }
    }

    const recentRoots = rootAll.filter((s) => (s.updatedAt || 0) >= cutoffMs || s.id === state.activeConvId);
    const olderRoots = rootAll.filter((s) => (s.updatedAt || 0) < cutoffMs && s.id !== state.activeConvId);

    const showAllRoots = Boolean(query) || state.showOlderInProject.has(grp.key) || recentRoots.length === 0;
    const visibleRoots = showAllRoots ? rootAll : recentRoots;
    const hiddenRootCount = showAllRoots ? 0 : olderRoots.length;

    const rowsHtml = visibleRoots.map((rootConv) => {
      const childSubs = subsByParent.get(rootConv.id) || [];
      let subHtml = '';
      if (childSubs.length > 0) {
        const subGroupKey = `parent:${rootConv.id}`;
        const subExpanded = Boolean(query) || state.expandedSubagentGroups.has(subGroupKey) || childSubs.some((s) => s.id === state.activeConvId);
        const subUnit = childSubs.length === 1 ? t('subagentUnit') : t('subagentsUnit');
        subHtml = `<button type="button" class="subagent-group-toggle" data-toggle-subagents="${escapeHtml(subGroupKey)}">
            <span>${subExpanded ? '▾' : '▸'} ${childSubs.length} ${escapeHtml(subUnit)}</span>
          </button>
          ${subExpanded ? childSubs.map(renderSessionButtonHtml).join('') : ''}`;
      }
      return renderSessionButtonHtml(rootConv) + subHtml;
    }).join('');

    let orphanHtml = '';
    if (orphanSubs.length > 0) {
      const orphanKey = `orphan:${grp.key}`;
      const orphanOpen = Boolean(query) || state.expandedSubagentGroups.has(orphanKey) || orphanSubs.some((s) => s.id === state.activeConvId);
      const orphanUnit = orphanSubs.length === 1 ? t('standaloneSubagentUnit') : t('standaloneSubagentsUnit');
      orphanHtml = `<button type="button" class="subagent-group-toggle" data-toggle-subagents="${escapeHtml(orphanKey)}">
          <span>${orphanOpen ? '▾' : '▸'} ${orphanSubs.length} ${escapeHtml(orphanUnit)}</span>
        </button>
        ${orphanOpen ? orphanSubs.map(renderSessionButtonHtml).join('') : ''}`;
    }

    const olderBtnHtml = hiddenRootCount > 0
      ? `<button type="button" class="show-older-sessions-btn" data-show-older-project="${escapeHtml(grp.key)}">${escapeHtml(t('olderSessionsBtn', { count: hiddenRootCount, unit: hiddenRootCount === 1 ? t('sessionUnit') : t('sessionsUnit') }))}</button>`
      : '';

    const displayCount = rootAll.length || grp.items.length;
    const folderTooltip = grp.workspaceUri ? `${grp.label} (${grp.workspaceUri})` : grp.label;

    return `<div class="project-folder" data-project-key="${escapeHtml(grp.key)}" data-open="${isOpen}">
      <button type="button" class="project-folder-header" data-toggle-project="${escapeHtml(grp.key)}" title="${escapeHtml(folderTooltip)}">
        <span class="project-folder-left">
          ${CHEVRON_SVG}
          <span class="project-folder-name">${escapeHtml(grp.label)}</span>
        </span>
        <span class="project-folder-meta">
          <span>${escapeHtml(formatCompactDate(grp.latestUpdatedAt))}</span>
          <span class="project-folder-count">${displayCount}</span>
        </span>
      </button>
      <div class="project-folder-body">
        ${rowsHtml}
        ${orphanHtml}
        ${olderBtnHtml}
      </div>
    </div>`;
  }).join('');
}

function isHookActivelyRunning(hookState) {
  if (!hookState || !hookState.phase) return false;
  if (Date.now() - (hookState.updatedAt || 0) > 60000) return false;
  return hookState.phase === 'thinking' || hookState.phase === 'running_tool';
}

function connectSSE({ convId = '', previewId = '' } = {}) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  const qs = new URLSearchParams();
  if (convId) qs.set('conv', convId);
  if (previewId) qs.set('preview', previewId);
  if (state.flavor) qs.set('flavor', state.flavor);

  const es = new EventSource(`/api/events?${qs.toString()}`);
  state.eventSource = es;

  es.addEventListener('connected', () => {
    setLiveBadge(t('liveSync'), 'live');
  });

  es.addEventListener('transcript', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.conversationId && data.conversationId === state.activeConvId && state.mode === 'sessions') {
        state.currentViewData = { ...state.currentViewData, ...data };
        applyHookPhase(data.hookState);
        const scrollEl = el('reader-scroll');
        const nearBottom = scrollEl ? (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120) : false;
        transcriptRenderer.render(data.conversationId, data.view, {
          isRunning: isHookActivelyRunning(data.hookState),
          baseDir: state.currentBaseDir,
          subagents: state.currentViewData.subagents || [],
          parentSession: state.currentViewData.parentSession || null,
          cliInsights: state.currentViewData.cliInsights || null,
          artifacts: state.currentViewData.artifacts || [],
        });
        if (state.autoFollow && nearBottom && scrollEl) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
        }
        renderCliToolsDrawer();
      }
    } catch {}
  });

  es.addEventListener('btw-updated', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.conversationId === state.activeConvId && state.currentViewData?.cliInsights) {
        state.currentViewData.cliInsights.btwNotes = data.btwNotes || [];
        renderCliToolsDrawer();
      }
    } catch {}
  });

  es.addEventListener('hook', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.conversationId === state.activeConvId) {
        applyHookPhase(data.hookState);
        if (state.currentViewData?.view) {
          transcriptRenderer.render(state.activeConvId, state.currentViewData.view, {
            isRunning: isHookActivelyRunning(data.hookState),
            baseDir: state.currentBaseDir,
            subagents: state.currentViewData.subagents || [],
            parentSession: state.currentViewData.parentSession || null,
            cliInsights: state.currentViewData.cliInsights || null,
            artifacts: state.currentViewData.artifacts || [],
          });
        }
      }
    } catch {}
  });

  es.addEventListener('custom-preview', (ev) => {
    try {
      const doc = JSON.parse(ev.data);
      loadCustomPreviews();
      if (doc.id === state.activePreviewId && state.mode === 'docs') {
        renderCustomPreview(doc);
      }
    } catch {}
  });

  es.addEventListener('focus', (ev) => {
    try {
      const target = JSON.parse(ev.data);
      if (target.previewId) {
        openCustomPreview(target.previewId);
      } else if (target.conversationId) {
        if (target.flavor) state.flavor = target.flavor;
        openConversation(target.conversationId);
      }
    } catch {}
  });

  es.onerror = () => {
    setLiveBadge(t('reconnecting'), 'idle');
  };
}

function applyHookPhase(hookState) {
  if (!hookState || !hookState.phase) {
    setLiveBadge(t('liveSync'), 'live');
    return;
  }
  const ageMs = Date.now() - (hookState.updatedAt || 0);
  if (ageMs > 60000 && hookState.phase !== 'stopped') {
    setLiveBadge(t('liveSync'), 'live');
    return;
  }
  if (hookState.phase === 'thinking') {
    setLiveBadge(t('thinkingPhase'), 'active');
  } else if (hookState.phase === 'running_tool') {
    setLiveBadge(t('runningToolPhase', { tool: hookState.toolName || 'tool' }), 'active');
  } else if (hookState.phase === 'tool_done') {
    setLiveBadge(t('toolDonePhase', { tool: hookState.toolName || 'tool' }), 'live');
  } else {
    setLiveBadge(t('liveSync'), 'live');
  }
}

function syncUrlState(paramsObj) {
  if (isSidecar || window.location.protocol === 'plugin:') return;
  try {
    const qs = new URLSearchParams(paramsObj);
    window.history.replaceState(null, '', `${window.location.pathname}?${qs.toString()}`);
  } catch {}
}

function scrollToLastUserTurn() {
  requestAnimationFrame(() => {
    const column = el('reader-column');
    const turns = column?.querySelectorAll('.turn-block');
    if (!turns || turns.length === 0) return;
    let target = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      const uc = turns[i].querySelector('.user-card');
      if (uc) {
        target = uc;
        break;
      }
    }
    (target || turns[turns.length - 1])?.scrollIntoView({ behavior: 'instant', block: 'start' });
  });
}

async function revealInFolder(rawPath, baseDir = '') {
  if (!rawPath) return;
  try {
    const res = await apiFetch('/api/reveal-in-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: rawPath, base: baseDir || state.currentBaseDir || '' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Failed to open containing folder');
    }
  } catch {}
}

async function openConversation(convId, { scrollToLatestUser = true } = {}) {
  state.mode = 'sessions';
  state.activeConvId = convId;
  localStorage.setItem('amp-mode', 'sessions');
  localStorage.setItem('amp-last-conv', convId);
  syncUrlState({ conv: convId, flavor: state.flavor });
  updateModeButtons();

  const meta = state.conversations.find((c) => c.id === convId);
  el('doc-title').textContent = meta?.title || `Session ${convId.slice(0, 8)}`;
  renderSidebarList();

  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(convId)}/view?flavor=${encodeURIComponent(state.flavor)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.currentViewData = data;
    state.currentBaseDir = data.baseDir || meta?.workspaceUri || '';
    if (data.flavor) state.flavor = data.flavor;
    if (meta?.title) el('doc-title').textContent = meta.title;
    applyHookPhase(data.hookState);
    transcriptRenderer.render(convId, data.view, {
      isRunning: isHookActivelyRunning(data.hookState),
      baseDir: state.currentBaseDir,
      subagents: data.subagents || [],
      parentSession: data.parentSession || null,
      cliInsights: data.cliInsights || null,
      artifacts: data.artifacts || [],
    });
    if (scrollToLatestUser) {
      scrollToLastUserTurn();
    }
    renderCliToolsDrawer();
    connectSSE({ convId });
  } catch (err) {
    el('reader-column').innerHTML = `<div class="notice-banner error">Failed to load conversation: ${escapeHtml(err.message)}</div>`;
  }
}

function renderCustomPreview(doc) {
  state.currentCustomDoc = doc;
  state.currentBaseDir = doc.baseDir || '';
  el('doc-title').textContent = doc.title || 'Markdown Preview';
  const column = el('reader-column');

  if (doc.parsed?.mode === 'transcript' && doc.parsed.view) {
    transcriptRenderer.render(doc.id, doc.parsed.view, { baseDir: state.currentBaseDir });
    return;
  }

  column.innerHTML = '';

  const baseBanner = document.createElement('div');
  baseBanner.className = 'session-ribbon';
  baseBanner.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
      <span style="font-weight:600;flex-shrink:0;">${escapeHtml(t('baseDirLabel'))}</span>
      <input id="doc-basedir-input" class="input-sm" type="text" value="${escapeHtml(state.currentBaseDir)}" placeholder="${escapeHtml(t('baseDirPlaceholder'))}" style="flex:1;">
      <button id="doc-basedir-apply" class="code-mini-btn" type="button">${escapeHtml(t('applyBtn'))}</button>
      ${(doc.filePath || state.currentBaseDir) ? `<button id="doc-basedir-reveal" class="code-mini-btn" type="button" title="${escapeHtml(t('openFolderTip'))}">${escapeHtml(t('openFolderBtn'))}</button>` : ''}
    </div>
  `;
  baseBanner.querySelector('#doc-basedir-reveal')?.addEventListener('click', () => {
    revealInFolder(doc.filePath || state.currentBaseDir);
  });
  baseBanner.querySelector('#doc-basedir-apply')?.addEventListener('click', async () => {
    const newBase = baseBanner.querySelector('#doc-basedir-input')?.value.trim() || '';
    const res = await apiFetch(`/api/previews/${encodeURIComponent(doc.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseDir: newBase }),
    });
    if (res.ok) {
      const updated = await res.json();
      await loadCustomPreviews();
      renderCustomPreview(updated);
    }
  });
  column.appendChild(baseBanner);

  const container = document.createElement('article');
  container.className = 'assistant-markdown';

  let md = doc.parsed?.markdown ?? doc.rawText ?? '';
  const thinkBlocks = [];
  md = md.replace(/<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
    const idx = thinkBlocks.length;
    thinkBlocks.push(inner.trim());
    return `\n\n<div data-think-slot="${idx}"></div>\n\n`;
  });

  container.innerHTML = renderMarkdownHtml(md, { baseDir: state.currentBaseDir });

  container.querySelectorAll('[data-think-slot]').forEach((slot) => {
    const text = thinkBlocks[Number(slot.dataset.thinkSlot)] || '';
    const details = document.createElement('details');
    details.className = 'disclosure-card thinking-card';
    details.innerHTML = `<summary class="disclosure-trigger" style="list-style:none;">
      <span class="thinking-label">${escapeHtml(t('thoughtLabel'))}</span>
      <span class="thinking-preview">${escapeHtml(text.split(/\r?\n/)[0] || '')}</span>
    </summary><div class="thinking-body assistant-markdown" style="display:block;">${renderMarkdownHtml(text, { baseDir: state.currentBaseDir })}</div>`;
    slot.replaceWith(details);
  });

  enhanceMarkdownDom(container, resolvedTheme());
  column.appendChild(container);

  const toc = [];
  let hIdx = 0;
  container.querySelectorAll('h1, h2, h3').forEach((h) => {
    if (!h.id) h.id = `md-hd-${++hIdx}`;
    const txt = h.textContent.trim();
    toc.push({ id: h.id, label: txt, fullTitle: txt, level: Number(h.tagName.slice(1)), isTurn: false });
  });
  renderToc(toc);
}

async function openCustomPreview(previewId) {
  state.mode = 'docs';
  state.activePreviewId = previewId;
  localStorage.setItem('amp-mode', 'docs');
  localStorage.setItem('amp-last-preview', previewId);
  syncUrlState({ preview: previewId });
  updateModeButtons();
  renderSidebarList();

  try {
    const res = await apiFetch(`/api/previews/${encodeURIComponent(previewId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    renderCustomPreview(doc);
    connectSSE({ previewId });
  } catch (err) {
    el('reader-column').innerHTML = `<div class="notice-banner error">Failed to load preview: ${escapeHtml(err.message)}</div>`;
  }
}

/* -------------------------------------------------------------------------
 * Shared File Content Renderer (used by BOTH Popup Modal & Side Preview Pane)
 * ------------------------------------------------------------------------- */

function parseLineRangeHash(hashStr) {
  if (!hashStr) return null;
  const m = hashStr.match(/^L(\d+)(?:-L?(\d+))?$/i);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function renderCodeWithLineNumbers(content, lang, lineRange, viewId = 'side-code-view') {
  let highlightedLines;
  if (window.hljs && lang && window.hljs.getLanguage(lang)) {
    try {
      const res = window.hljs.highlight(content, { language: lang, ignoreIllegals: true });
      highlightedLines = res.value.split('\n');
    } catch {
      highlightedLines = content.split('\n').map(escapeHtml);
    }
  } else if (window.hljs) {
    try {
      const res = window.hljs.highlightAuto(content.slice(0, 60000));
      highlightedLines = content.length <= 60000 ? res.value.split('\n') : content.split('\n').map(escapeHtml);
    } catch {
      highlightedLines = content.split('\n').map(escapeHtml);
    }
  } else {
    highlightedLines = content.split('\n').map(escapeHtml);
  }

  const rowsHtml = highlightedLines.map((lineHtml, i) => {
    const ln = i + 1;
    const isHit = lineRange && ln >= lineRange.start && ln <= lineRange.end;
    return `<tr class="side-code-row${isHit ? ' highlighted' : ''}" data-ln="${ln}">
      <td class="side-code-ln">${ln}</td>
      <td class="side-code-line-text">${lineHtml || ' '}</td>
    </tr>`;
  }).join('');

  return `<div id="${viewId}" class="side-code-view"><table class="side-code-table"><tbody>${rowsHtml}</tbody></table></div>`;
}

function populatePreviewBody(bodyEl, info, codeViewId) {
  if (info.kind === 'image') {
    bodyEl.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
      <img src="${escapeHtml(info.rawUrl)}" alt="${escapeHtml(info.filename)}" class="md-image" data-zoomable="true" style="max-height:74vh;">
      <span style="font-size:0.75rem;color:var(--text-faint);">${(info.size / 1024).toFixed(1)} KB</span>
    </div>`;
    return;
  }

  if (info.kind === 'markdown') {
    const article = document.createElement('article');
    article.className = 'assistant-markdown';
    article.innerHTML = renderMarkdownHtml(info.content || '', { baseDir: info.baseDir });
    enhanceMarkdownDom(article, resolvedTheme());
    bodyEl.innerHTML = '';
    bodyEl.appendChild(article);
    bodyEl.scrollTop = 0;

    if (info.hash) {
      const decoded = decodeURIComponent(info.hash);
      const target = article.querySelector(`#${CSS.escape(decoded)}`) || article.querySelector(`#${CSS.escape(slugifyHeading(decoded))}`);
      requestAnimationFrame(() => target?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
    return;
  }

  if (info.kind === 'code') {
    const lineRange = parseLineRangeHash(info.hash);
    bodyEl.innerHTML = renderCodeWithLineNumbers(info.content || '', info.lang, lineRange, codeViewId);
    if (lineRange) {
      requestAnimationFrame(() => {
        const firstHit = bodyEl.querySelector(`.side-code-row[data-ln="${lineRange.start}"]`);
        firstHit?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    } else {
      bodyEl.scrollTop = 0;
    }
    return;
  }

  bodyEl.innerHTML = `<div class="notice-banner" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
    <span>${escapeHtml(t('binaryFileNotice', { size: (info.size / 1024).toFixed(1) }))} <code>${escapeHtml(info.path)}</code></span>
    <button type="button" class="code-mini-btn" data-reveal-path="${escapeHtml(info.path)}" title="${escapeHtml(t('openFolderTip'))}">${escapeHtml(t('openFolderBtn'))}</button>
  </div>`;
  bodyEl.querySelector('[data-reveal-path]')?.addEventListener('click', () => revealInFolder(info.path));
}

async function fetchFileInfo(rawHref, baseDir) {
  const effectiveBase = baseDir || state.currentBaseDir || '';
  const qs = new URLSearchParams({ path: rawHref });
  if (effectiveBase) qs.set('base', effectiveBase);
  const res = await apiFetch(`/api/file-info?${qs.toString()}`);
  const info = await res.json();
  if (!res.ok) {
    throw new Error(info.error || `Failed to open (${res.status})`);
  }
  return info;
}

/* 1. Popup Preview Modal (triggered by clicking hyperlinks directly) */
async function openInPopupModal(rawHref, baseDir = '') {
  const modal = el('file-preview-modal');
  const body = el('popup-preview-body');
  if (!modal || !body) return;

  modal.classList.remove('hidden');
  el('popup-preview-title').textContent = rawHref.split(/[\\/]/).pop() || t('loadingPreview');
  el('popup-preview-path').textContent = rawHref;
  body.innerHTML = `<div style="color:var(--text-faint);font-size:0.82rem;">${escapeHtml(t('loadingPreview'))}</div>`;

  try {
    const info = await fetchFileInfo(rawHref, baseDir);
    state.popupCurrent = { ...info, rawHref };
    el('popup-preview-title').textContent = info.filename;
    el('popup-preview-path').textContent = info.path + (info.hash ? `#${info.hash}` : '');
    el('popup-wrap-btn')?.classList.toggle('hidden', info.kind !== 'code');
    populatePreviewBody(body, info, 'popup-code-view');
  } catch (err) {
    body.innerHTML = `<div class="notice-banner error">${escapeHtml(err.message)}</div>`;
  }
}

/* 2. Right Split Side Preview Pane (triggered by [Open in sidebar]) */
function updateSideNavButtons() {
  const backBtn = el('side-back-btn');
  const fwdBtn = el('side-fwd-btn');
  if (backBtn) backBtn.disabled = state.sideHistoryIdx <= 0;
  if (fwdBtn) fwdBtn.disabled = state.sideHistoryIdx >= state.sideHistory.length - 1;
}

async function openInSidePreview(rawHref, baseDir = '', { pushHistory = true } = {}) {
  const pane = el('side-preview-pane');
  const resizer = el('side-resizer');
  const body = el('side-preview-body');
  if (!pane || !body) return;

  pane.classList.remove('hidden');
  resizer?.classList.remove('hidden');
  el('side-preview-title').textContent = rawHref.split(/[\\/]/).pop() || t('loadingPreview');
  el('side-preview-path').textContent = rawHref;
  body.innerHTML = `<div style="color:var(--text-faint);font-size:0.82rem;">${escapeHtml(t('loadingPreview'))}</div>`;

  try {
    const info = await fetchFileInfo(rawHref, baseDir);
    state.sideCurrent = info;
    if (pushHistory) {
      state.sideHistory = state.sideHistory.slice(0, state.sideHistoryIdx + 1);
      state.sideHistory.push({ rawHref: info.path + (info.hash ? `#${info.hash}` : ''), baseDir: info.baseDir });
      state.sideHistoryIdx = state.sideHistory.length - 1;
    }
    updateSideNavButtons();

    el('side-preview-title').textContent = info.filename;
    el('side-preview-path').textContent = info.path;
    el('side-preview-path').title = info.path;

    el('side-promote-btn')?.classList.toggle('hidden', info.kind !== 'markdown');
    el('side-wrap-btn')?.classList.toggle('hidden', info.kind !== 'code');

    populatePreviewBody(body, info, 'side-code-view');
  } catch (err) {
    body.innerHTML = `<div class="notice-banner error">${escapeHtml(err.message)}</div>`;
  }
}

function closeSidePreview() {
  el('side-preview-pane')?.classList.add('hidden');
  el('side-resizer')?.classList.add('hidden');
  state.sideCurrent = null;
}

function openZoomImage(src, alt) {
  const modal = el('image-modal');
  const img = el('image-modal-img');
  const cap = el('image-modal-caption');
  if (!modal || !img) return;
  img.src = src;
  img.alt = alt || '';
  if (cap) cap.textContent = alt || '';
  modal.classList.remove('hidden');
}

function fitMermaidModalToScreen() {
  const viewport = el('mermaid-modal-viewport');
  const svg = el('mermaid-modal-canvas')?.querySelector('svg');
  const ctrl = viewport?._panZoomCtrl;
  if (!viewport || !svg || !ctrl) return;
  const vRect = viewport.getBoundingClientRect();
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const natW = vb.length === 4 && vb[2] > 0 ? vb[2] : (svg.clientWidth || 600);
  const natH = vb.length === 4 && vb[3] > 0 ? vb[3] : (svg.clientHeight || 600);
  const fitScale = Math.min(1.5, (vRect.width - 56) / natW, (vRect.height - 56) / natH);
  ctrl.setTransform(fitScale, 0, 0);
}

function openFullscreenMermaid(svgEl) {
  const modal = el('mermaid-modal');
  const viewport = el('mermaid-modal-viewport');
  const canvas = el('mermaid-modal-canvas');
  const resetBtn = el('mmd-modal-zoom-reset');
  if (!modal || !viewport || !canvas || !svgEl) return;

  const cloned = svgEl.cloneNode(true);
  cloned.style.maxWidth = 'none';
  cloned.style.maxHeight = 'none';
  const vb = cloned.getAttribute('viewBox');
  let natW = 700;
  let natH = 500;
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0) {
      natW = parts[2];
      natH = parts[3];
      cloned.style.width = `${natW}px`;
      cloned.style.height = `${natH}px`;
    }
  }
  canvas.innerHTML = '';
  canvas.appendChild(cloned);
  modal.classList.remove('hidden');

  const ctrl = bindPanZoomViewport(viewport, canvas, {
    wheelRequiresModifier: false,
    onScaleChange: (s) => {
      if (resetBtn) resetBtn.textContent = `${Math.round(s * 100)}%`;
    },
  });

  requestAnimationFrame(() => {
    const vRect = viewport.getBoundingClientRect();
    // Start fitted cleanly inside the big screen if oversized, or 100% if already comfortable
    const fitScale = Math.min(1.15, (vRect.width - 64) / natW, (vRect.height - 64) / natH);
    ctrl?.setTransform(fitScale, 0, 0);
  });
}

function renderToolsMenu() {
  const menu = el('tools-menu');
  const toolsBtn = el('tools-btn');
  if (!menu) return;
  const view = state.currentViewData?.view;
  const cli = state.currentViewData?.cliInsights;
  const s = view?.summary || {};
  const ctxPct = s.contextWindow?.limit ? `${((s.contextWindow.usageRatio || 0) * 100).toFixed(1)}%` : '';
  const btwCount = ((cli?.btwCommands || []).filter((c) => c.isQuery).length) +
    ((cli?.btwNotes || []).filter((n) => !(cli?.btwCommands || []).some((c) => c.question === n.question)).length);
  const totalTok = (s.totalInputTokens || 0) + (s.totalCacheReadTokens || 0) + (s.totalOutputTokens || 0);

  const items = [
    { id: 'btw', cmd: '/btw', desc: t('cmdBtwDesc'), badge: btwCount > 0 ? String(btwCount) : '' },
    { id: 'context', cmd: '/context', desc: t('cmdContextDesc'), badge: ctxPct },
    { id: 'usage', cmd: '/usage', desc: t('cmdUsageDesc'), badge: totalTok > 0 ? formatCompactTokens(totalTok) : '' },
  ];

  menu.innerHTML = `
    <div class="theme-menu-section-label">${escapeHtml(t('secSessionCmds'))}</div>
    ${items.map((it) => {
      const active = state.activeCliToolTab === it.id;
      return `<button type="button" class="theme-menu-item ${active ? 'active' : ''}" data-open-cli-tool="${it.id}">
        <span class="theme-menu-item-left">
          <code style="font-size:0.75rem;">${it.cmd}</code>
          <span style="font-size:0.74rem;color:var(--text-muted);">${escapeHtml(it.desc)}</span>
        </span>
        <span style="font-size:0.71rem;color:var(--text-faint);font-family:var(--font-mono);">${escapeHtml(it.badge)}</span>
      </button>`;
    }).join('')}
  `;

  if (toolsBtn) {
    toolsBtn.classList.toggle('active', Boolean(state.activeCliToolTab));
  }
}

function renderCliToolsDrawer() {
  const drawer = el('cli-tools-drawer');
  renderToolsMenu();
  if (!drawer) return;
  if (state.mode !== 'sessions' || !state.activeCliToolTab || !state.currentViewData?.view) {
    drawer.classList.add('hidden');
    return;
  }

  drawer.classList.remove('hidden');
  const tab = state.activeCliToolTab;
  const bodyHtml = renderCliInsightsHtml(
    tab,
    state.currentViewData.view,
    state.currentViewData.cliInsights,
    state.currentViewData.artifacts,
    state.currentBaseDir
  );

  drawer.innerHTML = `
    <div class="cli-tools-drawer-inner">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:6px;border-bottom:1px solid var(--border);">
        <div class="cli-insights-tabs">
          <button type="button" class="cli-tab-btn ${tab === 'btw' ? 'active' : ''}" data-drawer-cli-tab="btw">/btw</button>
          <button type="button" class="cli-tab-btn ${tab === 'context' ? 'active' : ''}" data-drawer-cli-tab="context">/context</button>
          <button type="button" class="cli-tab-btn ${tab === 'usage' ? 'active' : ''}" data-drawer-cli-tab="usage">/usage</button>
        </div>
        <button type="button" class="icon-btn sm" data-close-cli-drawer title="Close tools panel (Esc)">✕</button>
      </div>
      ${bodyHtml}
    </div>
  `;
  enhanceMarkdownDom(drawer, resolvedTheme());
}

function updateModeButtons() {
  const isSessions = state.mode === 'sessions';
  el('mode-sessions-btn')?.classList.toggle('active', isSessions);
  el('mode-docs-btn')?.classList.toggle('active', !isSessions);
  el('flavor-controls-row')?.classList.toggle('hidden', !isSessions);
  el('docs-controls-row')?.classList.toggle('hidden', isSessions);
  el('tools-dropdown-wrap')?.classList.toggle('hidden', !isSessions);
  if (!isSessions) {
    el('cli-tools-drawer')?.classList.add('hidden');
  } else {
    renderCliToolsDrawer();
  }
}

function exportCurrentMarkdown() {
  let mdOut = '';
  let filename = 'antigravity-preview.md';

  if (state.mode === 'docs' && state.currentCustomDoc) {
    mdOut = state.currentCustomDoc.rawText || '';
    filename = `${(state.currentCustomDoc.title || 'preview').replace(/[^a-zA-Z0-9._-]+/g, '_')}.md`;
  } else if (state.currentViewData?.view?.turns) {
    const title = el('doc-title')?.textContent || 'Conversation';
    filename = `${title.slice(0, 40).replace(/[^a-zA-Z0-9._-]+/g, '_')}.md`;
    const chunks = [`# ${title}\n`];
    for (const turn of state.currentViewData.view.turns) {
      if (turn.user?.request) {
        chunks.push(`## Turn ${turn.index} — User\n\n${turn.user.request}\n`);
      }
      for (const item of turn.items) {
        if (item.kind === 'markdown' && !item.intermediate) {
          chunks.push(`${item.text}\n`);
        } else if (item.kind === 'thinking') {
          chunks.push(`<details>\n<summary>Thought (${item.wordCount} words)</summary>\n\n${item.text}\n\n</details>\n`);
        } else if (item.kind === 'tool_group') {
          const names = item.tools.map((t) => `- \`${t.name}\` ${t.summary || ''}`).join('\n');
          chunks.push(`<details>\n<summary>Tools (${item.tools.length})</summary>\n\n${names}\n\n</details>\n`);
        }
      }
    }
    mdOut = chunks.join('\n');
  }

  if (!mdOut) return;
  const blob = new Blob([mdOut], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearFindHighlights() {
  el('reader-column')?.querySelectorAll('mark.find-hit').forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent));
  });
  state.findHits = [];
  state.findIndex = -1;
  if (el('find-count')) el('find-count').textContent = '';
}

function runFindInPage(query) {
  clearFindHighlights();
  if (!query || query.length < 2) return;
  if (state.mode === 'sessions') {
    transcriptRenderer?.expandWindowForSearch();
  }
  const root = el('reader-column');
  if (!root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const matches = [];
  const lowerQ = query.toLowerCase();
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.parentElement) continue;
    if (node.parentElement.closest('script, style, .katex')) continue;
    const idx = node.nodeValue.toLowerCase().indexOf(lowerQ);
    if (idx !== -1) matches.push({ node, idx });
  }

  for (const { node: textNode, idx } of matches.slice(0, 250)) {
    const val = textNode.nodeValue;
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(val.slice(0, idx)));
    const mark = document.createElement('mark');
    mark.className = 'find-hit';
    mark.textContent = val.slice(idx, idx + query.length);
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(val.slice(idx + query.length)));
    textNode.replaceWith(frag);
    state.findHits.push(mark);
  }

  if (state.findHits.length > 0) {
    jumpToFindHit(0);
  } else if (el('find-count')) {
    el('find-count').textContent = '0 matches';
  }
}

function jumpToFindHit(nextIdx) {
  if (!state.findHits.length) return;
  state.findHits.forEach((h) => h.classList.remove('current'));
  state.findIndex = (nextIdx + state.findHits.length) % state.findHits.length;
  const hit = state.findHits[state.findIndex];
  hit.classList.add('current');
  let collapsed = hit.closest('[data-open="false"]');
  while (collapsed) {
    collapsed.dataset.open = 'true';
    collapsed = collapsed.parentElement?.closest('[data-open="false"]');
  }
  hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (el('find-count')) {
    el('find-count').textContent = `${state.findIndex + 1} / ${state.findHits.length}`;
  }
}

async function manualSync() {
  const btn = el('sync-btn');
  if (btn) btn.textContent = t('syncingBtn');
  await loadConversations();
  await loadCustomPreviews();
  if (state.mode === 'sessions' && state.activeConvId) {
    await openConversation(state.activeConvId, { scrollToLatestUser: false });
  } else if (state.mode === 'docs' && state.activePreviewId) {
    await openCustomPreview(state.activePreviewId);
  }
  if (btn) btn.textContent = t('syncBtn');
}

async function submitCustomPreview({ id, title, content, mode, filePath, droppedFilename, baseDir }) {
  const res = await apiFetch('/api/previews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title, content, mode, filePath, droppedFilename, baseDir }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed' }));
    alert(err.error || 'Failed to render preview');
    return;
  }
  const doc = await res.json();
  await loadCustomPreviews();
  await openCustomPreview(doc.id);
}

async function pickNativeFile() {
  try {
    const res = await apiFetch('/api/pick-file', { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.canceled && data.entry) {
      el('paste-modal')?.classList.add('hidden');
      await loadCustomPreviews();
      await openCustomPreview(data.entry.id);
    }
  } catch {}
}

function initSidePaneResizer() {
  const resizer = el('side-resizer');
  if (!resizer) return;
  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const tocEl = el('toc-drawer');
    const tocW = tocEl && !tocEl.classList.contains('hidden') ? tocEl.offsetWidth : 0;
    const newW = Math.max(300, Math.min(window.innerWidth * 0.65, window.innerWidth - e.clientX - tocW));
    document.documentElement.style.setProperty('--side-preview-width', `${Math.round(newW)}px`);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

async function commitDocRename(docId, newTitle) {
  state.renamingDocId = null;
  if (newTitle && newTitle.trim()) {
    await apiFetch(`/api/previews/${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() }),
    });
    await loadCustomPreviews();
    if (state.activePreviewId === docId) {
      el('doc-title').textContent = newTitle.trim();
    }
  } else {
    renderSidebarList();
  }
}

async function bootstrap() {
  setLang(getLang());
  applyStaticI18n();
  applyAppearance();
  const initManageBtn = el('docs-manage-btn');
  if (initManageBtn) initManageBtn.textContent = t('manageBtn');

  transcriptRenderer = new TranscriptRenderer(el('reader-column'), {
    theme: resolvedTheme(),
    onLoadFullStep: async (stepIdx) => {
      if (!state.activeConvId) return null;
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(state.activeConvId)}/steps/${stepIdx}?flavor=${encodeURIComponent(state.flavor)}`);
      return res.ok ? res.json() : null;
    },
    onSaveBtwNote: async (question, answer) => {
      if (!state.activeConvId) return;
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(state.activeConvId)}/btw-notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer }),
      });
      if (res.ok) {
        const out = await res.json();
        if (state.currentViewData?.cliInsights) {
          state.currentViewData.cliInsights.btwNotes = out.notes || [];
          transcriptRenderer._rerenderCurrent();
        }
      }
    },
    onDeleteBtwNote: async (noteId) => {
      if (!state.activeConvId || !noteId) return;
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(state.activeConvId)}/btw-notes/${encodeURIComponent(noteId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const out = await res.json();
        if (state.currentViewData?.cliInsights) {
          state.currentViewData.cliInsights.btwNotes = out.notes || [];
          transcriptRenderer._rerenderCurrent();
        }
      }
    },
    onTocChanged: renderToc,
  });

  const mdCallbacks = {
    onOpenLocalLink: (rawHref, baseDir, previewMode = 'popup') => {
      if (previewMode === 'sidebar') {
        el('file-preview-modal')?.classList.add('hidden');
        openInSidePreview(rawHref, baseDir);
      } else {
        openInPopupModal(rawHref, baseDir);
      }
    },
    onOpenConversation: (convId) => {
      if (convId) {
        el('file-preview-modal')?.classList.add('hidden');
        openConversation(convId);
      }
    },
    onZoomImage: openZoomImage,
    onFullscreenMermaid: openFullscreenMermaid,
  };
  attachCodeCardInteractions(el('reader-column'), mdCallbacks);
  attachCodeCardInteractions(el('side-preview-body'), mdCallbacks);
  attachCodeCardInteractions(el('popup-preview-body'), mdCallbacks);
  attachCodeCardInteractions(el('cli-tools-drawer'), mdCallbacks);
  initSidePaneResizer();

  // Sidebar & Toolbar listeners
  el('sidebar-toggle-btn')?.addEventListener('click', () => {
    hideDocHoverPopover();
    el('sidebar')?.classList.toggle('collapsed');
  });

  el('toc-toggle-btn')?.addEventListener('click', () => {
    const drawer = el('toc-drawer');
    if (!drawer) return;
    const hidden = drawer.classList.toggle('hidden');
    el('toc-toggle-btn')?.classList.toggle('active', !hidden);
  });

  el('mode-sessions-btn')?.addEventListener('click', () => {
    state.mode = 'sessions';
    updateModeButtons();
    renderSidebarList();
    if (state.activeConvId) openConversation(state.activeConvId);
  });

  el('mode-docs-btn')?.addEventListener('click', () => {
    state.mode = 'docs';
    localStorage.setItem('amp-mode', 'docs');
    updateModeButtons();
    renderSidebarList();
    const validTarget = state.customPreviews.find((d) => d.id === state.activePreviewId)?.id || state.customPreviews[0]?.id || '';
    if (validTarget) {
      openCustomPreview(validTarget);
    } else {
      syncUrlState({ mode: 'docs' });
      el('doc-title').textContent = t('tabDocs');
      el('reader-column').innerHTML = `<div class="empty-state"><strong>${escapeHtml(t('docsEmptyTitle'))}</strong><span>${t('docsEmptyHint')}</span></div>`;
      renderToc([]);
    }
  });

  el('docs-browse-btn')?.addEventListener('click', pickNativeFile);
  el('paste-browse-btn')?.addEventListener('click', pickNativeFile);

  el('docs-manage-btn')?.addEventListener('click', () => {
    state.docsManageMode = !state.docsManageMode;
    state.renamingDocId = null;
    const btn = el('docs-manage-btn');
    if (btn) {
      btn.textContent = state.docsManageMode ? t('manageDoneBtn') : t('manageBtn');
      btn.classList.toggle('active', state.docsManageMode);
    }
    renderSidebarList();
  });

  el('flavor-select')?.addEventListener('change', (e) => {
    state.flavor = e.target.value;
    localStorage.setItem('amp-flavor', state.flavor);
    loadConversations();
  });

  el('sidebar-search')?.addEventListener('input', renderSidebarList);

  const sessionListEl = el('session-list');

  // Docs Hover Popover listeners
  sessionListEl?.addEventListener('mouseover', (e) => {
    if (state.mode !== 'docs' || state.docsManageMode) return;
    const card = e.target.closest('[data-doc-card]');
    if (!card) return;
    const docId = card.dataset.docCard;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showDocHoverPopover(docId, card), 170);
  });
  sessionListEl?.addEventListener('mouseout', (e) => {
    if (state.mode !== 'docs') return;
    const related = e.relatedTarget;
    if (related && e.target.closest('[data-doc-card]') === related.closest?.('[data-doc-card]')) return;
    hideDocHoverPopover();
  });
  sessionListEl?.addEventListener('scroll', hideDocHoverPopover);

  // Docs Drag-and-Drop Reorder listeners
  sessionListEl?.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-doc-card]');
    if (!card || !state.docsManageMode) return;
    state.dragDocId = card.dataset.docCard;
    e.dataTransfer.effectAllowed = 'move';
  });
  sessionListEl?.addEventListener('dragover', (e) => {
    if (!state.dragDocId || !state.docsManageMode) return;
    const card = e.target.closest('[data-doc-card]');
    if (!card || card.dataset.docCard === state.dragDocId) return;
    e.preventDefault();
    sessionListEl.querySelectorAll('.doc-item-card.drag-over').forEach((n) => n.classList.remove('drag-over'));
    card.classList.add('drag-over');
  });
  sessionListEl?.addEventListener('dragleave', (e) => {
    e.target.closest?.('.doc-item-card')?.classList.remove('drag-over');
  });
  sessionListEl?.addEventListener('drop', async (e) => {
    if (!state.dragDocId || !state.docsManageMode) return;
    e.preventDefault();
    e.stopPropagation();
    sessionListEl.querySelectorAll('.doc-item-card.drag-over').forEach((n) => n.classList.remove('drag-over'));
    const targetCard = e.target.closest('[data-doc-card]');
    const fromId = state.dragDocId;
    state.dragDocId = null;
    if (!targetCard || targetCard.dataset.docCard === fromId) return;

    const ids = state.customPreviews.map((d) => d.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(targetCard.dataset.docCard);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, fromId);

    const res = await apiFetch('/api/previews/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ids }),
    });
    if (res.ok) {
      const data = await res.json();
      state.customPreviews = data.previews || state.customPreviews;
      renderSidebarList();
    }
  });
  sessionListEl?.addEventListener('dragend', () => {
    state.dragDocId = null;
    sessionListEl.querySelectorAll('.doc-item-card.drag-over').forEach((n) => n.classList.remove('drag-over'));
  });

  // Inline rename input commit/cancel
  sessionListEl?.addEventListener('keydown', (e) => {
    const inp = e.target.closest('[data-rename-input]');
    if (!inp) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDocRename(inp.dataset.renameInput, inp.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      state.renamingDocId = null;
      renderSidebarList();
    }
  });
  sessionListEl?.addEventListener('focusout', (e) => {
    const inp = e.target.closest('[data-rename-input]');
    if (!inp) return;
    const id = inp.dataset.renameInput;
    if (state.renamingDocId === id) {
      commitDocRename(id, inp.value);
    }
  });

  sessionListEl?.addEventListener('click', async (e) => {
    if (e.target.closest('[data-rename-input]')) return;

    const renameBtn = e.target.closest('[data-doc-rename]');
    if (renameBtn) {
      e.stopPropagation();
      state.renamingDocId = renameBtn.dataset.docRename;
      renderSidebarList();
      return;
    }

    const deleteBtn = e.target.closest('[data-doc-delete]');
    if (deleteBtn) {
      e.stopPropagation();
      const delId = deleteBtn.dataset.docDelete;
      await apiFetch(`/api/previews/${encodeURIComponent(delId)}`, { method: 'DELETE' });
      await loadCustomPreviews();
      if (state.activePreviewId === delId) {
        state.activePreviewId = null;
        if (state.customPreviews.length > 0) {
          openCustomPreview(state.customPreviews[0].id);
        } else {
          state.currentCustomDoc = null;
          el('reader-column').innerHTML = `<div class="empty-state"><strong>${escapeHtml(t('docRemovedTitle'))}</strong><span>${escapeHtml(t('docRemovedHint'))}</span></div>`;
        }
      }
      return;
    }

    const projToggle = e.target.closest('[data-toggle-project]');
    if (projToggle) {
      const key = projToggle.dataset.toggleProject;
      const folderEl = projToggle.closest('.project-folder');
      const currentlyOpen = folderEl?.dataset.open === 'true';
      state.projectExpanded.set(key, !currentlyOpen);
      renderSidebarList();
      return;
    }

    const subToggle = e.target.closest('[data-toggle-subagents]');
    if (subToggle) {
      const subKey = subToggle.dataset.toggleSubagents;
      if (state.expandedSubagentGroups.has(subKey)) state.expandedSubagentGroups.delete(subKey);
      else state.expandedSubagentGroups.add(subKey);
      renderSidebarList();
      return;
    }

    const showOlderBtn = e.target.closest('[data-show-older-project]');
    if (showOlderBtn) {
      state.showOlderInProject.add(showOlderBtn.dataset.showOlderProject);
      renderSidebarList();
      return;
    }

    const convBtn = e.target.closest('[data-conv-id]');
    if (convBtn) {
      openConversation(convBtn.dataset.convId);
      return;
    }
    const prevBtn = e.target.closest('[data-preview-id]');
    if (prevBtn) {
      openCustomPreview(prevBtn.dataset.previewId);
    }
  });

  el('toc-list')?.addEventListener('click', (e) => {
    const link = e.target.closest('[data-target-id]');
    if (!link) return;
    document.getElementById(link.dataset.targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Popup File Preview Modal controls
  el('popup-close-btn')?.addEventListener('click', () => el('file-preview-modal')?.classList.add('hidden'));
  el('file-preview-modal')?.addEventListener('click', (e) => {
    if (e.target === el('file-preview-modal')) el('file-preview-modal')?.classList.add('hidden');
  });
  el('popup-to-sidebar-btn')?.addEventListener('click', () => {
    if (state.popupCurrent) {
      const href = state.popupCurrent.path + (state.popupCurrent.hash ? `#${state.popupCurrent.hash}` : '');
      el('file-preview-modal')?.classList.add('hidden');
      openInSidePreview(href, state.popupCurrent.baseDir);
    }
  });
  el('popup-reveal-btn')?.addEventListener('click', () => {
    if (state.popupCurrent?.path) {
      revealInFolder(state.popupCurrent.path, state.popupCurrent.baseDir);
    }
  });
  el('popup-wrap-btn')?.addEventListener('click', (e) => {
    const view = el('popup-code-view');
    if (!view) return;
    const wrapped = view.classList.toggle('wrapped');
    e.target.textContent = wrapped ? t('unwrapBtn') : t('wrapBtn');
  });
  el('popup-copy-btn')?.addEventListener('click', async (e) => {
    const text = state.popupCurrent?.content || state.popupCurrent?.path || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = t('copiedBtn');
      setTimeout(() => { e.target.textContent = t('copyBtn'); }, 1300);
    } catch {}
  });

  // Side Preview Pane controls
  el('side-close-btn')?.addEventListener('click', closeSidePreview);
  el('side-back-btn')?.addEventListener('click', () => {
    if (state.sideHistoryIdx > 0) {
      state.sideHistoryIdx -= 1;
      const item = state.sideHistory[state.sideHistoryIdx];
      openInSidePreview(item.rawHref, item.baseDir, { pushHistory: false });
    }
  });
  el('side-fwd-btn')?.addEventListener('click', () => {
    if (state.sideHistoryIdx < state.sideHistory.length - 1) {
      state.sideHistoryIdx += 1;
      const item = state.sideHistory[state.sideHistoryIdx];
      openInSidePreview(item.rawHref, item.baseDir, { pushHistory: false });
    }
  });
  el('side-reveal-btn')?.addEventListener('click', () => {
    if (state.sideCurrent?.path) {
      revealInFolder(state.sideCurrent.path, state.sideCurrent.baseDir);
    }
  });
  el('side-wrap-btn')?.addEventListener('click', (e) => {
    const view = el('side-code-view');
    if (!view) return;
    const wrapped = view.classList.toggle('wrapped');
    e.target.textContent = wrapped ? t('unwrapBtn') : t('wrapBtn');
  });
  el('side-copy-btn')?.addEventListener('click', async (e) => {
    const text = state.sideCurrent?.content || state.sideCurrent?.path || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = t('copiedBtn');
      setTimeout(() => { e.target.textContent = t('copyBtn'); }, 1300);
    } catch {}
  });
  el('side-promote-btn')?.addEventListener('click', async () => {
    if (state.sideCurrent?.path) {
      await submitCustomPreview({ filePath: state.sideCurrent.path });
      closeSidePreview();
    }
  });

  el('sync-btn')?.addEventListener('click', manualSync);
  el('export-btn')?.addEventListener('click', exportCurrentMarkdown);

  // Jump to Top & Jump to Bottom buttons
  el('jump-top-btn')?.addEventListener('click', () => {
    el('reader-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  });
  el('jump-bottom-btn')?.addEventListener('click', () => {
    const sc = el('reader-scroll');
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
  });

  // Topbar Tools (/btw, /context, /usage) dropdown & drawer
  el('tools-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    el('prefs-menu')?.classList.add('hidden');
    renderToolsMenu();
    el('tools-menu')?.classList.toggle('hidden');
  });

  el('tools-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.target.closest('[data-open-cli-tool]');
    if (!btn) return;
    const targetTab = btn.dataset.openCliTool;
    state.activeCliToolTab = state.activeCliToolTab === targetTab ? null : targetTab;
    el('tools-menu')?.classList.add('hidden');
    renderCliToolsDrawer();
  });

  el('cli-tools-drawer')?.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-drawer-cli-tab]');
    if (tabBtn) {
      state.activeCliToolTab = tabBtn.dataset.drawerCliTab;
      renderCliToolsDrawer();
      return;
    }
    if (e.target.closest('[data-close-cli-drawer]')) {
      state.activeCliToolTab = null;
      renderCliToolsDrawer();
      return;
    }
    const prefillBtw = e.target.closest('[data-action="prefill-btw-question"]');
    if (prefillBtw) {
      const det = el('cli-tools-drawer')?.querySelector('[data-btw-manual-details]');
      if (det) det.open = true;
      const qIn = el('cli-tools-drawer')?.querySelector('[data-btw-q-input]');
      const aIn = el('cli-tools-drawer')?.querySelector('[data-btw-a-input]');
      if (qIn) qIn.value = prefillBtw.dataset.question || '';
      try {
        const clip = await navigator.clipboard.readText();
        if (clip && aIn && !aIn.value) aIn.value = clip;
      } catch {}
      aIn?.focus();
      return;
    }
    if (e.target.closest('[data-action="paste-clipboard-btw"]')) {
      const aIn = el('cli-tools-drawer')?.querySelector('[data-btw-a-input]');
      try {
        const clip = await navigator.clipboard.readText();
        if (clip && aIn) aIn.value = clip;
      } catch {}
      return;
    }
    if (e.target.closest('[data-action="save-btw-note"]')) {
      const q = el('cli-tools-drawer')?.querySelector('[data-btw-q-input]')?.value || '';
      const a = el('cli-tools-drawer')?.querySelector('[data-btw-a-input]')?.value || '';
      if (a.trim() && state.activeConvId) {
        const res = await apiFetch(`/api/conversations/${encodeURIComponent(state.activeConvId)}/btw-notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, answer: a }),
        });
        if (res.ok) {
          const out = await res.json();
          if (state.currentViewData?.cliInsights) {
            state.currentViewData.cliInsights.btwNotes = out.notes || [];
            renderCliToolsDrawer();
          }
        }
      }
      return;
    }
    const delBtw = e.target.closest('[data-action="delete-btw-note"]');
    if (delBtw && state.activeConvId) {
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(state.activeConvId)}/btw-notes/${encodeURIComponent(delBtw.dataset.noteId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const out = await res.json();
        if (state.currentViewData?.cliInsights) {
          state.currentViewData.cliInsights.btwNotes = out.notes || [];
          renderCliToolsDrawer();
        }
      }
    }
  });

  // Unified Persistent Preferences Dropdown (placed left of Sync)
  el('prefs-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    el('tools-menu')?.classList.add('hidden');
    renderPrefsMenu();
    el('prefs-menu')?.classList.toggle('hidden');
  });

  el('prefs-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const langBtn = e.target.closest('[data-pref-lang]');
    if (langBtn) {
      applyLanguage(langBtn.dataset.prefLang);
      return;
    }
    const proseBtn = e.target.closest('[data-pref-prose]');
    if (proseBtn) {
      state.prose = proseBtn.dataset.prefProse === 'serif' ? 'serif' : 'sans';
      localStorage.setItem('amp-prose', state.prose);
      applyAppearance();
      return;
    }
    const widthBtn = e.target.closest('[data-pref-width]');
    if (widthBtn) {
      state.width = widthBtn.dataset.prefWidth === 'wide' ? 'wide' : 'normal';
      localStorage.setItem('amp-width', state.width);
      applyAppearance();
      return;
    }
    const tablesBtn = e.target.closest('[data-pref-tables]');
    if (tablesBtn) {
      state.tables = tablesBtn.dataset.prefTables === 'expand' ? 'expand' : 'compact';
      localStorage.setItem('amp-tables', state.tables);
      applyAppearance();
      return;
    }
    const modeBtn = e.target.closest('[data-theme-mode]');
    if (modeBtn) {
      state.theme = modeBtn.dataset.themeMode === 'dark' ? 'dark' : 'light';
      localStorage.setItem('amp-theme', state.theme);
      applyAppearance();
      return;
    }
    const palBtn = e.target.closest('[data-theme-palette]');
    if (palBtn) {
      state.palette = palBtn.dataset.themePalette;
      localStorage.setItem('amp-palette', state.palette);
      applyAppearance();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.theme-dropdown-wrap')) {
      el('prefs-menu')?.classList.add('hidden');
      el('tools-menu')?.classList.add('hidden');
    }
  });

  // Find bar
  el('find-toggle-btn')?.addEventListener('click', () => {
    const bar = el('find-bar');
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) el('find-input')?.focus();
    else clearFindHighlights();
  });
  el('find-input')?.addEventListener('input', (e) => runFindInPage(e.target.value));
  el('find-next-btn')?.addEventListener('click', () => jumpToFindHit(state.findIndex + 1));
  el('find-prev-btn')?.addEventListener('click', () => jumpToFindHit(state.findIndex - 1));
  el('find-close-btn')?.addEventListener('click', () => {
    el('find-bar')?.classList.add('hidden');
    clearFindHighlights();
  });

  // Open / Paste modal
  el('paste-open-btn')?.addEventListener('click', () => {
    el('paste-modal')?.classList.remove('hidden');
    el('paste-filepath-input')?.focus();
  });
  el('paste-close-btn')?.addEventListener('click', () => el('paste-modal')?.classList.add('hidden'));
  el('paste-submit-btn')?.addEventListener('click', async () => {
    const pathOrBase = (el('paste-filepath-input')?.value || '').trim().replace(/^["']|["']$/g, '');
    const content = el('paste-textarea')?.value || '';
    const title = el('paste-title-input')?.value.trim() || '';
    const mode = el('paste-mode-select')?.value || 'auto';

    if (!pathOrBase && !content.trim()) return;
    el('paste-modal')?.classList.add('hidden');

    if (!content.trim() && pathOrBase) {
      await submitCustomPreview({ filePath: pathOrBase, title, mode });
    } else {
      await submitCustomPreview({
        title,
        content,
        mode,
        baseDir: pathOrBase || '',
      });
    }
  });

  el('image-modal')?.addEventListener('click', () => el('image-modal')?.classList.add('hidden'));

  // Fullscreen Mermaid Modal controls
  el('mmd-modal-close')?.addEventListener('click', () => el('mermaid-modal')?.classList.add('hidden'));
  el('mermaid-modal')?.addEventListener('click', (e) => {
    if (e.target === el('mermaid-modal')) el('mermaid-modal')?.classList.add('hidden');
  });
  el('mmd-modal-zoom-in')?.addEventListener('click', () => el('mermaid-modal-viewport')?._panZoomCtrl?.zoomBy(1.25));
  el('mmd-modal-zoom-out')?.addEventListener('click', () => el('mermaid-modal-viewport')?._panZoomCtrl?.zoomBy(0.8));
  el('mmd-modal-zoom-reset')?.addEventListener('click', () => el('mermaid-modal-viewport')?._panZoomCtrl?.reset());
  el('mmd-modal-zoom-fit')?.addEventListener('click', fitMermaidModalToScreen);
  el('mmd-modal-download')?.addEventListener('click', () => {
    const svg = el('mermaid-modal-canvas')?.querySelector('svg');
    if (svg) downloadSvgElement(svg, 'mermaid-elk-diagram.svg');
  });

  // External OS File Drag-and-Drop onto window (resolves true source path on disk, NEVER inherits stale baseDir!)
  document.addEventListener('dragover', (e) => {
    if (state.dragDocId) return; // Internal reorder handled by sessionListEl
    e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    if (state.dragDocId) return;
    e.preventDefault();

    // 1. Check if editor/explorer provided file:/// URI directly
    const uriList = (e.dataTransfer?.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    if (uriList && uriList.startsWith('file://')) {
      await submitCustomPreview({ filePath: uriList, mode: 'auto' });
      return;
    }

    // 2. Match dropped file byte-for-byte on disk across workspaces so relative links resolve accurately!
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const text = await file.text();
    await submitCustomPreview({
      title: file.name,
      droppedFilename: file.name,
      content: text,
      mode: 'auto',
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      el('sidebar')?.classList.toggle('collapsed');
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      el('find-bar')?.classList.remove('hidden');
      el('find-input')?.focus();
      return;
    }
    if (e.key === 'Escape') {
      if (!el('prefs-menu')?.classList.contains('hidden') || !el('tools-menu')?.classList.contains('hidden')) {
        el('prefs-menu')?.classList.add('hidden');
        el('tools-menu')?.classList.add('hidden');
        return;
      }
      if (state.activeCliToolTab) {
        state.activeCliToolTab = null;
        renderCliToolsDrawer();
        return;
      }
      if (!el('mermaid-modal')?.classList.contains('hidden')) {
        el('mermaid-modal')?.classList.add('hidden');
        return;
      }
      if (!el('image-modal')?.classList.contains('hidden')) {
        el('image-modal')?.classList.add('hidden');
        return;
      }
      if (!el('file-preview-modal')?.classList.contains('hidden')) {
        el('file-preview-modal')?.classList.add('hidden');
        return;
      }
      if (!el('paste-modal')?.classList.contains('hidden')) {
        el('paste-modal')?.classList.add('hidden');
        return;
      }
      if (!el('find-bar')?.classList.contains('hidden')) {
        el('find-bar')?.classList.add('hidden');
        clearFindHighlights();
        return;
      }
      if (!el('side-preview-pane')?.classList.contains('hidden')) {
        closeSidePreview();
      }
      return;
    }
    if (typing) return;

    const k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); manualSync(); }
    else if (k === 't') {
      e.preventDefault();
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('amp-theme', state.theme);
      applyAppearance();
    }
    else if (k === 'o') { e.preventDefault(); el('toc-toggle-btn')?.click(); }
    else if (k === 'w') {
      e.preventDefault();
      state.width = state.width === 'normal' ? 'wide' : 'normal';
      localStorage.setItem('amp-width', state.width);
      applyAppearance();
    }
    else if (k === 'f') {
      e.preventDefault();
      state.prose = state.prose === 'sans' ? 'serif' : 'sans';
      localStorage.setItem('amp-prose', state.prose);
      applyAppearance();
    }
    else if (k === 'p') { e.preventDefault(); el('paste-open-btn')?.click(); }
    else if (k === '/') {
      e.preventDefault();
      el('find-bar')?.classList.remove('hidden');
      el('find-input')?.focus();
    }
  });

  if (isSidecar) {
    el('sidebar')?.classList.add('collapsed');
    el('toc-drawer')?.classList.add('hidden');
    el('toc-toggle-btn')?.classList.remove('active');
  }

  await loadFlavors();
  await Promise.all([loadConversations(), loadCustomPreviews()]);

  const params = new URLSearchParams(window.location.search);
  const queryConv = params.get('conv') || (isSidecar ? window.sidecar.conversationId : '');
  const queryPreview = params.get('preview');
  const queryMode = params.get('mode');
  const queryFlavor = params.get('flavor');
  if (queryFlavor) state.flavor = queryFlavor;

  const savedMode = localStorage.getItem('amp-mode');
  const savedPreview = localStorage.getItem('amp-last-preview');

  if (queryPreview && state.customPreviews.some((d) => d.id === queryPreview)) {
    await openCustomPreview(queryPreview);
  } else if ((queryMode === 'docs' || (!queryConv && savedMode === 'docs')) && state.customPreviews.length > 0) {
    const targetDoc = state.customPreviews.some((d) => d.id === savedPreview) ? savedPreview : state.customPreviews[0].id;
    await openCustomPreview(targetDoc);
  } else if (queryMode === 'docs') {
    el('mode-docs-btn')?.click();
  } else if (queryConv) {
    await openConversation(queryConv);
  } else if (state.conversations.length > 0) {
    await openConversation(state.conversations[0].id);
  } else if (state.customPreviews.length > 0) {
    await openCustomPreview(state.customPreviews[0].id);
  } else {
    connectSSE();
  }
}

bootstrap();
