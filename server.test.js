const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./server.js');
const { createServerStore, detectServer } = require('./sync.js');

async function start() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'movie-ranking-'));
  const server = createServer({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return {
    base,
    dataDir,
    get: (p, options) => fetch(base + p, options),
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('сервер отдаёт страницу и скрипты, но не себя, тесты и чужие пути', async (t) => {
  const s = await start();
  t.after(s.stop);
  const page = await s.get('');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await s.get('app.js')).status, 200);
  for (const p of ['server.js', 'sync.test.js', '.git/config', '..%2Fserver.js', 'README.md']) {
    assert.equal((await s.get(p)).status, 404, p);
  }
});

test('хранилище сервера: пусто, создать, прочитать, перезаписать', async (t) => {
  const s = await start();
  t.after(s.stop);
  const store = createServerStore({ fetchImpl: fetch, base: s.base + 'api/' });
  assert.equal(await detectServer({ fetchImpl: fetch, base: s.base + 'api/' }), true);
  assert.equal(await store.find(), null);
  const id = await store.create({ answers: { 1: 'seen' }, updatedAt: 1 });
  assert.equal(await store.find(), id);
  assert.deepEqual(JSON.parse(await store.read(id)), { answers: { 1: 'seen' }, updatedAt: 1 });
  await store.write(id, { answers: {}, updatedAt: 2 });
  assert.equal(JSON.parse(await store.read(id)).updatedAt, 2);
  // The first copy of the day is kept as a backup.
  const backups = await fs.readdir(path.join(s.dataDir, 'backups'));
  assert.equal(backups.length, 1);
});

test('сервер не принимает то, что не похоже на данные приложения', async (t) => {
  const s = await start();
  t.after(s.stop);
  assert.equal((await s.get('api/data', { method: 'PUT', body: 'oops' })).status, 400);
  assert.equal((await s.get('api/data', { method: 'PUT', body: '{"x":1}' })).status, 400);
  assert.equal((await s.get('api/data')).status, 404);
});

test('на статическом хостинге сервер не находится', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  assert.equal(await detectServer({ fetchImpl }), false);
  const offline = async () => { throw new Error('offline'); };
  assert.equal(await detectServer({ fetchImpl: offline }), false);
});
