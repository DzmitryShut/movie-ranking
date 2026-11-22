// Serves the app and keeps its data in one file, for use behind `tailscale serve`.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_BODY = 5 * 1024 * 1024;
const KEEP_BACKUPS = 30;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
// Not part of the page.
const HIDDEN = /^(server\.js|.*\.test\.js)$/;

function defaultDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), '.local', 'share');
  return path.join(base, 'movie-ranking');
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function createServer({ root = __dirname, dataDir = defaultDataDir() } = {}) {
  const dataFile = path.join(dataDir, 'data.json');
  const backupDir = path.join(dataDir, 'backups');

  // Keeps the first copy of each day, so a bad write can be undone by hand.
  async function backUp() {
    const day = new Date().toISOString().slice(0, 10);
    await fs.mkdir(backupDir, { recursive: true });
    try {
      await fs.copyFile(dataFile, path.join(backupDir, `data-${day}.json`), fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
      return;
    }
    const old = (await fs.readdir(backupDir)).filter((name) => name.startsWith('data-')).sort().slice(0, -KEEP_BACKUPS);
    await Promise.all(old.map((name) => fs.rm(path.join(backupDir, name))));
  }

  async function writeData(text) {
    await fs.mkdir(dataDir, { recursive: true });
    await backUp();
    const temp = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, text);
    await fs.rename(temp, dataFile);
  }

  async function handleData(request, response) {
    if (request.method === 'GET') {
      try {
        const text = await fs.readFile(dataFile, 'utf8');
        return send(response, 200, text, 'application/json; charset=utf-8');
      } catch (error) {
        if (error.code === 'ENOENT') return send(response, 404, 'no data');
        throw error;
      }
    }
    if (request.method === 'PUT') {
      const text = await readBody(request);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return send(response, 400, 'not json');
      }
      if (!parsed || typeof parsed.answers !== 'object') return send(response, 400, 'not app data');
      await writeData(text);
      return send(response, 204, '');
    }
    return send(response, 405, 'method not allowed');
  }

  async function handleStatic(request, response, pathname) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'method not allowed');
    const name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const type = TYPES[path.extname(name)];
    if (!type || name.includes('/') || name.includes('\\') || name.startsWith('.') || HIDDEN.test(name)) {
      return send(response, 404, 'not found');
    }
    try {
      const body = await fs.readFile(path.join(root, name));
      // Always ask again, so a pulled update shows up on the next open.
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (error.code === 'ENOENT') return send(response, 404, 'not found');
      throw error;
    }
  }

  return http.createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      if (pathname === '/api/health') return send(response, 200, JSON.stringify({ app: 'movie-ranking' }), 'application/json');
      if (pathname === '/api/data') return await handleData(request, response);
      return await handleStatic(request, response, pathname);
    } catch (error) {
      if (!error.status) console.error(error);
      if (!response.headersSent) send(response, error.status || 500, error.status ? error.message : 'server error');
    }
  });
}

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8417;
  const dataDir = process.env.DATA_DIR || defaultDataDir();
  // Only this machine: tailscale serve is the way in from other devices.
  createServer({ dataDir }).listen(port, '127.0.0.1', () => {
    console.log(`movie-ranking on http://127.0.0.1:${port}, data in ${dataDir}`);
  });
}
