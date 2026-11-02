const test = require('node:test');
const assert = require('node:assert/strict');
const { createGistStore, SyncAuthError, FILE, DESCRIPTION } = require('./sync.js');

function reply(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function storeWith(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options });
    return handler(url, options);
  };
  return { store: createGistStore({ token: 'tok', fetchImpl }), calls };
}

test('каждый запрос к GitHub идёт с токеном и без кэша браузера', async () => {
  const { store, calls } = storeWith(() => reply(200, []));
  await store.find();
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].cache, 'no-store');
});

test('find находит gist приложения и пропускает чужие', async () => {
  const { store } = storeWith(() => reply(200, [
    { id: 'other', description: 'Заметки', files: { 'a.md': {} } },
    { id: 'same-name', description: DESCRIPTION, files: { 'a.md': {} } },
    { id: 'mine', description: DESCRIPTION, files: { [FILE]: {} } },
  ]));
  assert.equal(await store.find(), 'mine');
});

test('find листает страницы и возвращает null, если gist нет', async () => {
  const full = Array.from({ length: 100 }, (_, index) => ({ id: `g${index}`, description: 'x', files: {} }));
  const { store, calls } = storeWith((url) => reply(200, /[?&]page=1(&|$)/.test(url) ? full : []));
  assert.equal(await store.find(), null);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes('page=2'));
});

test('create делает приватный gist', async () => {
  const { store, calls } = storeWith(() => reply(201, { id: 'new' }));
  assert.equal(await store.create({ answers: {} }), 'new');
  const body = JSON.parse(calls[0].body);
  assert.equal(calls[0].method, 'POST');
  assert.equal(body.public, false);
  assert.equal(body.description, DESCRIPTION);
  assert.deepEqual(JSON.parse(body.files[FILE].content), { answers: {} });
});

test('read возвращает текст файла', async () => {
  const { store } = storeWith(() => reply(200, { files: { [FILE]: { content: '{"a":1}' } } }));
  assert.equal(await store.read('g'), '{"a":1}');
});

test('read забирает длинный файл целиком по raw_url', async () => {
  const { store, calls } = storeWith((url) => (url === 'https://raw.example/f'
    ? reply(200, 'целиком')
    : reply(200, { files: { [FILE]: { content: 'обрез', truncated: true, raw_url: 'https://raw.example/f' } } })));
  assert.equal(await store.read('g'), 'целиком');
  assert.equal(calls[1].headers, undefined, 'токен не уходит на другой адрес');
});

test('read: удалённый gist или gist без файла дают null', async () => {
  assert.equal(await storeWith(() => reply(404, {})).store.read('g'), null);
  assert.equal(await storeWith(() => reply(200, { files: {} })).store.read('g'), null);
});

test('write обновляет файл через PATCH', async () => {
  const { store, calls } = storeWith(() => reply(200, {}));
  await store.write('g', { answers: { 1: {} } });
  assert.equal(calls[0].method, 'PATCH');
  assert.ok(calls[0].url.endsWith('/gists/g'));
  assert.deepEqual(JSON.parse(JSON.parse(calls[0].body).files[FILE].content), { answers: { 1: {} } });
});

test('плохой токен отличается от других ошибок', async () => {
  await assert.rejects(storeWith(() => reply(401, {})).store.find(), SyncAuthError);
  await assert.rejects(storeWith(() => reply(403, {})).store.read('g'), SyncAuthError);
  await assert.rejects(storeWith(() => reply(500, {})).store.find(), (error) => !(error instanceof SyncAuthError));
});
