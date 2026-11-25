# Changelog

All notable changes to **Antigravity Session Preview (`agy-session-preview`)** will be documented in this file.

## [0.4.0] - 2026-11-26

### Added
- **Theme-Native Custom `PDF.js` & Offline Office Suite (`Word`, `Excel`, `PowerPoint`) Previews (`public/js/doc-viewers.js`, `server/office-convert.mjs`)**:
  - Replaced native browser `<iframe>` PDF rendering with an offline, lazy-loaded **`PDF.js v4`** viewer matching all `2 × 8 + Custom RGB` themes, supporting HiDPI canvas rendering, selectable `TextLayer`, collapsible page thumbnails, `#page=N` deep links, `↔ Width` / `⊡ Page` fit modes, 90° rotation, and eye-comfort **`◐ Tint` dark-paper filter**.
  - **Word (`.docx` / `.doc`)**: Offline `docx-preview` + `JSZip` paper layout viewer with zoom, width fit, and `◐ Tint` dark-paper filter (with local Word/LibreOffice -> PDF conversion fallback for legacy binary `.doc`).
  - **Excel (`.xlsx` / `.xls` / `.ods`)**: Offline `SheetJS` multi-worksheet viewer featuring sheet tabs, merged cells (`!merges`), sticky `A/B/C` column & row headers, tabular numeric right alignment, and instant row search filtering.
  - **PowerPoint (`.pptx` / `.ppt`)**: Dual-mode hybrid slide deck viewer combining content-addressed SHA1 cached vector PDF conversion (via local PowerPoint COM or LibreOffice headless) with a built-in pure-JS `JSZip + DOMParser` OOXML slide renderer fallback.
- **Three-State Session Status Indicators (Apple Spinner + Unread Highlight)**:
  - Active sessions and collapsed parent project folders now display a calm, neutral **Apple-style 12-spoke activity spinner** while running, and light up with the theme's **`var(--accent)` highlight dot + bold title + `Unread` (`未读`) pill** only when a background session completes with unread updates (clearing immediately upon viewing).
- **Reader Font Size Stepper & Decoupled Multilingual Typography**:
  - Added a **`Font Size` (`正文字号`)** stepper (`−` / `12px–24px` / `+` / `↺ Reset`) scaling reader stage prose, headings, prompts, callouts, tables, and code blocks proportionally without shifting topbar/sidebar UI chrome.
  - Upgraded `Font` into a collapsible vertical picker adding **`Times New Roman`**, and automatically splitting into independent **`英文字体` (`Sans` · `Serif` · `Times New Roman`) × `中文字体` (`无衬线 Sans` · `现代衬线 Serif` · `华文宋体` · `楷体` · `仿宋`)** selectors in `简体中文` mode with `@font-face { size-adjust }` optical baseline calibration.
- **Multi-Candidate Named Custom RGB Palettes**:
  - Upgraded `Custom RGB` into a persistent user palette library (`+ New Custom RGB` / `+ 新增自定义配色`, inline `✎` rename, `✕` delete, and `/api/custom-palettes` disk + SSE sync across windows) with automatic migration from legacy single-slot `amp-custom-rgb`.
- **Live `update_steps` Checklist & `agy-preview --restart`**:
  - Rendered live `update_steps` progress cards above each turn's `Execution process` fold without collapsing open cards mid-turn, added `agy-preview --restart` with automatic browser reload (`serverBootId`), and refreshed all `docs/screenshots/*.png` showcase images.

### Fixed
- **Live Sidebar Running Status Sync**: Opened SQLite `conversation_summaries.db` with WAL visibility (`readOnly` without `immutable`) and enriched `/api/conversations` + SSE updates with live hook and transcript telemetry so sidebar session and project indicators update in real time.

## [0.3.1] - 2026-11-25

