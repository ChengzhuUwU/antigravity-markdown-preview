// Lightweight, high-performance Markdown renderer:
// - Block-level memoization keyed by (baseDir, blockText)
// - Relative & local file/image path resolution + "Open in sidebar" pills for code files
// - Safe HTML sanitizer preserving README <img>/<details>/<br>/centered blocks while blocking scripts
// - CJK bold punctuation compatibility + KaTeX math + Obsidian/GitHub callouts + lazy Mermaid

const blockHtmlCache = new Map();
let mermaidLoaderPromise = null;
let mermaidCounter = 0;

const IMAGE_FILE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif',
]);

const DOC_FILE_EXTS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.log', '.rst', '.csv', '.tsv',
]);

const NON_PREVIEWABLE_BINARY_EXTS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.dmg', '.msi',
  '.whl', '.pyc', '.pyo', '.pyd', '.class', '.jar', '.o', '.obj', '.a', '.lib',
  '.pt', '.pth', '.ckpt', '.safetensors', '.onnx', '.trt', '.engine', '.npz', '.npy', '.h5', '.hdf5', '.pkl', '.parquet',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.blend', '.fbx', '.glb', '.gltf', '.usd', '.usda', '.usdc', '.obj', '.stl', '.ply',
]);

const CALLOUT_ICONS = {
  note: '<svg class="callout-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
  tip: '<svg class="callout-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"/></svg>',
  important: '<svg class="callout-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  warning: '<svg class="callout-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  caution: '<svg class="callout-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
};

function getCalloutIconSvg(kind) {
  if (kind === 'tip' || kind === 'success') return CALLOUT_ICONS.tip;
  if (kind === 'important') return CALLOUT_ICONS.important;
  if (kind === 'warning') return CALLOUT_ICONS.warning;
  if (kind === 'caution' || kind === 'error' || kind === 'bug') return CALLOUT_ICONS.caution;
  return CALLOUT_ICONS.note;
}

const CODE_FILE_EXTS = new Set([
  '.py', '.pyi', '.ipynb', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.cu', '.cuh',
  '.rs', '.go', '.java', '.kt', '.kts', '.scala', '.cs', '.swift', '.rb', '.php', '.lua',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.html', '.css', '.scss', '.vue', '.svelte',
  '.sql', '.graphql', '.proto', '.cmake', '.gradle', '.tex', '.bib', '.gitignore',
]);

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugifyHeading(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function isCodeFilePath(rawHref) {
  if (!rawHref || typeof rawHref !== 'string') return false;
  const clean = rawHref.split('#')[0].split('?')[0].trim().toLowerCase();
  const slashIdx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const filename = slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean;
  if (['dockerfile', 'makefile', 'cmakelists.txt'].includes(filename)) return true;
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx === -1) return false;
  return CODE_FILE_EXTS.has(filename.slice(dotIdx));
}

export function isPreviewableFilePath(rawHref) {
  if (!rawHref || typeof rawHref !== 'string') return false;
  const clean = rawHref.split('#')[0].split('?')[0].trim().replace(/[\\/]+$/, '').toLowerCase();
  if (!clean) return false;
  const slashIdx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const filename = slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean;
  if (['dockerfile', 'makefile', 'cmakelists.txt', 'readme', 'license', 'changelog'].includes(filename)) return true;
  const dotIdx = filename.lastIndexOf('.');
  // Extensionless local paths (e.g. `isaacgymenvs` or `docs/`) typically point to directories with README.md
  if (dotIdx === -1) return true;
  const ext = filename.slice(dotIdx);
  if (NON_PREVIEWABLE_BINARY_EXTS.has(ext)) return false;
  return CODE_FILE_EXTS.has(ext) || DOC_FILE_EXTS.has(ext) || IMAGE_FILE_EXTS.has(ext);
}

