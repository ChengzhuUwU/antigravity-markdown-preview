// Editorial Theme-Native Document Viewers:
// 1. Custom PDF.js Viewer (HiDPI Canvas + Selectable TextLayer + Thumbnails + Fit Width/Page + Dark Paper Tint)
// 2. Word (.docx / .doc) Viewer (docx-preview + JSZip paper layout, with PDF fallback for legacy .doc)
// 3. Excel (.xlsx / .xls / .ods) Multi-Sheet Viewer (SheetJS + merged cells + sticky A/B/C headers + instant row filter)
// 4. PowerPoint (.pptx / .ppt) Hybrid Viewer (Cached Office/LibreOffice Vector PDF Slide Deck + Pure-JS OOXML Slide Fallback)

import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

let pdfjsPromise = null;
let jsZipPromise = null;
let docxPreviewPromise = null;
let sheetJsPromise = null;

function loadScriptOnce(src) {
  return new Promise((resolveLoad, rejectLoad) => {
    const existing = document.querySelector(`script[data-vendor-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolveLoad();
      existing.addEventListener('load', () => resolveLoad(), { once: true });
      existing.addEventListener('error', rejectLoad, { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.vendorSrc = src;
    s.onload = () => {
      s.dataset.loaded = 'true';
      resolveLoad();
    };
    s.onerror = () => rejectLoad(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensurePdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (window.location.protocol === 'plugin:') {
        const [mainSrc, workerSrc] = await Promise.all([
          fetch('/vendor/pdf.min.mjs').then((r) => r.text()),
          fetch('/vendor/pdf.worker.min.mjs').then((r) => r.text()),
        ]);
        const mainBlob = URL.createObjectURL(new Blob([mainSrc], { type: 'text/javascript' }));
        const workerBlob = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
        const mod = await import(mainBlob);
        mod.GlobalWorkerOptions.workerSrc = workerBlob;
        return mod;
      }
      const mod = await import('/vendor/pdf.min.mjs');
      mod.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      return mod;
    })();
  }
  return pdfjsPromise;
}

async function ensureJsZip() {
  if (!window.JSZip) {
    if (!jsZipPromise) jsZipPromise = loadScriptOnce('/vendor/jszip.min.js');
    await jsZipPromise;
  }
  return window.JSZip;
}

async function ensureDocxPreview() {
  await ensureJsZip();
  if (!window.docx?.renderAsync) {
    if (!docxPreviewPromise) docxPreviewPromise = loadScriptOnce('/vendor/docx-preview.min.js');
    await docxPreviewPromise;
  }
  return window.docx;
}

async function ensureSheetJs() {
  if (!window.XLSX) {
    if (!sheetJsPromise) sheetJsPromise = loadScriptOnce('/vendor/xlsx.full.min.js');
    await sheetJsPromise;
  }
  return window.XLSX;
}

export const APPLE_SPINNER_SVG = `<svg class="apple-spinner" viewBox="0 0 24 24" aria-hidden="true">
  <g stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
    <line x1="12" y1="2.5" x2="12" y2="6.5" opacity="1"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(30 12 12)" opacity="0.91"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(60 12 12)" opacity="0.82"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(90 12 12)" opacity="0.73"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(120 12 12)" opacity="0.64"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(150 12 12)" opacity="0.55"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(180 12 12)" opacity="0.46"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(210 12 12)" opacity="0.38"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(240 12 12)" opacity="0.30"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(270 12 12)" opacity="0.24"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(300 12 12)" opacity="0.18"/>
    <line x1="12" y1="2.5" x2="12" y2="6.5" transform="rotate(330 12 12)" opacity="0.12"/>
  </g>
</svg>`;

function parseInitialPageFromHash(hashStr) {
  if (!hashStr) return 1;
  const m = String(hashStr).match(/(?:^|&)page=(\d+)/i) || String(hashStr).match(/^(\d+)$/);
  return m ? Math.max(1, Number(m[1])) : 1;
}

/* -------------------------------------------------------------------------
 * 1. Custom Editorial PDF.js Viewer (also powers High-Fidelity PPTX Slides)
 * ------------------------------------------------------------------------- */

export async function renderCustomPdfViewer(containerEl, {
  rawUrl,
  sizeText = '',
  hash = '',
  presentationMode = false,
  badgeLabel = 'PDF',
  apiFetch = fetch,
  extraToolbarBtnHtml = '',
  onExtraToolbarClick = null,
} = {}) {
  if (!containerEl) return;
  const initialPage = parseInitialPageFromHash(hash);

  containerEl.innerHTML = `<div class="doc-viewer-loading">${APPLE_SPINNER_SVG}<span>${escapeHtml(t('officeLoadingDoc'))}</span></div>`;

  try {
    const [pdfjsLib, pdfRes] = await Promise.all([
      ensurePdfJs(),
      apiFetch(rawUrl),
    ]);
    if (!pdfRes.ok) throw new Error(`HTTP ${pdfRes.status}`);
    const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
    const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;

    let fitMode = presentationMode ? 'page' : 'width'; // 'width' | 'page' | 'manual'
    let manualScale = 1.0;
    let rotation = 0;
    let thumbsOpen = presentationMode && numPages > 1;
    let darkTint = false;
    let currentPage = Math.min(numPages, initialPage);

    const firstPage = await pdfDoc.getPage(1);
    const baseVp1 = firstPage.getViewport({ scale: 1, rotation: 0 });

    containerEl.innerHTML = `
      <div class="pdf-editorial-viewer ${darkTint ? 'dark-paper-tint' : ''}">
        <div class="media-toolbar pdf-editorial-toolbar">
          <div class="pdf-toolbar-group">
            <button type="button" class="code-mini-btn ${thumbsOpen ? 'active' : ''}" data-pdf-thumbs title="${escapeHtml(t('pdfThumbsTip'))}">◧</button>
            <span class="pdf-meta-badge">${escapeHtml(badgeLabel)}${sizeText ? ` · ${escapeHtml(sizeText)}` : ''}</span>
          </div>
          <div class="pdf-toolbar-group">
            <button type="button" class="code-mini-btn" data-pdf-prev>‹</button>
            <span class="pdf-page-indicator">
              <input type="number" class="pdf-page-input" min="1" max="${numPages}" value="${currentPage}" data-pdf-page-input>
              <span>/ ${numPages}</span>
            </span>
            <button type="button" class="code-mini-btn" data-pdf-next>›</button>
          </div>
          <div class="pdf-toolbar-group">
            <button type="button" class="code-mini-btn" data-pdf-zoom-out>−</button>
            <span class="pdf-zoom-readout" data-pdf-zoom-label>100%</span>
            <button type="button" class="code-mini-btn" data-pdf-zoom-in>+</button>
            <div class="prefs-seg-group">
              <button type="button" class="prefs-seg-btn ${fitMode === 'width' ? 'active' : ''}" data-pdf-fit="width">${escapeHtml(t('pdfFitWidthBtn'))}</button>
              <button type="button" class="prefs-seg-btn ${fitMode === 'page' ? 'active' : ''}" data-pdf-fit="page">${escapeHtml(t('pdfFitPageBtn'))}</button>
            </div>
            <button type="button" class="code-mini-btn" data-pdf-rotate title="${escapeHtml(t('pdfRotateTip'))}">↻</button>
            <button type="button" class="code-mini-btn" data-pdf-tint title="${escapeHtml(t('pdfDarkPaperTip'))}">${escapeHtml(t('pdfDarkPaperBtn'))}</button>
          </div>
          <div class="pdf-toolbar-group">
            ${extraToolbarBtnHtml}
            <a href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener noreferrer" class="code-mini-btn" style="text-decoration:none;" title="${escapeHtml(t('pdfOpenTabTip'))}">${escapeHtml(t('pdfOpenTabBtn'))}</a>
          </div>
        </div>
        <div class="pdf-stage-body">
          <aside class="pdf-thumbs-rail ${thumbsOpen ? '' : 'hidden'}" data-pdf-thumbs-rail></aside>
          <div class="pdf-pages-viewport" data-pdf-viewport tabindex="0"></div>
        </div>
      </div>
    `;

    const rootEl = containerEl.querySelector('.pdf-editorial-viewer');
    const thumbsRail = containerEl.querySelector('[data-pdf-thumbs-rail]');
    const viewportEl = containerEl.querySelector('[data-pdf-viewport]');
    const pageInput = containerEl.querySelector('[data-pdf-page-input]');
    const zoomLabel = containerEl.querySelector('[data-pdf-zoom-label]');

    if (onExtraToolbarClick) {
      onExtraToolbarClick(rootEl);
    }

    const pageShells = [];
    const thumbBtns = [];
    let currentEffectiveScale = 1;
    let renderGeneration = 0;

    for (let p = 1; p <= numPages; p++) {
      const shell = document.createElement('div');
      shell.className = 'pdf-page-shell';
      shell.dataset.pageNum = String(p);
      shell.innerHTML = `
        <canvas class="pdf-page-canvas"></canvas>
        <div class="pdf-text-layer"></div>
        <span class="pdf-page-corner-num">${p}</span>
      `;
      viewportEl.appendChild(shell);
      pageShells.push(shell);

      const tBtn = document.createElement('button');
      tBtn.type = 'button';
      tBtn.className = `pdf-thumb-item ${p === currentPage ? 'active' : ''}`;
      tBtn.dataset.thumbPage = String(p);
      tBtn.innerHTML = `<div class="pdf-thumb-canvas-wrap"><canvas></canvas></div><span>${p}</span>`;
      thumbsRail.appendChild(tBtn);
      thumbBtns.push(tBtn);
    }

    const computeScale = () => {
      const rotVp = firstPage.getViewport({ scale: 1, rotation });
      const availW = Math.max(220, viewportEl.clientWidth - 36);
      const availH = Math.max(220, viewportEl.clientHeight - 32);
      if (fitMode === 'width') {
        return availW / rotVp.width;
      }
      if (fitMode === 'page') {
        return Math.min(availW / rotVp.width, availH / rotVp.height);
      }
      return manualScale;
    };

    const renderSinglePage = async (pageNum, gen) => {
      const shell = pageShells[pageNum - 1];
      if (!shell || !shell.isConnected) return;
      const scaleKey = `${currentEffectiveScale.toFixed(3)}:${rotation}`;
      if (shell.dataset.renderedKey === scaleKey || shell.dataset.renderingKey === scaleKey) return;
      shell.dataset.renderingKey = scaleKey;

      try {
        const page = await pdfDoc.getPage(pageNum);
        if (gen !== renderGeneration || !shell.isConnected) return;
        const vp = page.getViewport({ scale: currentEffectiveScale, rotation });
        const dpr = Math.min(2.25, window.devicePixelRatio || 1);

        shell.style.width = `${Math.round(vp.width)}px`;
        shell.style.height = `${Math.round(vp.height)}px`;

        const canvas = shell.querySelector('.pdf-page-canvas');
        const textLayerDiv = shell.querySelector('.pdf-text-layer');
        canvas.width = Math.max(1, Math.floor(vp.width * dpr));
        canvas.height = Math.max(1, Math.floor(vp.height * dpr));
        canvas.style.width = `${Math.round(vp.width)}px`;
        canvas.style.height = `${Math.round(vp.height)}px`;

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        if (gen !== renderGeneration) return;

        textLayerDiv.innerHTML = '';
        textLayerDiv.style.setProperty('--scale-factor', String(vp.scale));
        if (typeof pdfjsLib.TextLayer === 'function') {
          const textContent = await page.getTextContent();
          if (gen !== renderGeneration) return;
          const tl = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport: vp,
          });
          await tl.render();
        }
        shell.dataset.renderedKey = scaleKey;
      } catch {
        // Ignore cancelled page render
      } finally {
        delete shell.dataset.renderingKey;
      }
    };

    let pageObserver = null;
    const layoutAndObservePages = () => {
      renderGeneration += 1;
      const gen = renderGeneration;
      currentEffectiveScale = Math.max(0.25, Math.min(4.5, computeScale()));
      if (zoomLabel) zoomLabel.textContent = `${Math.round(currentEffectiveScale * 100)}%`;

      const rotVp = firstPage.getViewport({ scale: currentEffectiveScale, rotation });
      const estW = Math.round(rotVp.width);
      const estH = Math.round(rotVp.height);

      for (const shell of pageShells) {
        if (shell.dataset.renderedKey !== `${currentEffectiveScale.toFixed(3)}:${rotation}`) {
          shell.style.width = `${estW}px`;
          shell.style.height = `${estH}px`;
        }
      }

      if (pageObserver) pageObserver.disconnect();
      pageObserver = new IntersectionObserver((entries) => {
        for (const ent of entries) {
          if (ent.isIntersecting) {
            const pNum = Number(ent.target.dataset.pageNum);
            renderSinglePage(pNum, gen);
          }
        }
      }, { root: viewportEl, rootMargin: '520px 0px' });

      pageShells.forEach((sh) => pageObserver.observe(sh));
    };

    const renderThumbsLazy = () => {
      if (thumbsRail.dataset.thumbsInitialized === 'true') return;
      thumbsRail.dataset.thumbsInitialized = 'true';
      const thumbObs = new IntersectionObserver(async (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          const btn = ent.target;
          thumbObs.unobserve(btn);
          const pNum = Number(btn.dataset.thumbPage);
          try {
            const page = await pdfDoc.getPage(pNum);
            const vp = page.getViewport({ scale: 112 / baseVp1.width });
            const c = btn.querySelector('canvas');
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            c.width = Math.floor(vp.width * dpr);
            c.height = Math.floor(vp.height * dpr);
            c.style.width = `${Math.round(vp.width)}px`;
            c.style.height = `${Math.round(vp.height)}px`;
            const ctx = c.getContext('2d', { alpha: false });
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
          } catch {}
        }
      }, { root: thumbsRail, rootMargin: '200px 0px' });
      thumbBtns.forEach((b) => thumbObs.observe(b));
    };

    const setActivePageIndicator = (pNum) => {
      currentPage = Math.max(1, Math.min(numPages, pNum));
      if (pageInput && document.activeElement !== pageInput) {
        pageInput.value = String(currentPage);
      }
      thumbBtns.forEach((b, i) => b.classList.toggle('active', i + 1 === currentPage));
      thumbBtns[currentPage - 1]?.scrollIntoView({ block: 'nearest' });
    };

    const jumpToPage = (pNum) => {
      const clamped = Math.max(1, Math.min(numPages, pNum));
      setActivePageIndicator(clamped);
      pageShells[clamped - 1]?.scrollIntoView({ behavior: 'instant', block: 'start' });
    };

    viewportEl.addEventListener('scroll', () => {
      const mid = viewportEl.scrollTop + viewportEl.clientHeight * 0.35;
      let bestPage = 1;
      for (let i = 0; i < pageShells.length; i++) {
        const sh = pageShells[i];
        if (sh.offsetTop <= mid) bestPage = i + 1;
        else break;
      }
      if (bestPage !== currentPage) setActivePageIndicator(bestPage);
    }, { passive: true });

    const updateFitButtons = () => {
      rootEl.querySelectorAll('[data-pdf-fit]').forEach((b) => {
        b.classList.toggle('active', b.dataset.pdfFit === fitMode);
      });
    };

    rootEl.querySelector('[data-pdf-thumbs]')?.addEventListener('click', (e) => {
      thumbsOpen = !thumbsOpen;
      e.currentTarget.classList.toggle('active', thumbsOpen);
      thumbsRail.classList.toggle('hidden', !thumbsOpen);
      if (thumbsOpen) renderThumbsLazy();
      if (fitMode !== 'manual') layoutAndObservePages();
    });

    thumbsRail.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-thumb-page]');
      if (btn) jumpToPage(Number(btn.dataset.thumbPage));
    });

    rootEl.querySelector('[data-pdf-prev]')?.addEventListener('click', () => jumpToPage(currentPage - 1));
    rootEl.querySelector('[data-pdf-next]')?.addEventListener('click', () => jumpToPage(currentPage + 1));
    pageInput?.addEventListener('change', () => jumpToPage(Number(pageInput.value) || 1));

    rootEl.querySelector('[data-pdf-zoom-in]')?.addEventListener('click', () => {
      manualScale = Math.min(4.0, currentEffectiveScale * 1.2);
      fitMode = 'manual';
      updateFitButtons();
      layoutAndObservePages();
    });
    rootEl.querySelector('[data-pdf-zoom-out]')?.addEventListener('click', () => {
      manualScale = Math.max(0.3, currentEffectiveScale / 1.2);
      fitMode = 'manual';
      updateFitButtons();
      layoutAndObservePages();
    });

    rootEl.querySelectorAll('[data-pdf-fit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        fitMode = btn.dataset.pdfFit;
        updateFitButtons();
        layoutAndObservePages();
      });
    });

    rootEl.querySelector('[data-pdf-rotate]')?.addEventListener('click', () => {
      rotation = (rotation + 90) % 360;
      layoutAndObservePages();
    });

    rootEl.querySelector('[data-pdf-tint]')?.addEventListener('click', (e) => {
      darkTint = !darkTint;
      e.currentTarget.classList.toggle('active', darkTint);
      rootEl.classList.toggle('dark-paper-tint', darkTint);
    });

    viewportEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        jumpToPage(currentPage + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        jumpToPage(currentPage - 1);
      }
    });

    let resizeTimer = null;
    let lastObsW = viewportEl.clientWidth;
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (!viewportEl.isConnected) {
          ro.disconnect();
          return;
        }
        const nextW = viewportEl.clientWidth;
        if (fitMode !== 'manual' && Math.abs(nextW - lastObsW) >= 6) {
          lastObsW = nextW;
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(layoutAndObservePages, 120);
        }
      });
      ro.observe(viewportEl);
    }

    layoutAndObservePages();
    if (thumbsOpen) renderThumbsLazy();
    if (initialPage > 1) {
      requestAnimationFrame(() => jumpToPage(initialPage));
    }
  } catch (err) {
    containerEl.innerHTML = `<div class="notice-banner error">PDF render failed: ${escapeHtml(err.message)}</div>`;
  }
}

/* -------------------------------------------------------------------------
 * 2. Word (.docx / .doc) Viewer
 * ------------------------------------------------------------------------- */

export async function renderWordViewer(containerEl, {
  rawUrl,
  filePath = '',
  baseDir = '',
  ext = '.docx',
  sizeText = '',
  apiFetch = fetch,
} = {}) {
  if (!containerEl) return;

  // Legacy binary .doc (Word 97-2003): convert via local Word/LibreOffice -> PDF viewer
  if (ext === '.doc') {
    containerEl.innerHTML = `<div class="doc-viewer-loading">${APPLE_SPINNER_SVG}<span>${escapeHtml(t('officeLoadingDoc'))}</span></div>`;
    const qs = new URLSearchParams({ path: filePath });
    if (baseDir) qs.set('base', baseDir);
    const convRes = await apiFetch(`/api/office-to-pdf?${qs.toString()}`).then((r) => r.json()).catch(() => ({}));
    if (convRes?.converted && convRes.pdfUrl) {
      await renderCustomPdfViewer(containerEl, {
        rawUrl: convRes.pdfUrl,
        sizeText,
        badgeLabel: 'DOC · PDF',
        apiFetch,
      });
      return;
    }
    containerEl.innerHTML = `<div class="notice-banner error">Legacy binary .doc requires LibreOffice or Microsoft Word installed locally to convert, or save as .docx.</div>`;
    return;
  }

  containerEl.innerHTML = `<div class="doc-viewer-loading">${APPLE_SPINNER_SVG}<span>${escapeHtml(t('officeLoadingDoc'))}</span></div>`;

  try {
    const [docxLib, res] = await Promise.all([
      ensureDocxPreview(),
      apiFetch(rawUrl),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();

    let zoomScale = 1.0;
    let darkPaper = false;

    containerEl.innerHTML = `
      <div class="office-docx-viewer">
        <div class="media-toolbar">
          <span class="pdf-meta-badge">WORD · ${escapeHtml(sizeText)}</span>
          <div class="pdf-toolbar-group">
            <button type="button" class="code-mini-btn" data-docx-zoom-out>−</button>
            <span class="pdf-zoom-readout" data-docx-zoom-label>100%</span>
            <button type="button" class="code-mini-btn" data-docx-zoom-in>+</button>
            <button type="button" class="code-mini-btn" data-docx-fit>${escapeHtml(t('pdfFitWidthBtn'))}</button>
            <button type="button" class="code-mini-btn" data-docx-tint title="${escapeHtml(t('pdfDarkPaperTip'))}">${escapeHtml(t('pdfDarkPaperBtn'))}</button>
          </div>
        </div>
        <div class="office-docx-stage" data-docx-stage>
          <div class="office-docx-zoom-inner" data-docx-mount></div>
        </div>
      </div>
    `;

    const rootEl = containerEl.querySelector('.office-docx-viewer');
    const stageEl = containerEl.querySelector('[data-docx-stage]');
    const mountEl = containerEl.querySelector('[data-docx-mount]');
    const zoomLabel = containerEl.querySelector('[data-docx-zoom-label]');

    await docxLib.renderAsync(arrayBuffer, mountEl, null, {
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      useBase64URL: true,
    });

    const applyDocxScale = (nextScale) => {
      zoomScale = Math.max(0.35, Math.min(2.5, nextScale));
      mountEl.style.zoom = String(zoomScale);
      if (zoomLabel) zoomLabel.textContent = `${Math.round(zoomScale * 100)}%`;
    };

    const fitDocxToWidth = () => {
      const sec = mountEl.querySelector('section.docx');
      const natW = sec ? (sec.offsetWidth || 794) : 794;
      const availW = Math.max(260, stageEl.clientWidth - 36);
      applyDocxScale(Math.min(1.35, availW / (natW + 24)));
    };

    requestAnimationFrame(fitDocxToWidth);

    rootEl.querySelector('[data-docx-zoom-in]')?.addEventListener('click', () => applyDocxScale(zoomScale * 1.15));
    rootEl.querySelector('[data-docx-zoom-out]')?.addEventListener('click', () => applyDocxScale(zoomScale / 1.15));
    rootEl.querySelector('[data-docx-fit]')?.addEventListener('click', fitDocxToWidth);
    rootEl.querySelector('[data-docx-tint]')?.addEventListener('click', (e) => {
      darkPaper = !darkPaper;
      e.currentTarget.classList.toggle('active', darkPaper);
      stageEl.classList.toggle('dark-paper-tint', darkPaper);
    });
  } catch (err) {
    containerEl.innerHTML = `<div class="notice-banner error">Word (.docx) preview failed: ${escapeHtml(err.message)}</div>`;
  }
}

/* -------------------------------------------------------------------------
 * 3. Excel (.xlsx / .xls / .ods) Multi-Sheet Viewer
 * ------------------------------------------------------------------------- */

function colIndexToLetter(idx) {
  let n = idx + 1;
  let str = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    n = Math.floor((n - 1) / 26);
  }
  return str;
}

export async function renderSpreadsheetViewer(containerEl, {
  rawUrl,
  ext = '.xlsx',
  sizeText = '',
  apiFetch = fetch,
} = {}) {
  if (!containerEl) return;
  containerEl.innerHTML = `<div class="doc-viewer-loading">${APPLE_SPINNER_SVG}<span>${escapeHtml(t('officeLoadingDoc'))}</span></div>`;

  try {
    const [XLSX, res] = await Promise.all([
      ensureSheetJs(),
      apiFetch(rawUrl),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const workbook = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheetNames = workbook.SheetNames || [];
    if (sheetNames.length === 0) {
      containerEl.innerHTML = `<div class="notice-banner">Empty workbook</div>`;
      return;
    }

    let activeSheetIdx = 0;
    let filterQuery = '';
    let rowLimit = 500;
    let expandedCols = true;

    const badgeExt = (ext || '.xlsx').replace('.', '').toUpperCase();

    containerEl.innerHTML = `
      <div class="office-xlsx-viewer">
        <div class="media-toolbar">
          <div class="pdf-toolbar-group" style="flex-wrap:wrap;">
            <span class="pdf-meta-badge">${escapeHtml(badgeExt)} · ${escapeHtml(sizeText)}</span>
            <div class="xlsx-sheet-tabs" data-xlsx-tabs></div>
          </div>
          <div class="pdf-toolbar-group">
            <input type="search" class="input-sm xlsx-filter-input" placeholder="${escapeHtml(t('xlsxFilterPlaceholder'))}" data-xlsx-filter>
            <button type="button" class="code-mini-btn active" data-xlsx-expand>${escapeHtml(t('tableExpandBtn'))}</button>
          </div>
        </div>
        <div class="xlsx-grid-wrap" data-xlsx-grid-wrap></div>
      </div>
    `;

    const tabsEl = containerEl.querySelector('[data-xlsx-tabs]');
    const filterInput = containerEl.querySelector('[data-xlsx-filter]');
    const expandBtn = containerEl.querySelector('[data-xlsx-expand]');
    const gridWrap = containerEl.querySelector('[data-xlsx-grid-wrap]');

    const renderCurrentSheet = () => {
      tabsEl.innerHTML = sheetNames.map((name, i) =>
        `<button type="button" class="xlsx-tab-btn ${i === activeSheetIdx ? 'active' : ''}" data-sheet-idx="${i}">${escapeHtml(name)}</button>`
      ).join('');

      const ws = workbook.Sheets[sheetNames[activeSheetIdx]];
      const ref = ws?.['!ref'];
      if (!ws || !ref) {
        gridWrap.innerHTML = `<div style="padding:18px;font-size:0.82rem;color:var(--text-faint);">(Empty sheet)</div>`;
        return;
      }

      const range = XLSX.utils.decode_range(ref);
      const totalRows = Math.max(0, range.e.r - range.s.r + 1);
      const totalCols = Math.min(120, Math.max(1, range.e.c - range.s.c + 1));

      // Build merge map when not filtering
      const mergeSpanMap = new Map();
      const coveredSet = new Set();
      if (!filterQuery && Array.isArray(ws['!merges'])) {
        for (const m of ws['!merges']) {
          const rs = m.e.r - m.s.r + 1;
          const cs = m.e.c - m.s.c + 1;
          if (rs > 1 || cs > 1) {
            mergeSpanMap.set(`${m.s.r}:${m.s.c}`, { rs, cs });
            for (let r = m.s.r; r <= m.e.r; r++) {
              for (let c = m.s.c; c <= m.e.c; c++) {
                if (r !== m.s.r || c !== m.s.c) coveredSet.add(`${r}:${c}`);
              }
            }
          }
        }
      }

      const lowerFilter = filterQuery.trim().toLowerCase();
      const matchingRowIndices = [];
      for (let r = range.s.r; r <= range.e.r; r++) {
        if (!lowerFilter) {
          matchingRowIndices.push(r);
          continue;
        }
        let hit = false;
        for (let c = range.s.c; c < range.s.c + totalCols; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          const formatted = cell ? XLSX.utils.format_cell(cell) : '';
          if (formatted && formatted.toLowerCase().includes(lowerFilter)) {
            hit = true;
            break;
          }
        }
        if (hit) matchingRowIndices.push(r);
      }

      const shownRowIndices = matchingRowIndices.slice(0, rowLimit);
      const colHeadersHtml = Array.from({ length: totalCols }, (_, ci) =>
        `<th class="xlsx-col-hdr">${colIndexToLetter(range.s.c + ci)}</th>`
      ).join('');

      const rowsHtml = shownRowIndices.map((r) => {
        const tds = [];
        for (let ci = 0; ci < totalCols; ci++) {
          const c = range.s.c + ci;
          const key = `${r}:${c}`;
          if (coveredSet.has(key)) continue;
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          const text = cell ? XLSX.utils.format_cell(cell) : '';
          const isNum = cell?.t === 'n';
          const span = mergeSpanMap.get(key);
          const spanAttrs = `${span?.rs > 1 ? ` rowspan="${span.rs}"` : ''}${span?.cs > 1 ? ` colspan="${span.cs}"` : ''}`;
          tds.push(`<td class="${isNum ? 'xlsx-num' : ''}"${spanAttrs}>${escapeHtml(text)}</td>`);
        }
        return `<tr><td class="xlsx-row-hdr">${r + 1}</td>${tds.join('')}</tr>`;
      }).join('');

      const loadMoreHtml = matchingRowIndices.length > shownRowIndices.length
        ? `<div style="padding:10px;text-align:center;"><button type="button" class="pill-btn" data-xlsx-more>${escapeHtml(t('xlsxLoadMoreBtn', { shown: shownRowIndices.length, total: matchingRowIndices.length }))}</button></div>`
        : '';

      gridWrap.innerHTML = `
        <div class="xlsx-table-scroll ${expandedCols ? 'expanded-cols' : ''}">
          <table class="xlsx-table">
            <thead><tr><th class="xlsx-corner-hdr">#</th>${colHeadersHtml}</tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        ${loadMoreHtml}
      `;

      gridWrap.querySelector('[data-xlsx-more]')?.addEventListener('click', () => {
        rowLimit += 600;
        renderCurrentSheet();
      });
    };

    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sheet-idx]');
      if (!btn) return;
      activeSheetIdx = Number(btn.dataset.sheetIdx) || 0;
      rowLimit = 500;
      renderCurrentSheet();
    });

    filterInput?.addEventListener('input', () => {
      filterQuery = filterInput.value || '';
      rowLimit = 500;
      renderCurrentSheet();
    });

    expandBtn?.addEventListener('click', () => {
      expandedCols = !expandedCols;
      expandBtn.classList.toggle('active', expandedCols);
      expandBtn.textContent = expandedCols ? t('tableExpandBtn') : t('tableFitBtn');
      gridWrap.querySelector('.xlsx-table-scroll')?.classList.toggle('expanded-cols', expandedCols);
    });

    renderCurrentSheet();
  } catch (err) {
    containerEl.innerHTML = `<div class="notice-banner error">Spreadsheet preview failed: ${escapeHtml(err.message)}</div>`;
  }
}

/* -------------------------------------------------------------------------
 * 4. PowerPoint (.pptx / .ppt) Hybrid Viewer
 *    - Primary: Cached Office/LibreOffice Vector PDF Slide Deck
 *    - Fallback: Pure-JS JSZip + DOMParser OOXML Slide Deck Renderer
 * ------------------------------------------------------------------------- */

function localTag(node) {
  return (node?.localName || node?.nodeName?.split(':').pop() || '').toLowerCase();
}

function directChild(parent, tag) {
  if (!parent?.children) return null;
  for (const ch of parent.children) {
    if (localTag(ch) === tag) return ch;
  }
  return null;
}

function findFirstDesc(root, tag) {
  if (!root?.getElementsByTagName) return null;
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (localTag(all[i]) === tag) return all[i];
  }
  return null;
}

function findAllDesc(root, tag) {
  const out = [];
  if (!root?.getElementsByTagName) return out;
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (localTag(all[i]) === tag) out.push(all[i]);
  }
  return out;
}

function resolveZipTarget(baseDir, relTarget) {
  if (!relTarget) return '';
  if (relTarget.startsWith('/')) return relTarget.slice(1);
  const parts = [...baseDir.split('/').filter(Boolean), ...relTarget.split('/')];
  const resolved = [];
  for (const p of parts) {
    if (p === '.' || !p) continue;
    if (p === '..') resolved.pop();
    else resolved.push(p);
  }
  return resolved.join('/');
}

function parseColorNode(colorContainer, themeMap) {
  if (!colorContainer) return '';
  const srgb = directChild(colorContainer, 'srgbclr') || findFirstDesc(colorContainer, 'srgbclr');
  if (srgb) {
    const val = srgb.getAttribute('val');
    if (val) return `#${val}`;
  }
  const scheme = directChild(colorContainer, 'schemeclr') || findFirstDesc(colorContainer, 'schemeclr');
  if (scheme) {
    const key = (scheme.getAttribute('val') || '').toLowerCase();
    const alias = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' }[key] || key;
    if (themeMap[alias]) return themeMap[alias];
  }
  return '';
}

async function parsePptxArchivePureJs(arrayBuffer) {
  const JSZip = await ensureJsZip();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const parser = new DOMParser();
  const parseXml = async (zipPath) => {
    const f = zip.file(zipPath);
    if (!f) return null;
    const txt = await f.async('string');
    return parser.parseFromString(txt, 'application/xml');
  };

  // 1. Parse theme colors
  const themeMap = {
    dk1: '#1e293b', lt1: '#ffffff', dk2: '#334155', lt2: '#f8fafc',
    accent1: '#3b82f6', accent2: '#8b5cf6', accent3: '#10b981',
    accent4: '#f59e0b', accent5: '#ef4444', accent6: '#06b6d4',
  };
  const themeDoc = await parseXml('ppt/theme/theme1.xml');
  if (themeDoc) {
    const clrScheme = findFirstDesc(themeDoc, 'clrscheme');
    if (clrScheme?.children) {
      for (const ch of clrScheme.children) {
        const k = localTag(ch);
        const srgb = findFirstDesc(ch, 'srgbclr');
        const sys = findFirstDesc(ch, 'sysclr');
        const hex = srgb?.getAttribute('val') || sys?.getAttribute('lastClr');
        if (hex) themeMap[k] = `#${hex}`;
      }
    }
  }

  // 2. Parse presentation slide size & ordered slide paths
  const presDoc = await parseXml('ppt/presentation.xml');
  const presRelsDoc = await parseXml('ppt/_rels/presentation.xml.rels');
  const relById = new Map();
  if (presRelsDoc) {
    for (const rel of findAllDesc(presRelsDoc, 'relationship')) {
      relById.set(rel.getAttribute('Id'), rel.getAttribute('Target'));
    }
  }

  let slideEmuW = 12192000;
  let slideEmuH = 6858000;
  const sldSz = presDoc ? findFirstDesc(presDoc, 'sldsz') : null;
  if (sldSz) {
    slideEmuW = Number(sldSz.getAttribute('cx')) || slideEmuW;
    slideEmuH = Number(sldSz.getAttribute('cy')) || slideEmuH;
  }
  const baseW = 960;
  const baseH = Math.round((slideEmuH / slideEmuW) * baseW);
  const emuToPx = (emu) => (Number(emu) || 0) * (baseW / slideEmuW);

  let slidePaths = [];
  if (presDoc) {
    for (const sldId of findAllDesc(presDoc, 'sldid')) {
      const rId = sldId.getAttribute('r:id') || sldId.getAttribute('id');
      const target = relById.get(rId);
      if (target) slidePaths.push(resolveZipTarget('ppt', target));
    }
  }
  if (slidePaths.length === 0) {
    slidePaths = Object.keys(zip.files)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  const mediaUrlCache = new Map();
  const getMediaBlobUrl = async (zipMediaPath) => {
    if (mediaUrlCache.has(zipMediaPath)) return mediaUrlCache.get(zipMediaPath);
    const f = zip.file(zipMediaPath);
    if (!f) return '';
    const ext = zipMediaPath.split('.').pop()?.toLowerCase() || '';
    const mime = ext === 'svg' ? 'image/svg+xml'
      : ext === 'png' ? 'image/png'
      : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp' : 'application/octet-stream';
    if (!mime.startsWith('image/')) return '';
    const blob = new Blob([await f.async('arraybuffer')], { type: mime });
    const u = URL.createObjectURL(blob);
    mediaUrlCache.set(zipMediaPath, u);
    return u;
  };

  const slides = [];
  for (const sPath of slidePaths) {
    const sDoc = await parseXml(sPath);
    if (!sDoc) continue;
    const sDir = sPath.split('/').slice(0, -1).join('/');
    const sName = sPath.split('/').pop();
    const sRelsDoc = await parseXml(`${sDir}/_rels/${sName}.rels`);
    const sRels = new Map();
    if (sRelsDoc) {
      for (const rel of findAllDesc(sRelsDoc, 'relationship')) {
        sRels.set(rel.getAttribute('Id'), resolveZipTarget(sDir, rel.getAttribute('Target')));
      }
    }

    let bgStyle = 'background:#ffffff;';
    const bgPr = findFirstDesc(sDoc, 'bgpr');
    if (bgPr) {
      const solid = directChild(bgPr, 'solidfill');
      const bgHex = parseColorNode(solid, themeMap);
      if (bgHex) bgStyle = `background:${bgHex};`;
    }

    const elementsHtml = [];
    const renderShapeTree = async (spTree, offsetX = 0, offsetY = 0, scaleX = 1, scaleY = 1) => {
      if (!spTree?.children) return;
      for (const node of spTree.children) {
        const tag = localTag(node);
        if (tag === 'grpsp') {
          const grpPr = directChild(node, 'grpsppr');
          const xfrm = grpPr ? directChild(grpPr, 'xfrm') : null;
          const off = xfrm ? directChild(xfrm, 'off') : null;
          const ext = xfrm ? directChild(xfrm, 'ext') : null;
          const chOff = xfrm ? directChild(xfrm, 'choff') : null;
          const chExt = xfrm ? directChild(xfrm, 'chext') : null;
          if (off && ext && chOff && chExt) {
            const gx = offsetX + emuToPx(off.getAttribute('x')) * scaleX;
            const gy = offsetY + emuToPx(off.getAttribute('y')) * scaleY;
            const gw = emuToPx(ext.getAttribute('cx')) * scaleX;
            const gh = emuToPx(ext.getAttribute('cy')) * scaleY;
            const cw = emuToPx(chExt.getAttribute('cx')) || gw || 1;
            const ch = emuToPx(chExt.getAttribute('cy')) || gh || 1;
            const sx = gw / cw;
            const sy = gh / ch;
            const ox = gx - emuToPx(chOff.getAttribute('x')) * sx;
            const oy = gy - emuToPx(chOff.getAttribute('y')) * sy;
            await renderShapeTree(node, ox, oy, sx, sy);
          } else {
            await renderShapeTree(node, offsetX, offsetY, scaleX, scaleY);
          }
          continue;
        }

        const xfrm = findFirstDesc(node, 'xfrm');
        const off = xfrm ? directChild(xfrm, 'off') : null;
        const ext = xfrm ? directChild(xfrm, 'ext') : null;
        if (!off || !ext) continue;

        const x = offsetX + emuToPx(off.getAttribute('x')) * scaleX;
        const y = offsetY + emuToPx(off.getAttribute('y')) * scaleY;
        const w = emuToPx(ext.getAttribute('cx')) * scaleX;
        const h = emuToPx(ext.getAttribute('cy')) * scaleY;
        if (w < 1 && h < 1) continue;

        if (tag === 'pic') {
          const blip = findFirstDesc(node, 'blip');
          const rEmbed = blip?.getAttribute('r:embed') || blip?.getAttribute('embed');
          const mediaPath = rEmbed ? sRels.get(rEmbed) : '';
          const imgUrl = mediaPath ? await getMediaBlobUrl(mediaPath) : '';
          if (imgUrl) {
            elementsHtml.push(`<img src="${escapeHtml(imgUrl)}" style="position:absolute;left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;object-fit:contain;" alt="">`);
          }
          continue;
        }

        if (tag === 'graphicframe') {
          const tbl = findFirstDesc(node, 'tbl');
          if (tbl) {
            const trs = findAllDesc(tbl, 'tr').map((tr) => {
              const tcs = Array.from(tr.children).filter((c) => localTag(c) === 'tc').map((tc) => {
                const txt = findAllDesc(tc, 't').map((tNode) => tNode.textContent || '').join('');
                return `<td style="border:1px solid #cbd5e1;padding:4px 6px;font-size:11px;">${escapeHtml(txt)}</td>`;
              }).join('');
              return `<tr>${tcs}</tr>`;
            }).join('');
            elementsHtml.push(`<div style="position:absolute;left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,0.92);color:#1e293b;">${trs}</table></div>`);
          }
          continue;
        }

        if (tag === 'sp') {
          const spPr = directChild(node, 'sppr');
          const solidFill = spPr ? directChild(spPr, 'solidfill') : null;
          const fillHex = parseColorNode(solidFill, themeMap);
          const ln = spPr ? directChild(spPr, 'ln') : null;
          const lnSolid = ln ? directChild(ln, 'solidfill') : null;
          const strokeHex = parseColorNode(lnSolid, themeMap);

          const txBody = directChild(node, 'txbody');
          const parasHtml = [];
          if (txBody) {
            for (const pNode of Array.from(txBody.children).filter((c) => localTag(c) === 'p')) {
              const pPr = directChild(pNode, 'ppr');
              const algn = pPr?.getAttribute('algn') || 'l';
              const cssAlign = algn === 'ctr' ? 'center' : (algn === 'r' ? 'right' : 'left');
              const buChar = pPr ? findFirstDesc(pPr, 'buchar') : null;
              const bulletPrefix = buChar ? `${escapeHtml(buChar.getAttribute('char') || '•')} ` : '';

              const runs = [];
              for (const rNode of pNode.children) {
                const rTag = localTag(rNode);
                if (rTag === 'br') {
                  runs.push('<br>');
                } else if (rTag === 'r' || rTag === 'fld') {
                  const rPr = directChild(rNode, 'rpr');
                  const tNode = directChild(rNode, 't');
                  const txt = tNode?.textContent || '';
                  if (!txt) continue;
                  const szHundredths = Number(rPr?.getAttribute('sz')) || 1600;
                  const pxFont = Math.max(9, Math.min(64, (szHundredths / 100) * (baseW / 960) * 0.98));
                  const bold = rPr?.getAttribute('b') === '1' ? 'font-weight:700;' : '';
                  const italic = rPr?.getAttribute('i') === '1' ? 'font-style:italic;' : '';
                  const rFill = rPr ? directChild(rPr, 'solidfill') : null;
                  const colorHex = parseColorNode(rFill, themeMap) || '#1e293b';
                  runs.push(`<span style="font-size:${pxFont.toFixed(1)}px;color:${colorHex};${bold}${italic}">${escapeHtml(txt)}</span>`);
                }
              }
              if (runs.length > 0) {
                parasHtml.push(`<div style="text-align:${cssAlign};line-height:1.28;margin-bottom:3px;">${bulletPrefix}${runs.join('')}</div>`);
              }
            }
          }

          const boxBg = fillHex ? `background:${fillHex};` : '';
          const boxBorder = strokeHex ? `border:1px solid ${strokeHex};` : '';
          if (boxBg || boxBorder || parasHtml.length > 0) {
            elementsHtml.push(
              `<div style="position:absolute;left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;${boxBg}${boxBorder}padding:3px 5px;box-sizing:border-box;overflow:hidden;border-radius:3px;">${parasHtml.join('')}</div>`
            );
          }
        }
      }
    };

    const cSld = findFirstDesc(sDoc, 'csld');
    const spTree = cSld ? directChild(cSld, 'sptree') : null;
    await renderShapeTree(spTree);

    slides.push({
      bgStyle,
      html: elementsHtml.join(''),
    });
  }

  return { baseW, baseH, slides };
}

async function renderPureJsPptxSlides(containerEl, { rawUrl, sizeText, apiFetch }) {
  const res = await apiFetch(rawUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const deck = await parsePptxArchivePureJs(buf);
  const total = deck.slides.length;
  if (total === 0) {
    containerEl.innerHTML = `<div class="notice-banner">No slides found in .pptx archive.</div>`;
    return;
  }

  let curIdx = 0;
  let thumbsOpen = total > 1;

  containerEl.innerHTML = `
    <div class="pdf-editorial-viewer pptx-js-viewer">
      <div class="media-toolbar pdf-editorial-toolbar">
        <div class="pdf-toolbar-group">
          <button type="button" class="code-mini-btn ${thumbsOpen ? 'active' : ''}" data-pptx-thumbs>◧</button>
          <span class="pdf-meta-badge">PPTX · ${escapeHtml(t('officeJsModeBadge'))}${sizeText ? ` · ${escapeHtml(sizeText)}` : ''}</span>
        </div>
        <div class="pdf-toolbar-group">
          <button type="button" class="code-mini-btn" data-pptx-prev>‹</button>
          <span class="pdf-page-indicator"><strong data-pptx-cur>1</strong> / ${total}</span>
          <button type="button" class="code-mini-btn" data-pptx-next>›</button>
        </div>
      </div>
      <div class="pdf-stage-body">
        <aside class="pdf-thumbs-rail ${thumbsOpen ? '' : 'hidden'}" data-pptx-rail></aside>
        <div class="pptx-slide-stage" data-pptx-stage tabindex="0">
          <div class="pptx-slide-scaler" data-pptx-scaler></div>
        </div>
      </div>
    </div>
  `;

  const rail = containerEl.querySelector('[data-pptx-rail]');
  const stage = containerEl.querySelector('[data-pptx-stage]');
  const scaler = containerEl.querySelector('[data-pptx-scaler]');
  const curLabel = containerEl.querySelector('[data-pptx-cur]');

  const thumbScale = 116 / deck.baseW;
  const thumbH = Math.round(deck.baseH * thumbScale);
  rail.innerHTML = deck.slides.map((sl, i) => `
    <button type="button" class="pdf-thumb-item ${i === 0 ? 'active' : ''}" data-pptx-idx="${i}">
      <div style="width:116px;height:${thumbH}px;overflow:hidden;position:relative;border-radius:4px;background:#fff;">
        <div style="width:${deck.baseW}px;height:${deck.baseH}px;transform:scale(${thumbScale.toFixed(4)});transform-origin:top left;position:relative;${sl.bgStyle}">${sl.html}</div>
      </div>
      <span>${i + 1}</span>
    </button>
  `).join('');

  const fitSlide = () => {
    const availW = Math.max(240, stage.clientWidth - 36);
    const availH = Math.max(180, stage.clientHeight - 36);
    const s = Math.min(availW / deck.baseW, availH / deck.baseH);
    scaler.style.width = `${Math.round(deck.baseW * s)}px`;
    scaler.style.height = `${Math.round(deck.baseH * s)}px`;
    const inner = scaler.firstElementChild;
    if (inner) inner.style.transform = `scale(${s.toFixed(4)})`;
  };

  const showSlide = (idx) => {
    curIdx = Math.max(0, Math.min(total - 1, idx));
    if (curLabel) curLabel.textContent = String(curIdx + 1);
    const sl = deck.slides[curIdx];
    scaler.innerHTML = `<div class="pptx-slide-canvas" style="width:${deck.baseW}px;height:${deck.baseH}px;transform-origin:top left;position:relative;${sl.bgStyle}">${sl.html}</div>`;
    rail.querySelectorAll('[data-pptx-idx]').forEach((b, i) => b.classList.toggle('active', i === curIdx));
    rail.children[curIdx]?.scrollIntoView({ block: 'nearest' });
    fitSlide();
  };

  containerEl.querySelector('[data-pptx-thumbs]')?.addEventListener('click', (e) => {
    thumbsOpen = !thumbsOpen;
    e.currentTarget.classList.toggle('active', thumbsOpen);
    rail.classList.toggle('hidden', !thumbsOpen);
    fitSlide();
  });
  containerEl.querySelector('[data-pptx-prev]')?.addEventListener('click', () => showSlide(curIdx - 1));
  containerEl.querySelector('[data-pptx-next]')?.addEventListener('click', () => showSlide(curIdx + 1));
  rail.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pptx-idx]');
    if (btn) showSlide(Number(btn.dataset.pptxIdx));
  });
  stage.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); showSlide(curIdx + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); showSlide(curIdx - 1); }
  });

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!stage.isConnected) { ro.disconnect(); return; }
      fitSlide();
    });
    ro.observe(stage);
  }

  showSlide(0);
}