### Added
- **Sub-Second Live Streaming & Progressive `--stdin` Pipe**: Added a `280ms` byte-offset live poller (`server/app.mjs`, active only while SSE clients are connected) paired with real-time `.system_generated/tasks/task-*.log` command output tailing, flicker-free in-place turn patching (`patchTurnElementInPlace`), auto-follow scroll pause/resume, and progressive `180ms` chunk streaming for `agy-preview --stdin`.
- **Pinned Sessions (`★ Pinned` / `★ 置顶会话`)**: Added a `☆ / ★` star toggle in the Preview topbar and on sidebar session rows, persisting starred sessions in `pinned-sessions.json` and displaying them in a dedicated `★ Pinned` section above all project folders.
- **One-Click Project Folder Collapse / Expand (`⊟ Collapse` / `⊞ Expand`)**: Added a toggle button next to the sidebar flavor selector to collapse or expand all project folders at once without affecting pinned sessions.
- **Adaptive Horizontal-Fill Mermaid Layout & `↔ Expand` / `↔ Fit Width`**: Disabled Mermaid's cyclic `useMaxWidth` collapse, added `ResizeObserver`-driven horizontal width filling across inline diagrams, added one-click `↔ Expand` (`↔ 铺宽`) full-viewport breakout on diagram cards, and added `↔ Fit Width` (`↔ 铺满宽度`) + live resize re-fitting inside `#mermaid-modal`.

### Fixed
- **Verified Native `📂 Folder` (`📂 目录`) + In-App Directory Browser Fallback**: Switched Windows Explorer launch to verbatim `/select,"<path>"` with `Shell.Application` window verification and foreground activation, automatically falling back to an interactive in-app folder browser (plus clipboard path copy) when running inside sandboxed or remote server environments, and standardized `/preview` on the global `agy-preview` CLI.

## [0.3.0] - 2026-11-25

### Added
- **Server Password Protection (`server/auth.mjs`)**: Optional password authentication (disabled by default) manageable via `agy-preview password <set | cancel | disable | activate | print>` (or `--set-password` / `--cancel-password` / `--disable-password` / `--activate-password` / `--print-password`) and `/preview password ...`, backed by `0600` persistent config, `HttpOnly` HMAC-signed session cookies, login rate limiting, `--host` binding, and topbar `🔒 Lock`.
- **Expanded Media & Tabular File Previews (`PDF`, `Video`, `Audio`, `CSV/TSV`)**: Inline PDF viewer (`#page=N`), video/audio players with HTTP `Range` (`206 Partial Content`) byte-range streaming, playback speed (`0.5×–2×`) and loop controls, interactive CSV/TSV table + raw toggle, and inline Markdown `<video>` / `<audio>` embeds.
- **Custom Two-Color RGB Theme Panel**: Added `Custom RGB` (`自定义 RGB 配色`) to the `Preferences ▾` menu with live `Background` + `Accent` RGB (`0–255`) sliders, `#HEX` input, and native color picker deriving harmonious Light/Dark surface tokens in real time.
- **Larger & User-Resizable Mermaid Fullscreen Modal**: Expanded `#mermaid-modal` to `97vw × 94vh` by default, added 8-direction edge/corner drag-to-resize handles with `localStorage` size persistence, and added a `⤢ Full Window` (`100%`) toggle.

### Fixed
- **Windows Sidebar `📂 Folder` (`📂 目录`) & Native File Picker**: Fixed path quoting, plain-directory resolution (folders without `README.md`), and foreground window activation when opening File Explorer from the background server, plus TopMost file-picker focus and narrow-screen (`<=860px`) Outline drawer visibility.

### Changed
- **Renamed Plugin ID & Display Name to Session Preview (`agy-session-preview`)**: Aligned plugin manifest (`plugin.json`), Sidecar UI (`sidecar://agy-session-preview/preview/`), frontend title & EN/ZH branding (`Session Preview` / `会话预览器`), hooks (`session-preview-sync`), package metadata (`antigravity-session-preview`), and docs with the renamed GitHub repository while keeping the `agy-preview` CLI command and `/preview` slash command intact.
- **Automatic Legacy Data & Install Migration**: Automatically copies existing `docs-store.json`, `clips/`, `btw-notes.json`, and `auth-config.json` from `%APPDATA%/agy-markdown-preview` (and macOS/Linux equivalents) into `agy-session-preview` on startup, and removes legacy `~/.gemini/config/plugins/agy-markdown-preview` during `npm run install-plugin`.

## [0.2.1] - 2026-11-24

### Added
- **Unified Persistent `Preferences` Menu**: Consolidated persistent display settings (`Language`, `Font: Sans / Serif`, `Width: Normal / Wide`, `Tables: Fit / Expand`, `2` Light/Dark modes, and `8` Color Palettes separated by dividers) into a single `Preferences ▾` dropdown immediately to the left of `↻ Sync`.
- **Full Bilingual UI Localization (`English` Default / `简体中文`)**: Added `public/js/i18n.js` synchronizing all topbar controls, sidebar menus, Mermaid fullscreen/zoom tooltips (`⛶ Fullscreen` / `⛶ 大屏预览`), file preview actions (`📂 Folder` / `📂 目录`), and `/btw` · `/context` · `/usage` inspector labels in real time without page reloads.

