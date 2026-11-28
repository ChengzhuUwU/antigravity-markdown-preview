import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

const PREVIEW_GLOBS = [
  '*.md', '*.markdown', '*.pdf', '*.docx', '*.doc', '*.xlsx', '*.xls', '*.ods',
  '*.pptx', '*.ppt', '*.mp4', '*.webm', '*.mov', '*.mp3', '*.wav',
  '*.png', '*.jpg', '*.jpeg', '*.svg', '*.csv', '*.jsonl', '*.txt',
];

const PICKER_TITLE = 'Select File to Preview';

/**
 * Node has no file dialog. Each OS uses the dialog that ships with it.
 * Linux desktops do not share one tool, so the first installed candidate wins.
 */
export function pickerCandidates(platform = process.platform) {
  if (platform === 'win32') return [{ id: 'powershell', command: 'powershell.exe' }];
  if (platform === 'darwin') return [{ id: 'osascript', command: 'osascript' }];
  if (platform === 'linux') {
    return [
      { id: 'zenity', command: 'zenity' },
      { id: 'kdialog', command: 'kdialog' },
      { id: 'qarma', command: 'qarma' },
      { id: 'yad', command: 'yad' },
    ];
  }
  return [];
}

function fallbackPaths(command, platform) {
  if (platform === 'win32' && command === 'powershell.exe') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return [join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
  }
  if (platform === 'darwin' && command === 'osascript') return ['/usr/bin/osascript'];
  return [];
}

export function commandOnPath(command, env = process.env, platform = process.platform) {
  const pathVal = env.PATH || env.Path || '';
  if (!pathVal || !command) return false;
  const alreadyHasExt = platform === 'win32' && extname(command);
  const exts = platform === 'win32' && !alreadyHasExt
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of pathVal.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, `${command}${ext}`), constants.F_OK);
        return true;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return false;
}

export function defaultCommandExists(command, platform = process.platform, env = process.env) {
  if (commandOnPath(command, env, platform)) return true;
  return fallbackPaths(command, platform).some((candidate) => existsSync(candidate));
}

const resolvedCache = new Map();

export function clearNativeFilePickerCache() {
  resolvedCache.clear();
}

export async function resolveNativeFilePicker(platform = process.platform, exists = defaultCommandExists) {
  const cacheable = exists === defaultCommandExists;
  if (cacheable && resolvedCache.has(platform)) return resolvedCache.get(platform);
  let found = null;
  for (const candidate of pickerCandidates(platform)) {
    if (await exists(candidate.command, platform)) {
      found = candidate;
      break;
    }
  }
  if (cacheable) resolvedCache.set(platform, found);
  return found;
}

function windowsFilter() {
  const list = PREVIEW_GLOBS.join(';');
  return `Docs, Office & Media (${list})|${list}|All Files (*.*)|*.*`;
}

function zenityFilterArgs() {
  return [
    `--file-filter=Docs, Office & Media | ${PREVIEW_GLOBS.join(' ')}`,
    '--file-filter=All files | *',
  ];
}

export function buildPickerLaunch(providerId) {
  if (providerId === 'powershell') {
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$top = New-Object System.Windows.Forms.Form',
      '$top.TopMost = $true',
      '$top.ShowInTaskbar = $false',
      '$top.Opacity = 0',
      '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
      `$dlg.Filter = '${windowsFilter()}'`,
      `$dlg.Title = '${PICKER_TITLE}'`,
      `if ($dlg.ShowDialog($top) -eq 'OK') { Write-Output $dlg.FileName }`,
      '$top.Dispose()',
    ].join('; ');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-STA', '-Command', psScript],
      options: { windowsHide: true },
    };
  }
  if (providerId === 'osascript') {
    return {
      command: 'osascript',
      args: ['-e', `POSIX path of (choose file with prompt "${PICKER_TITLE}")`],
      options: { windowsHide: true },
    };
  }
  if (providerId === 'kdialog') {
    return {
      command: 'kdialog',
      args: ['--title', PICKER_TITLE, '--getopenfilename', '.', `${PREVIEW_GLOBS.join(' ')}|Docs, Office & Media`],
      options: { windowsHide: true },
    };
  }
  if (providerId === 'yad') {
    return {
      command: 'yad',
      args: ['--file-selection', `--title=${PICKER_TITLE}`, ...zenityFilterArgs()],
      options: { windowsHide: true },
    };
  }
  return {
    command: providerId === 'qarma' ? 'qarma' : 'zenity',
    args: ['--file-selection', `--title=${PICKER_TITLE}`, ...zenityFilterArgs()],
    options: { windowsHide: true },
  };
}

export function cleanPickedPath(text) {
  let value = String(text || '').replace(/^\uFEFF/, '').trim();
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

export function interpretPickerOutput({ code, stdout, errorCode } = {}) {
  if (errorCode) return { available: false, canceled: false, path: '' };
  const path = cleanPickedPath(stdout);
  if (code === 0 && path) return { available: true, canceled: false, path };
  return { available: true, canceled: true, path: '' };
}

function once(fn) {
  let done = false;
  return (...args) => {
    if (done) return undefined;
    done = true;
    return fn(...args);
  };
}

export async function runNativeFilePicker({
  platform = process.platform,
  exists = defaultCommandExists,
  spawnImpl = spawn,
} = {}) {
  const provider = await resolveNativeFilePicker(platform, exists);
  if (!provider) return { available: false, canceled: false, path: '', provider: '' };
  const launch = buildPickerLaunch(provider.id);
  const output = await new Promise((resolveRun) => {
    const finish = once(resolveRun);
    let child;
    try {
      child = spawnImpl(launch.command, launch.args, launch.options);
    } catch (err) {
      finish({ code: -1, stdout: '', errorCode: err?.code || 'ERROR' });
      return;
    }
    if (!child) {
      finish({ code: -1, stdout: '', errorCode: 'ERROR' });
      return;
    }
    let stdout = '';
    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.resume?.();
    child.on?.('error', (err) => finish({ code: -1, stdout, errorCode: err?.code || 'ERROR' }));
    child.on?.('close', (code) => finish({ code: code ?? -1, stdout, errorCode: '' }));
  });
  return { ...interpretPickerOutput(output), provider: provider.id };
}