export function classifyHref(rawHref) {
  if (!rawHref || typeof rawHref !== 'string') return { kind: 'unsafe' };
  const trimmed = rawHref.trim();
  if (!trimmed) return { kind: 'unsafe' };
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:text/html')) {
    return { kind: 'unsafe' };
  }
  if (trimmed.startsWith('#')) {
    return { kind: 'anchor', href: trimmed };
  }
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) {
    return { kind: 'external', href: trimmed };
  }
  if (lower.startsWith('conversation://')) {
    return { kind: 'conversation', convId: trimmed.replace(/^conversation:\/\/\/?/i, '').trim() };
  }
  if (lower.startsWith('data:image/')) {
    return { kind: 'data-image', href: trimmed };
  }
  // Everything else (file://, E:\..., /path/..., isaacgymenvs/README.md, ./foo.py, ../img.png) is a local/relative target
  return {
    kind: 'local',
    rawPath: trimmed,
    isCode: isCodeFilePath(trimmed),
    isPreviewable: isPreviewableFilePath(trimmed),
  };
}

export function buildRawFileUrl(rawPath, baseDir = '') {
  const qs = new URLSearchParams({ path: rawPath });
  if (baseDir) qs.set('base', baseDir);
  return `/api/raw-file?${qs.toString()}`;
}

