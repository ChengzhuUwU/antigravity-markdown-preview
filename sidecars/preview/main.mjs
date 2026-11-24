import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPreviewEngine } from '../../server/app.mjs';

async function loadSidecarApp() {
  try {
    const mod = await import('sidecar_sdk');
    return mod.SidecarApp;
  } catch {
    // Fallback to ~/.gemini/config/node_modules/sidecar_sdk if NODE_PATH wasn't inherited
    const fallbackPath = join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs');
    if (existsSync(fallbackPath)) {
      const mod = await import(pathToFileURL(fallbackPath).href);
      return mod.SidecarApp;
    }
    const req = createRequire(import.meta.url);
    return req('sidecar_sdk').SidecarApp;
  }
}

const SidecarApp = await loadSidecarApp();
const UI_TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';

function isTokenValid(req, url) {
  if (!UI_TOKEN) return true;
  const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
  return provided === UI_TOKEN;
}

const app = new SidecarApp();
const server = await app.run();
const defaultSidecarListener = server.listeners('request')[0];
server.removeAllListeners('request');

const engine = createPreviewEngine({
  tokenValidator: isTokenValid,
  onExtraRoute: async (req, res, url) => {
    if (url.pathname === '/preload.js' || url.pathname.startsWith('/_sidecar/')) {
      defaultSidecarListener(req, res);
      return true;
    }
    return false;
  },
});

server.on('request', (req, res) => {
  engine.handleRequest(req, res).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

function shutdown() {
  engine.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