export async function renderPresentationViewer(containerEl, {
  rawUrl,
  filePath = '',
  baseDir = '',
  ext = '.pptx',
  sizeText = '',
  apiFetch = fetch,
} = {}) {
  if (!containerEl) return;
  containerEl.innerHTML = `<div class="doc-viewer-loading">${APPLE_SPINNER_SVG}<span>${escapeHtml(t('officeLoadingPdf'))}</span></div>`;

  // 1. Try high-fidelity local Office / LibreOffice cached PDF conversion first
  if (filePath) {
    try {
      const qs = new URLSearchParams({ path: filePath });
      if (baseDir) qs.set('base', baseDir);
      const conv = await apiFetch(`/api/office-to-pdf?${qs.toString()}`).then((r) => r.json());
      if (conv?.converted && conv.pdfUrl) {
        const jsSwitchBtn = ext === '.pptx'
          ? `<button type="button" class="code-mini-btn" data-switch-pptx-js>${escapeHtml(t('officeJsModeBadge'))}</button>`
          : '';
        await renderCustomPdfViewer(containerEl, {
          rawUrl: conv.pdfUrl,
          sizeText,
          presentationMode: true,
          badgeLabel: `PPTX · ${t('officeHiFiBadge')}`,
          apiFetch,
          extraToolbarBtnHtml: jsSwitchBtn,
          onExtraToolbarClick: (rootEl) => {
            rootEl.querySelector('[data-switch-pptx-js]')?.addEventListener('click', () => {
              renderPureJsPptxSlides(containerEl, { rawUrl, sizeText, apiFetch }).catch(() => {});
            });
          },
        });
        return;
      }
    } catch {}
  }

  // 2. Fallback to built-in Pure-JS OOXML Slide Deck Renderer
  if (ext === '.ppt') {
    containerEl.innerHTML = `<div class="notice-banner error">Legacy binary .ppt requires PowerPoint or LibreOffice installed locally to convert, or save as .pptx.</div>`;
    return;
  }
  try {
    await renderPureJsPptxSlides(containerEl, { rawUrl, sizeText, apiFetch });
  } catch (err) {
    containerEl.innerHTML = `<div class="notice-banner error">PPTX preview failed: ${escapeHtml(err.message)}</div>`;
  }
}