export function fixCjkEmphasis(text) {
  const parts = String(text ?? '').split(/(`[^`]*`)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(
      /\*\*([^*\n]+?[：:，,。！？；、）》」』】\]])\*\*(?=[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])/g,
      '<strong>$1</strong>'
    );
  }
  return parts.join('');
}

function extractMathAndCode(source) {
  const mathTokens = [];
  const text = String(source ?? '').replace(/\r\n/g, '\n');

  const codeSegments = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g);
  for (let i = 0; i < codeSegments.length; i += 2) {
    let seg = codeSegments[i];

    seg = seg.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
      const idx = mathTokens.length;
      mathTokens.push({ display: true, expr: expr.trim() });
      return `\uE000MATH_BLOCK_${idx}\uE001`;
    });
    seg = seg.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => {
      const idx = mathTokens.length;
      mathTokens.push({ display: true, expr: expr.trim() });
      return `\uE000MATH_BLOCK_${idx}\uE001`;
    });

    seg = seg.replace(/\\\((.+?)\\\)/g, (_, expr) => {
      const idx = mathTokens.length;
      mathTokens.push({ display: false, expr: expr.trim() });
      return `\uE000MATH_INLINE_${idx}\uE001`;
    });
    seg = seg.replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w])/g, (_, expr) => {
      const idx = mathTokens.length;
      mathTokens.push({ display: false, expr: expr.trim() });
      return `\uE000MATH_INLINE_${idx}\uE001`;
    });

    codeSegments[i] = fixCjkEmphasis(seg);
  }

  return { text: codeSegments.join(''), mathTokens };
}

function renderLatex(expr, displayMode) {
  if (typeof window !== 'undefined' && window.katex?.renderToString) {
    try {
      return window.katex.renderToString(expr, {
        displayMode,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return `<code>${escapeHtml(expr)}</code>`;
    }
  }
  return displayMode
    ? `<pre class="math-fallback"><code>${escapeHtml(expr)}</code></pre>`
    : `<code>${escapeHtml(expr)}</code>`;
}

function restoreMath(html, mathTokens) {
  if (!mathTokens.length) return html;
  let out = html.replace(/<p>\s*(\uE000MATH_BLOCK_\d+\uE001)\s*<\/p>/g, '$1');
  out = out.replace(/\uE000MATH_(BLOCK|INLINE)_(\d+)\uE001/g, (_, kind, idxStr) => {
    const token = mathTokens[Number(idxStr)];
    if (!token) return '';
    const rendered = renderLatex(token.expr, kind === 'BLOCK');
    return kind === 'BLOCK' ? `<div class="math-block">${rendered}</div>` : rendered;
  });
  return out;
}

/**
 * Safely sanitize common benign HTML in READMEs (`<img>`, `<br>`, `<details>`, `<summary>`,
 * `<p align="center">`, `<sub>`, `<sup>`, `<kbd>`) while escaping scripts/handlers.
 */
function sanitizeHtmlSnippet(rawHtml, baseDir) {
  const trimmed = String(rawHtml ?? '').trim();
  if (/^<\/?(?:strong|em|b|i|sub|sup|kbd|br|hr|details|summary)\s*\/?>$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^<\/(?:p|div|span|a)>$/i.test(trimmed)) {
    return trimmed;
  }
  const alignOpen = trimmed.match(/^<(p|div)(?:\s+align=["']?(center|left|right)["']?)?\s*>$/i);
  if (alignOpen) {
    const tag = alignOpen[1].toLowerCase();
    const align = alignOpen[2] ? ` style="text-align:${alignOpen[2].toLowerCase()};"` : '';
    return `<${tag}${align}>`;
  }

  // Handle raw <img ...> tags frequently used in GitHub READMEs
  if (/^<img\b[^>]*>$/i.test(trimmed)) {
    const srcMatch = trimmed.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const altMatch = trimmed.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const widthMatch = trimmed.match(/\bwidth\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawSrc = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '') : '';
    const alt = escapeHtml(altMatch ? (altMatch[1] ?? altMatch[2] ?? '') : '');
    const widthVal = widthMatch ? (widthMatch[1] ?? widthMatch[2] ?? widthMatch[3] ?? '') : '';
    const safeWidth = /^\d+(?:%|px)?$/.test(widthVal) ? ` width="${escapeHtml(widthVal)}"` : '';

    const cls = classifyHref(rawSrc);
    let finalSrc = '';
    if (cls.kind === 'external' || cls.kind === 'data-image') {
      finalSrc = cls.href;
    } else if (cls.kind === 'local') {
      finalSrc = buildRawFileUrl(cls.rawPath, baseDir);
    }
    if (finalSrc) {
      return `<img src="${escapeHtml(finalSrc)}" alt="${alt}"${safeWidth} class="md-image" data-zoomable="true" loading="lazy" />`;
    }
  }

  // Handle simple HTML blocks containing nested <img> tags (e.g. `<p align="center"><img ... /></p>`)
  if (trimmed.includes('<img') && !/<script|<iframe|on\w+\s*=/i.test(trimmed)) {
    return trimmed.replace(/<[^>]+>/g, (tag) => sanitizeHtmlSnippet(tag, baseDir));
  }

  return escapeHtml(rawHtml);
}

function createMarkedForBase(baseDir = '') {
  if (typeof window === 'undefined' || !window.marked) return null;
  const { Marked } = window.marked;
  const renderer = {
    html(token) {
      const raw = typeof token === 'string' ? token : token.text || '';
      return sanitizeHtmlSnippet(raw, baseDir);
    },
    heading(token) {
      const htmlText = this.parser.parseInline(token.tokens || []);
      const slug = slugifyHeading(token.text || htmlText);
      const idAttr = slug ? ` id="${escapeHtml(slug)}"` : '';
      return `<h${token.depth}${idAttr}>${htmlText}</h${token.depth}>\n`;
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens || []) || escapeHtml(token.text || '');
      const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      const info = classifyHref(token.href);

      if (info.kind === 'unsafe') {
        return text;
      }
      if (info.kind === 'anchor') {
        return `<a href="${escapeHtml(info.href)}" data-anchor-link="true"${titleAttr}>${text}</a>`;
      }
      if (info.kind === 'external') {
        return `<a href="${escapeHtml(info.href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
      }
      if (info.kind === 'conversation') {
        return `<a href="#" class="local-file-link" data-open-conv="${escapeHtml(info.convId)}" title="Preview subagent conversation">${text}</a>`;
      }
      if (info.kind === 'local') {
        const escapedTarget = escapeHtml(info.rawPath);
        const escapedBase = escapeHtml(baseDir);
        const linkEl = `<a href="#" class="local-file-link" data-local-href="${escapedTarget}" data-base-dir="${escapedBase}" data-preview-mode="popup" title="Preview: ${escapedTarget}">${text}</a>`;
        if (info.isPreviewable) {
          return `<span class="code-link-group">${linkEl}<button type="button" class="open-sidebar-pill" data-local-href="${escapedTarget}" data-base-dir="${escapedBase}" data-preview-mode="sidebar" title="Open ${escapedTarget} in side panel">Open in sidebar</button></span>`;
        }
        return linkEl;
      }
      return text;
    },
    image(token) {
      const alt = escapeHtml(token.text || '');
      const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      const info = classifyHref(token.href);

      let src = '';
      if (info.kind === 'external' || info.kind === 'data-image') {
        src = info.href;
      } else if (info.kind === 'local') {
        src = buildRawFileUrl(info.rawPath, baseDir);
      }

      if (!src) {
        return `<span class="image-alt-badge">[Image: ${alt || 'unavailable'}]</span>`;
      }
      return `<img src="${escapeHtml(src)}" alt="${alt}"${titleAttr} class="md-image" data-zoomable="true" loading="lazy" />`;
    },
    code(token) {
      const code = token.text || '';
      const lang = (token.lang || '').trim().split(/\s+/)[0].toLowerCase();

      if (lang === 'mermaid') {
        const id = `mermaid-${++mermaidCounter}`;
        return `<div class="mermaid-card" data-mermaid-id="${id}" data-mermaid-src="${escapeHtml(code)}">
          <div class="code-card-header">
            <span>mermaid</span>
            <div class="code-card-actions">
              <button type="button" class="code-mini-btn" data-action="copy-raw">Copy</button>
            </div>
          </div>
          <div class="mermaid-stage"><span style="color:var(--text-faint);font-size:0.8rem;">Rendering diagram…</span></div>
        </div>`;
      }

      const lineCount = code.split('\n').length;
      const langLabel = lang || 'text';
      return `<div class="code-card" data-lang="${escapeHtml(lang)}">
        <div class="code-card-header">
          <span>${escapeHtml(langLabel)} · ${lineCount} lines</span>
          <div class="code-card-actions">
            <button type="button" class="code-mini-btn" data-action="toggle-wrap">Wrap</button>
            <button type="button" class="code-mini-btn" data-action="copy-code">Copy</button>
          </div>
        </div>
        <pre><code class="${lang ? `language-${escapeHtml(lang)}` : ''}">${escapeHtml(code)}</code></pre>
      </div>`;
    },
    table(token) {
      let headerHtml = '';
      const colCount = token.header?.length || 0;
      const rowCount = token.rows?.length || 0;
      if (colCount > 0) {
        const cells = token.header.map((cell, i) => {
          const align = token.align?.[i] ? ` style="text-align:${token.align[i]}"` : '';
          return `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
        }).join('');
        headerHtml = `<thead><tr>${cells}</tr></thead>`;
      }
      const rowsHtml = (token.rows || []).map((row) => {
        const cells = row.map((cell, i) => {
          const align = token.align?.[i] ? ` style="text-align:${token.align[i]}"` : '';
          return `<td${align}>${this.parser.parseInline(cell.tokens)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      const expandBar = colCount >= 3
        ? `<div class="table-card-header"><span>${colCount} cols · ${rowCount} rows</span><button type="button" class="code-mini-btn" data-action="toggle-table-expand" title="Expand columns up to 50% page width with horizontal slider">↔ Expand</button></div>`
        : '';
      return `<div class="table-card">${expandBar}<div class="table-wrap"><table>${headerHtml}<tbody>${rowsHtml}</tbody></table></div></div>`;
    },
    blockquote(token) {
      const inner = this.parser.parse(token.tokens || []);
      const match = inner.match(/^\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|SUCCESS|ERROR|BUG)\]([+-])?[ \t]*([^\n]*?)(?:\n([\s\S]*?))?<\/p>([\s\S]*)$/i);
      if (match) {
        const kind = match[1].toLowerCase();
        const collapseFlag = match[2] || '';
        const sameLine = (match[3] || '').trim();
        const firstParaRest = (match[4] || '').trim();
        const restParas = (match[5] || '').trim();
        const defaultTitle = kind.charAt(0).toUpperCase() + kind.slice(1);

        let titleHtml = defaultTitle;
        let bodyHtml = '';

        if (!firstParaRest && !restParas && sameLine) {
          // Single-line alert (`> [!CAUTION] High-risk actions...`): keep clean badge header and place content in body
          bodyHtml = `<p>${sameLine}</p>`;
        } else {
          const plainSameLine = sameLine.replace(/<[^>]+>/g, '').trim();
          if (sameLine && plainSameLine.length <= 72) {
            titleHtml = sameLine;
            bodyHtml = `${firstParaRest ? `<p>${firstParaRest}</p>` : ''}${restParas}`;
          } else {
            const combinedFirstP = [sameLine, firstParaRest].filter(Boolean).join('<br>');
            bodyHtml = `${combinedFirstP ? `<p>${combinedFirstP}</p>` : ''}${restParas}`;
          }
        }

        const iconSvg = getCalloutIconSvg(kind);
        const headerInner = `${iconSvg}<span class="callout-title-text">${titleHtml}</span>`;
        if (collapseFlag === '-') {
          return `<details class="callout callout-${kind}"><summary class="callout-title" style="cursor:pointer;">${headerInner}</summary><div class="callout-body">${bodyHtml}</div></details>`;
        }
        return `<div class="callout callout-${kind}"><div class="callout-title">${headerInner}</div>${bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : ''}</div>`;
      }
      return `<blockquote>${inner}</blockquote>`;
    },
  };

  const instance = new Marked({ gfm: true, breaks: false });
  instance.use({ renderer });
  return instance;
}