## [0.2.0] - 2026-11-24

### Added
- **Mermaid v12 + ELK Orthogonal Pastel Engine**: Upgraded offline Mermaid bundle to `v12.3.0` with built-in **ELK (`Eclipse Layout Kernel`)** orthogonal port routing, quadratic-rounded 90° connector elbows, automatic multi-stage pastel pill nodes (`rx=10px`, Light & Dark adaptive), and automatic fallback for specialized diagram types.
- **Interactive Mermaid Viewport & Fullscreen Lightbox**: Added inline & fullscreen (`⛶ 大屏预览`) pan-and-zoom canvas (mouse wheel zoom around cursor, drag-to-pan, `100%` / `⊡ 适应窗口` quick fit, and one-click vector `.svg` download).
- **Topbar `Tools` Menu & Quick Jump**: Consolidated `/btw`, `/context`, and `/usage` into a topbar `Tools ▾` dropdown with a top-pinned drawer, added `⤒` / `⤓` jump-to-top/bottom buttons, and added automatic Hook capture for CLI `/btw` answers.

## [0.1.0] - 2026-11-24

### Added
- **2 × 8 Customizable Reading Themes**: Topbar `Theme` menu featuring **2 brightness modes (`Light` / `Dark`)** separated from **8 curated color palettes** (`Parchment`, `Lavender · 淡紫`, `Sakura · 淡粉`, `Matcha · 淡翠`, `Glacier · 雾蓝`, `Amber · 暖杏`, `Celadon · 青瓷`, `Slate · 冷岩`), plus Sans/Serif typography toggle, Normal/Wide reading column, standalone `--app` desktop window, and Antigravity 2.0 Sidecar (`sidecar://agy-markdown-preview/preview/`).
- **Project-Grouped Sessions & Auto-Folded Execution**:
  - Sessions grouped by workspace project, sorted by latest activity, auto-expanding projects active within the last 3 days.
  - Subagent threads collapsed by default in the sidebar (`▸ N subagents`) with inline `Subagents invoked in this session` cards and `View Subagent` / `← Parent` navigation.
  - High-level `Execution process` auto-folding (thoughts, tool groups, unified `edit_file` diffs, and spooled outputs collapsed by default; auto-collapses when a running turn finishes).
  - Opens conversations directly at the **latest user prompt**; right-hand **Outline** displays turn numbers paired with user prompt snippets.
  - Full-text sidebar & in-page (`Ctrl+K` / `/`) search across project names, titles, and SQLite FTS5 `user_body` prompts.
- **Session CLI Inspector (`/btw` · `/context` · `/usage`)**:
  - **`/context`**: 10×10 proportional context-window cell grid, category token breakdown (`System & Customizations`, `User messages`, `Agent responses`, `Tool calls`, `Free capacity`, `Checkpoints`), prompt cache hit rate, and tracked session artifacts.
  - **`/usage`**: Rolling 5-Hour & 7-Day local token consumption grouped by model family (`Gemini` vs `Claude / GPT`) plus per-model session breakdown.
  - **`/btw`**: Lists side-question commands from CLI `history.jsonl` and supports pinning `/copy btw` Markdown answers directly to the session.
- **Standalone `Docs / Clips` Manager & Dual File Previews**:
  - Persistent OS user-data storage (`%APPDATA%/agy-markdown-preview/docs-store.json` on Windows, `~/Library/Application Support/...` on macOS, `~/.local/share/...` on Linux) with hover preview cards, drag-and-drop reorder, inline rename, and delete.
  - Accurate relative path & image resolution for dragged, browsed (`📂 Browse…`), or pasted Markdown files.
  - Clicking a local hyperlink opens a **Popup Preview Modal**, while clicking **`Open in sidebar`** opens the resizable **Right Split Preview Pane** (supporting Markdown, syntax-highlighted code with `#Lstart-Lend` line highlights, images, and `📂 目录` native folder reveal).
- **Rich Offline Markdown Engine**:
  - Bundled `marked`, `highlight.js`, `KaTeX` (`$...$`, `$$...$$`), lazy `Mermaid`, GitHub/Obsidian callouts (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), CJK bold punctuation compatibility, and **Expandable Wide Tables** (`Tables: Expand`, up to `50vw` per column with smooth horizontal slider).
