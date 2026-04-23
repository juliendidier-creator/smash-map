import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const PORT = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// SSE clients waiting for scraper output
const sseClients = new Set();

function broadcast(data) {
  for (const res of sseClients) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- POST /refresh : lance le scraper ---
  if (req.method === 'POST' && url.pathname === '/refresh') {
    res.writeHead(200, { 'Content-Type': 'application/json' });

    const child = spawn('node', ['scrape.mjs'], { cwd: DIR });

    child.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) broadcast({ type: 'log', text: line });
    });
    child.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) broadcast({ type: 'log', text: '⚠️ ' + line });
    });
    child.on('close', code => {
      broadcast({ type: code === 0 ? 'done' : 'error', code });
    });

    res.end(JSON.stringify({ started: true }));
    return;
  }

  // --- GET /refresh-events : SSE pour suivre la progression ---
  if (req.method === 'GET' && url.pathname === '/refresh-events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // --- Fichiers statiques ---
  let filePath = join(DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));
});

server.listen(PORT, () => {
  console.log(`\n🎮 Carte SSBU → http://localhost:${PORT}\n`);
});
