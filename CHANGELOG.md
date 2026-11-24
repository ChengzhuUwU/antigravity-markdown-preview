# Changelog

All notable changes to **Antigravity Session Preview (`agy-session-preview`)** will be documented in this file.

## [Unreleased]

### Changed
- **Renamed Plugin ID & Display Name to Session Preview (`agy-session-preview`)**: Aligned plugin manifest (`plugin.json`), Sidecar UI (`sidecar://agy-session-preview/preview/`), frontend title & EN/ZH branding (`Session Preview` / `会话预览器`), hooks (`session-preview-sync`), package metadata (`antigravity-session-preview`), and docs with the renamed GitHub repository while keeping the `agy-preview` CLI command and `/preview` slash command intact.
- **Automatic Legacy Data & Install Migration**: Automatically copies existing `docs-store.json`, `clips/`, and `btw-notes.json` from `%APPDATA%/agy-markdown-preview` (and macOS/Linux equivalents) into `agy-session-preview` on startup, and removes legacy `~/.gemini/config/plugins/agy-markdown-preview` during `npm run install-plugin`.

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
