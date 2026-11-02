// Stores the app's data in a private GitHub gist, so every device sees the same marks.
(function (root) {
  const API = 'https://api.github.com';
  const FILE = 'movie-ranking.json';
  const DESCRIPTION = 'Movie ranking data (private, managed by the app)';
  const PER_PAGE = 100;
  const MAX_PAGES = 10;

  class SyncAuthError extends Error {}

  function createGistStore({ token, fetchImpl, description = DESCRIPTION }) {
    async function request(path, options = {}) {
      const response = await fetchImpl(API + path, {
        ...options,
        // The API allows browsers to cache gists for a minute: that would hide the other device.
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      if (response.status === 401 || response.status === 403) {
        throw new SyncAuthError('GitHub не принял токен: возможно, он истёк или у него нет права gist');
      }
      return response;
    }

    async function expectOk(response) {
      if (!response.ok) throw new Error(`GitHub ответил ошибкой ${response.status}`);
      return response.json();
    }

    // Finds the gist another device already created.
    async function find() {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const gists = await expectOk(await request(`/gists?per_page=${PER_PAGE}&page=${page}`));
        const match = gists.find((gist) => gist.description === description && gist.files[FILE]);
        if (match) return match.id;
        if (gists.length < PER_PAGE) return null;
      }
      return null;
    }

    async function create(data) {
      const gist = await expectOk(await request('/gists', {
        method: 'POST',
        body: JSON.stringify({
          description,
          public: false,
          files: { [FILE]: { content: JSON.stringify(data) } },
        }),
      }));
      return gist.id;
    }

    // The gist's text, or null if the gist is gone.
    async function read(id) {
      const response = await request(`/gists/${id}`);
      if (response.status === 404) return null;
      const gist = await expectOk(response);
      const file = gist.files[FILE];
      if (!file) return null;
      if (!file.truncated) return file.content;
      // GitHub cuts long files out of this response; the raw address has them whole.
      const raw = await fetchImpl(file.raw_url, { cache: 'no-store' });
      if (!raw.ok) throw new Error(`GitHub ответил ошибкой ${raw.status}`);
      return raw.text();
    }

    async function write(id, data) {
      await expectOk(await request(`/gists/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(data) } } }),
      }));
    }

    return { find, create, read, write };
  }

  const api = { createGistStore, SyncAuthError, FILE, DESCRIPTION };
  root.MovieSync = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
