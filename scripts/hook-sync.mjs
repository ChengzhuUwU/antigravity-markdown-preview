import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVER_JSON = join(homedir(), '.gemini', 'cache', 'agy-markdown-preview', 'server.json');

function readStdinSyncFast() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function forwardToServer(port, payloadRaw) {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/hook-event',
        method: 'POST',
        timeout: 250,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadRaw),
        },
      },
      (res) => {
        res.resume();
        resolve();
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.on('error', () => resolve());
    req.write(payloadRaw);
    req.end();
  });
}

async function main() {
  try {
    if (!existsSync(SERVER_JSON)) {
      process.stdout.write('{}');
      return;
    }
    const info = JSON.parse(readFileSync(SERVER_JSON, 'utf-8'));
    if (!info?.port) {
      process.stdout.write('{}');
      return;
    }
    const raw = await readStdinSyncFast();
    if (raw.trim()) {
      await forwardToServer(info.port, raw);
    }
  } catch {
    // Hooks must fail open and never disrupt the agent loop
  }
  process.stdout.write('{}');
}

main();
