import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

const CACHE_DIR = join(tmpdir(), 'agy-session-preview-office-pdf');
const inFlightConversions = new Map();

function findLibreOfficeBinary() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/LibreOffice.app/Contents/MacOS/soffice',
          '/opt/homebrew/bin/soffice',
          '/usr/local/bin/soffice',
        ]
      : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/snap/bin/libreoffice'];

  return candidates.find((p) => existsSync(p)) || '';
}

function runCommandWithTimeout(cmd, args, { env, timeoutMs = 25000 } = {}) {
  return new Promise((resolveRun) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (res) => {
      if (settled) return;
      settled = true;
      resolveRun(res);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: env || process.env });
    } catch (err) {
      finish({ ok: false, error: err.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: 'Conversion timed out' });
    }, timeoutMs);

    child.stdout?.on('data', (c) => { stdout += c.toString('utf-8'); });
    child.stderr?.on('data', (c) => { stderr += c.toString('utf-8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function tryConvertViaLibreOffice(sofficeBin, inputPath, outPdfPath) {
  const stageDir = `${outPdfPath}.lo_${process.pid}_${Date.now()}`;
  mkdirSync(stageDir, { recursive: true });
  try {
    const res = await runCommandWithTimeout(sofficeBin, [
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      stageDir,
      inputPath,
    ]);
    const stem = basename(inputPath, extname(inputPath));
    const generated = join(stageDir, `${stem}.pdf`);
    if (res.ok && existsSync(generated) && statSync(generated).size > 64) {
      renameSync(generated, outPdfPath);
      return { ok: true, converter: 'libreoffice' };
    }
    return { ok: false, error: res.stderr || res.error || 'LibreOffice did not produce PDF' };
  } finally {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch {}
  }
}

async function tryConvertViaWindowsCom(inputPath, outPdfPath) {
  const ext = extname(inputPath).toLowerCase();
  const isSlide = ext === '.pptx' || ext === '.ppt';
  const isWord = ext === '.docx' || ext === '.doc';
  if (!isSlide && !isWord) return { ok: false, error: 'Unsupported COM extension' };

  const tmpOut = `${outPdfPath}.tmp_${process.pid}_${Date.now()}.pdf`;
  const psScript = isSlide
    ? [
        `$ErrorActionPreference = 'Stop'`,
        `$inFile = $env:AMP_OFFICE_IN`,
        `$outFile = $env:AMP_OFFICE_OUT`,
        `$app = New-Object -ComObject PowerPoint.Application`,
        `$wasEmpty = ($app.Presentations.Count -eq 0)`,
        `$pres = $null`,
        `try {`,
        `  $pres = $app.Presentations.Open($inFile, -1, 0, 0)`,
        `  $pres.SaveAs($outFile, 32)`,
        `  Write-Output 'COM_OK'`,
        `} finally {`,
        `  if ($pres -ne $null) { try { $pres.Close() } catch {} }`,
        `  if ($wasEmpty -and $app.Presentations.Count -eq 0) { try { $app.Quit() } catch {} }`,
        `}`,
      ].join('; ')
    : [
        `$ErrorActionPreference = 'Stop'`,
        `$inFile = $env:AMP_OFFICE_IN`,
        `$outFile = $env:AMP_OFFICE_OUT`,
        `$word = New-Object -ComObject Word.Application`,
        `$wasEmpty = ($word.Documents.Count -eq 0)`,
        `$word.Visible = $false`,
        `$doc = $null`,
        `try {`,
        `  $doc = $word.Documents.Open($inFile, $false, $true)`,
        `  $doc.ExportAsFixedFormat($outFile, 17)`,
        `  Write-Output 'COM_OK'`,
        `} finally {`,
        `  if ($doc -ne $null) { try { $doc.Close($false) } catch {} }`,
        `  if ($wasEmpty -and $word.Documents.Count -eq 0) { try { $word.Quit() } catch {} }`,
        `}`,
      ].join('; ');

  try {
    const res = await runCommandWithTimeout('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], {
      env: {
        ...process.env,
        AMP_OFFICE_IN: inputPath.replace(/\//g, '\\'),
        AMP_OFFICE_OUT: tmpOut.replace(/\//g, '\\'),
      },
      timeoutMs: 28000,
    });
    if (res.stdout?.includes('COM_OK') && existsSync(tmpOut) && statSync(tmpOut).size > 64) {
      renameSync(tmpOut, outPdfPath);
      return { ok: true, converter: isSlide ? 'powerpoint-com' : 'word-com' };
    }
    return { ok: false, error: res.stderr || res.error || 'Office COM unavailable' };
  } finally {
    try { if (existsSync(tmpOut)) rmSync(tmpOut, { force: true }); } catch {}
  }
}

export function getOfficePdfCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

export function resolveCachedOfficePdfByName(cacheFileName) {
  if (!cacheFileName || !/^[a-f0-9]{40}\.pdf$/i.test(cacheFileName)) return '';
  const full = join(getOfficePdfCacheDir(), cacheFileName);
  return existsSync(full) ? full : '';
}

export async function convertOfficeFileToPdfCached(inputPath) {
  const st = statSync(inputPath);
  const hash = createHash('sha1')
    .update(`${inputPath}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex');
  const cacheFileName = `${hash}.pdf`;
  const outPdfPath = join(getOfficePdfCacheDir(), cacheFileName);

  if (existsSync(outPdfPath) && statSync(outPdfPath).size > 64) {
    return { converted: true, cacheFileName, pdfPath: outPdfPath, converter: 'cache' };
  }

  if (inFlightConversions.has(cacheFileName)) {
    return inFlightConversions.get(cacheFileName);
  }

  const promise = (async () => {
    const soffice = findLibreOfficeBinary();
    if (soffice) {
      const loRes = await tryConvertViaLibreOffice(soffice, inputPath, outPdfPath);
      if (loRes.ok) {
        return { converted: true, cacheFileName, pdfPath: outPdfPath, converter: loRes.converter };
      }
    }
    if (process.platform === 'win32') {
      const comRes = await tryConvertViaWindowsCom(inputPath, outPdfPath);
      if (comRes.ok) {
        return { converted: true, cacheFileName, pdfPath: outPdfPath, converter: comRes.converter };
      }
    }
    return { converted: false, reason: 'No local Office or LibreOffice PDF converter available' };
  })().finally(() => {
    inFlightConversions.delete(cacheFileName);
  });

  inFlightConversions.set(cacheFileName, promise);
  return promise;
}