const markedByBase = new Map();
function getMarked(baseDir = '') {
  let inst = markedByBase.get(baseDir);
  if (!inst) {
    inst = createMarkedForBase(baseDir);
    if (inst) {
      markedByBase.set(baseDir, inst);
      if (markedByBase.size > 32) {
        markedByBase.delete(markedByBase.keys().next().value);
      }
    }
  }
  return inst;
}

function splitTopLevelBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  let buf = [];
  let inFence = false;
  let fenceChar = '';

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar && trimmed === fenceChar.repeat(trimmed.length)) {
        inFence = false;
        fenceChar = '';
      }
    }
    buf.push(line);
    if (!inFence && trimmed === '' && buf.length > 1) {
      blocks.push(buf.join('\n'));
      buf = [];
    }
  }
  if (buf.length > 0) blocks.push(buf.join('\n'));
  return blocks;
}

function renderBlockUncached(blockText, baseDir = '') {
  const m = getMarked(baseDir);
  const { text, mathTokens } = extractMathAndCode(blockText);
  if (!m) return `<pre>${escapeHtml(blockText)}</pre>`;
  const rawHtml = m.parse(text);
  return restoreMath(rawHtml, mathTokens);
}

export function renderMarkdownHtml(markdown, { baseDir = '' } = {}) {
  if (!markdown || typeof markdown !== 'string') return '';
  const blocks = splitTopLevelBlocks(markdown.replace(/\r\n/g, '\n'));
  const htmlParts = [];

  for (const blk of blocks) {
    const key = `${baseDir}\0${blk}`;
    let html = blockHtmlCache.get(key);
    if (html === undefined) {
      html = renderBlockUncached(blk, baseDir);
      blockHtmlCache.set(key, html);
      if (blockHtmlCache.size > 1500) {
        const firstKey = blockHtmlCache.keys().next().value;
        blockHtmlCache.delete(firstKey);
      }
    }
    htmlParts.push(html);
  }
  return htmlParts.join('');
}

