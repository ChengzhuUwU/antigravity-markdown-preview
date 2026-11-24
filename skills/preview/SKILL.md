---
name: preview
description: Open the lightweight editorial Session Preview window (or side pane) for the active Antigravity CLI/Desktop conversation, a Markdown file, or CLI output. Use whenever the user invokes /preview or asks to preview CLI output or markdown cleanly.
---

# Session Preview (`/preview`)

Open a lightweight, real-time standalone Session & Markdown preview window where thinking chains and tool calls are collapsed by default, featuring 2×8 customizable Light/Dark color themes, KaTeX math, lazy Mermaid diagrams, Obsidian/GitHub callouts, and instant SSE synchronization.

## Step 1: Locate the Launcher Script

Resolve `bin/agy-preview.mjs` from the installed plugin directory (or workspace copy if developing locally):

- Installed location: `~/.gemini/config/plugins/agy-session-preview/bin/agy-preview.mjs`
- Workspace fallback: `./bin/agy-preview.mjs`

## Step 2: Launch or Focus the Standalone Window

> [!IMPORTANT]
> Antigravity's `run_command` terminates non-daemon subprocess trees (Windows Job Objects / process groups) when a tool call finishes. Therefore, **you MUST set `IsDaemon: true` and `WaitMsBeforeAsync: 3000`** with `--foreground` so the local HTTP + SSE preview server stays alive in the background across turns! (If a preview server is already running on port `19420`, `--foreground` automatically reuses it, focuses/opens the window, and exits cleanly.)

### Case A — Preview the current (or specific) Antigravity conversation

Call `run_command` with **`IsDaemon: true`** and **`WaitMsBeforeAsync: 3000`**, substituting `<CONVERSATION_ID>` from `<user_information>`:

- **PowerShell (Windows):**
  ```powershell
  $launcher = "$HOME\.gemini\config\plugins\agy-session-preview\bin\agy-preview.mjs"; if (!(Test-Path $launcher)) { $launcher = "$HOME\.gemini\config\plugins\agy-markdown-preview\bin\agy-preview.mjs" }; if (!(Test-Path $launcher)) { $launcher = ".\bin\agy-preview.mjs" }; node $launcher --foreground --conv "<CONVERSATION_ID>" --open
  ```

- **Bash (macOS / Linux):**
  ```bash
  LAUNCHER="$HOME/.gemini/config/plugins/agy-session-preview/bin/agy-preview.mjs"; [ -f "$LAUNCHER" ] || LAUNCHER="$HOME/.gemini/config/plugins/agy-markdown-preview/bin/agy-preview.mjs"; [ -f "$LAUNCHER" ] || LAUNCHER="./bin/agy-preview.mjs"; node "$LAUNCHER" --foreground --conv "<CONVERSATION_ID>" --open
  ```

### Case B — User specified a Markdown / JSONL / text file (`/preview path/to/file.md`)

Call `run_command` with **`IsDaemon: true`** and **`WaitMsBeforeAsync: 3000`**, passing `--foreground --file "<FILE_PATH>" --open`:

```powershell
$launcher = "$HOME\.gemini\config\plugins\agy-session-preview\bin\agy-preview.mjs"; if (!(Test-Path $launcher)) { $launcher = "$HOME\.gemini\config\plugins\agy-markdown-preview\bin\agy-preview.mjs" }; if (!(Test-Path $launcher)) { $launcher = ".\bin\agy-preview.mjs" }; node $launcher --foreground --file "<FILE_PATH>" --open
```

## Step 3: Respond Concisely

Return the preview URL printed by the launcher (`http://127.0.0.1:19420/...`), mention key shortcuts (`R` sync, `T` theme, `O` outline, `P` open/paste Markdown), and if running inside Antigravity 2.0 Desktop, also provide the side-pane link:

`[Session Preview](sidecar://agy-session-preview/preview/)`
