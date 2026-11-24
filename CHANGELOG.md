# Changelog

All notable changes to **Antigravity Markdown Preview (`agy-markdown-preview`)** will be documented in this file.

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