async function ensureMermaid(theme) {
  if (!window.mermaid) {
    if (!mermaidLoaderPromise) {
      mermaidLoaderPromise = new Promise((resolveLoad, rejectLoad) => {
        const script = document.createElement('script');
        script.src = '/vendor/mermaid.min.js';
        script.onload = () => resolveLoad(window.mermaid);
        script.onerror = rejectLoad;
        document.head.appendChild(script);
      });
    }
    await mermaidLoaderPromise;
  }
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'neutral',
  });
  return window.mermaid;
}

export function enhanceMarkdownDom(container, theme = 'light') {
  if (!container) return;

  if (window.hljs) {
    container.querySelectorAll('pre code:not([data-highlighted="yes"])').forEach((el) => {
      try {
        window.hljs.highlightElement(el);
        el.dataset.highlighted = 'yes';
      } catch {
        // Ignore unknown language fallback
      }
    });
  }

  const mermaidCards = container.querySelectorAll('.mermaid-card:not([data-mermaid-rendered="true"])');
  if (mermaidCards.length > 0) {
    ensureMermaid(theme)
      .then(async (mermaid) => {
        for (const card of mermaidCards) {
          if (card.dataset.mermaidRendered === 'true') continue;
          const src = card.dataset.mermaidSrc || '';
          const stage = card.querySelector('.mermaid-stage');
          if (!stage || !src) continue;
          try {
            const renderId = `mmd_${++mermaidCounter}`;
            const { svg } = await mermaid.render(renderId, src);
            stage.innerHTML = svg;
            card.dataset.mermaidRendered = 'true';
          } catch (err) {
            stage.innerHTML = `<pre class="tool-pre">${escapeHtml(src)}\n\n[Mermaid error: ${escapeHtml(err.message || String(err))}]</pre>`;
            card.dataset.mermaidRendered = 'true';
          }
        }
      })
      .catch(() => {});
  }
}

export function attachCodeCardInteractions(root, { onOpenLocalLink, onOpenConversation, onZoomImage } = {}) {
  if (!root || root.dataset.mdInteractionsBound === 'true') return;
  root.dataset.mdInteractionsBound = 'true';

  const handleLocalTrigger = (e) => {
    const convEl = e.target.closest('[data-open-conv]');
    if (convEl) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'dblclick') return true;
      onOpenConversation?.(convEl.dataset.openConv);
      return true;
    }

    const localEl = e.target.closest('[data-local-href]');
    if (localEl) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'dblclick') return true;
      const rawHref = localEl.dataset.localHref || '';
      const baseDir = localEl.dataset.baseDir || '';
      const mode = localEl.dataset.previewMode || 'popup';
      onOpenLocalLink?.(rawHref, baseDir, mode);
      return true;
    }
    const anchorEl = e.target.closest('a[data-anchor-link="true"]');
    if (anchorEl) {
      e.preventDefault();
      if (e.type === 'dblclick') return true;
      const hash = anchorEl.getAttribute('href')?.slice(1) || '';
      if (hash) {
        const decoded = decodeURIComponent(hash);
        const target = root.querySelector(`#${CSS.escape(decoded)}`) || root.querySelector(`#${CSS.escape(slugifyHeading(decoded))}`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return true;
    }
    return false;
  };

  root.addEventListener('dblclick', (e) => {
    handleLocalTrigger(e);
  });

  root.addEventListener('click', async (e) => {
    if (handleLocalTrigger(e)) return;

    const zoomImg = e.target.closest('img[data-zoomable="true"]');
    if (zoomImg && onZoomImage) {
      onZoomImage(zoomImg.src, zoomImg.alt || '');
      return;
    }

    const btn = e.target.closest('.code-mini-btn');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'toggle-table-expand') {
      const tableCard = btn.closest('.table-card');
      if (!tableCard) return;
      const globalExpanded = document.documentElement.getAttribute('data-tables') === 'expand';
      if (globalExpanded && !tableCard.dataset.localOverride) {
        tableCard.dataset.localOverride = 'compact';
        tableCard.classList.remove('expanded');
        tableCard.classList.add('force-compact');
        btn.textContent = '↔ Expand';
      } else {
        tableCard.classList.remove('force-compact');
        delete tableCard.dataset.localOverride;
        const expanded = tableCard.classList.toggle('expanded');
        btn.textContent = expanded ? '⤡ Fit' : '↔ Expand';
      }
      return;
    }

    const card = btn.closest('.code-card, .mermaid-card');
    if (!card) return;

    if (action === 'toggle-wrap') {
      const wrapped = card.classList.toggle('wrapped');
      btn.textContent = wrapped ? 'Unwrap' : 'Wrap';
      return;
    }

    if (action === 'copy-code' || action === 'copy-raw') {
      const text = action === 'copy-raw'
        ? (card.dataset.mermaidSrc || '')
        : (card.querySelector('pre code')?.textContent || '');
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1400);
      } catch {
        // Clipboard denied fallback
      }
    }
  });
}
