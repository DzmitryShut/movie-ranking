(function () {
  const {
    BUCKETS,
    aggregatePeople,
    buildDeck,
    seenFilms,
    unsortedFilms,
    pendingFilms,
    normalizeData,
    decideSync,
    mergeData,
    startInsertion,
    comparisonIndex,
    chooseInsertion,
    finishInsertion,
    comparisonsLeft,
    ratingGroups,
    personGroups,
    parseBackup,
  } = window.MovieLogic;

  const API = 'https://api.themoviedb.org/3';
  const IMAGES = 'https://image.tmdb.org/t/p';
  const KEY_STORAGE = 'movie-ranking:key';
  const DATA_STORAGE = 'movie-ranking:data';
  const PEOPLE_STORAGE = 'movie-ranking:people';
  const WORLD_PAGES = 15;
  const RUSSIAN_PAGES = 3;
  const CONCURRENCY = 8;
  const SWIPE_DISTANCE = 100;
  const TMDB_NOTICE = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';

  const { createGistStore, SyncAuthError } = window.MovieSync;
  const TOKEN_STORAGE = 'movie-ranking:github-token';
  const GIST_STORAGE = 'movie-ranking:gist-id';
  const SYNCED_STORAGE = 'movie-ranking:synced-at';
  const FORCE_PUSH_STORAGE = 'movie-ranking:force-push';
  const SYNC_DEBOUNCE = 2000;
  const STARTUP_SYNC_WAIT = 4000;
  const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Movie%20ranking';

  const app = document.getElementById('app');
  let data = loadData();
  let savedBody = contentOf(data);
  let keyHandler = null;
  let appStarted = false;
  let syncTimer = null;
  let syncRunning = false;
  let syncAgain = false;
  let syncStatus = { state: 'idle', message: '' };
  let onSyncStatus = () => {};

  function loadData() {
    try {
      const saved = JSON.parse(localStorage.getItem(DATA_STORAGE));
      if (saved && saved.answers) {
        const loaded = normalizeData(saved);
        // Marks made before sync existed have no revision, yet must not lose to a remote copy.
        if (!loaded.updatedAt && Object.keys(loaded.answers).length) loaded.updatedAt = Date.now();
        return loaded;
      }
    } catch (error) {
      console.error('Не удалось прочитать сохранённые данные', error);
    }
    return normalizeData({});
  }

  // The data without its revision: rendering re-saves often, and only real changes count.
  function contentOf(value) {
    return JSON.stringify({ ...value, updatedAt: 0 });
  }

  function saveData() {
    const body = contentOf(data);
    if (body !== savedBody) {
      savedBody = body;
      data.updatedAt = Date.now();
      scheduleSync();
    }
    localStorage.setItem(DATA_STORAGE, JSON.stringify(data));
  }

  // Saves after an edit, dropping ranking state the edit made stale.
  function commit() {
    data = normalizeData(data);
    saveData();
  }

  function setFilmBucket(id, bucket) {
    if (bucket) data.answers[id].bucket = bucket;
    else delete data.answers[id].bucket;
    data.answers[id].changedAt = Date.now();
    commit();
  }

  function setSyncStatus(state, message) {
    syncStatus = { state, message };
    onSyncStatus();
  }

  function scheduleSync(delay = SYNC_DEBOUNCE) {
    if (!localStorage.getItem(TOKEN_STORAGE)) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, delay);
  }

  function replaceLocal(next) {
    data = next;
    savedBody = contentOf(data);
    localStorage.setItem(DATA_STORAGE, JSON.stringify(data));
  }

  async function syncOnce(store) {
    let gistId = localStorage.getItem(GIST_STORAGE) || await store.find();
    if (!gistId) {
      const pushedAt = data.updatedAt;
      gistId = await store.create(data);
      localStorage.setItem(GIST_STORAGE, gistId);
      localStorage.setItem(SYNCED_STORAGE, String(pushedAt));
      // The new gist holds this data, so a restore waiting to be pushed is done.
      localStorage.removeItem(FORCE_PUSH_STORAGE);
      return false;
    }
    localStorage.setItem(GIST_STORAGE, gistId);

    const localAt = data.updatedAt;
    const text = await store.read(gistId);
    if (text === null) {
      // The gist was deleted: start a new one from this device's data.
      localStorage.removeItem(GIST_STORAGE);
      localStorage.removeItem(SYNCED_STORAGE);
      syncAgain = true;
      return false;
    }
    let remote;
    try {
      remote = parseBackup(text);
    } catch {
      // Never overwrite what can't be understood: the user may want it back.
      throw new Error('данные в gist повреждены, отметки на этом устройстве не тронуты');
    }
    // The user changed something while the request was on its way: look again.
    if (data.updatedAt !== localAt) {
      syncAgain = true;
      return false;
    }

    const syncedAt = Number(localStorage.getItem(SYNCED_STORAGE)) || 0;
    const action = localStorage.getItem(FORCE_PUSH_STORAGE)
      ? 'push'
      : decideSync({ localAt, remoteAt: remote.updatedAt, syncedAt });
    if (action === 'none') {
      localStorage.setItem(SYNCED_STORAGE, String(localAt));
      return false;
    }
    if (action === 'pull') {
      replaceLocal(remote);
      localStorage.setItem(SYNCED_STORAGE, String(remote.updatedAt));
      return true;
    }
    if (action === 'merge') {
      const merged = mergeData(data, remote);
      merged.updatedAt = Date.now();
      replaceLocal(merged);
    }
    const pushedAt = data.updatedAt;
    await store.write(gistId, data);
    localStorage.setItem(SYNCED_STORAGE, String(pushedAt));
    localStorage.removeItem(FORCE_PUSH_STORAGE);
    return action === 'merge';
  }

  async function runSync() {
    const token = localStorage.getItem(TOKEN_STORAGE);
    if (!token) return;
    if (syncRunning) {
      syncAgain = true;
      return;
    }
    syncRunning = true;
    clearTimeout(syncTimer);
    setSyncStatus('running', '');
    let dataReplaced = false;
    try {
      dataReplaced = await syncOnce(createGistStore({ token, fetchImpl: (...args) => fetch(...args) }));
      const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      setSyncStatus('ok', `Синхронизировано в ${time}`);
    } catch (error) {
      console.error(error);
      setSyncStatus('error', error instanceof SyncAuthError
        ? error.message
        : `Не получилось синхронизировать: ${error.message}`);
    } finally {
      syncRunning = false;
    }
    if (dataReplaced && appStarted) {
      // Every open screen was drawn from the old data.
      location.reload();
      return;
    }
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(0);
    }
  }

  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(props || {})) {
      if (name === 'on') {
        for (const [event, handler] of Object.entries(value)) element.addEventListener(event, handler);
      } else if (name === 'class') {
        element.className = value;
      } else if (name.includes('-')) {
        element.setAttribute(name, value);
      } else {
        element[name] = value;
      }
    }
    element.append(...children.flat());
    return element;
  }

  function show(...children) {
    keyHandler = null;
    onSyncStatus = () => {};
    app.replaceChildren(...children);
    window.scrollTo(0, 0);
  }

  function imageUrl(path, size) {
    return `${IMAGES}/${size}${path}`;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  class AuthError extends Error {}

  async function tmdb(path, params = {}, attempt = 0) {
    const key = localStorage.getItem(KEY_STORAGE) || '';
    const url = new URL(API + path);
    url.searchParams.set('language', 'ru-RU');
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const headers = {};
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    else url.searchParams.set('api_key', key);

    const response = await fetch(url, { headers });
    if (response.status === 401) throw new AuthError('TMDB не принял ключ');
    if (response.status === 429 && attempt < 3) {
      await wait(1000 * (attempt + 1));
      return tmdb(path, params, attempt + 1);
    }
    if (!response.ok) throw new Error(`TMDB ответил ошибкой ${response.status}`);
    return response.json();
  }

  async function mapLimited(items, limit, task, onProgress) {
    const results = new Array(items.length);
    let next = 0;
    let finished = 0;
    async function worker() {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index]);
        finished += 1;
        onProgress(finished, items.length);
      }
    }
    await Promise.all(Array.from({ length: limit }, worker));
    return results;
  }

  function pages(count, params) {
    return Array.from({ length: count }, (_, index) => ({ ...params, page: index + 1 }));
  }

  // Людей берём из самых известных фильмов: так в списке те, кого реально могли смотреть.
  async function loadPeople(onProgress) {
    const cached = localStorage.getItem(PEOPLE_STORAGE);
    if (cached) return JSON.parse(cached);

    const base = { sort_by: 'vote_count.desc', include_adult: false };
    const requests = [
      ...pages(WORLD_PAGES, base),
      ...pages(RUSSIAN_PAGES, { ...base, with_original_language: 'ru' }),
    ];
    const lists = await mapLimited(requests, CONCURRENCY, (params) => tmdb('/discover/movie', params), () => {});
    const ids = [...new Set(lists.flatMap((list) => list.results.map((film) => film.id)))];
    const credits = await mapLimited(ids, CONCURRENCY, (id) => tmdb(`/movie/${id}/credits`), onProgress);
    const people = aggregatePeople(credits);
    localStorage.setItem(PEOPLE_STORAGE, JSON.stringify(people));
    return people;
  }

  function header(title, ...actions) {
    return h('div', { class: 'row spread' }, h('h1', { textContent: title }), h('div', { class: 'row' }, actions));
  }

  function failure(error, retry) {
    if (error instanceof AuthError) {
      showSetup(error.message);
      return;
    }
    console.error(error);
    show(h('div', { class: 'stack' },
      h('p', { class: 'error', textContent: `Не получилось загрузить данные: ${error.message}` }),
      h('button', { textContent: 'Повторить', on: { click: retry } })));
  }

  function showSetup(message) {
    const input = h('input', {
      placeholder: 'Ключ API или токен доступа TMDB',
      value: localStorage.getItem(KEY_STORAGE) || '',
      autocomplete: 'off',
    });
    const status = h('p', { class: 'error', textContent: message || '' });
    const save = async (event) => {
      event.preventDefault();
      const key = input.value.trim();
      if (!key) return;
      localStorage.setItem(KEY_STORAGE, key);
      status.textContent = '';
      try {
        await tmdb('/configuration');
        showPeople();
      } catch (error) {
        status.textContent = error.message;
      }
    };
    show(h('form', { class: 'stack', on: { submit: save } },
      h('h1', { textContent: 'Мои фильмы' }),
      h('p', {},
        'Нужен бесплатный ключ TMDB: ',
        h('a', {
          href: 'https://www.themoviedb.org/settings/api',
          target: '_blank',
          rel: 'noreferrer',
          textContent: 'создать в настройках аккаунта',
        }),
        '. Он хранится только в этом браузере.'),
      input,
      h('button', { type: 'submit', textContent: 'Продолжить' }),
      status,
      h('p', { class: 'muted', textContent: TMDB_NOTICE })));
    input.focus();
  }

  async function showPeople(tab = 'directors') {
    const progress = h('p', { class: 'muted', textContent: 'Собираю список режиссёров и актёров…' });
    show(progress);
    let people;
    try {
      people = await loadPeople((finished, total) => {
        progress.textContent = `Собираю список режиссёров и актёров: ${finished} из ${total} фильмов`;
      });
    } catch (error) {
      failure(error, () => showPeople(tab));
      return;
    }
    renderPeople(people, tab);
  }

  function renderPeople(people, initialTab) {
    let tab = initialTab;
    let searchToken = 0;
    const list = h('ul', { class: 'people' });
    const status = h('p', { class: 'muted' });
    const tabs = {
      directors: h('button', { class: 'tab', textContent: 'Режиссёры', on: { click: () => selectTab('directors') } }),
      actors: h('button', { class: 'tab', textContent: 'Актёры', on: { click: () => selectTab('actors') } }),
    };
    const search = h('input', {
      type: 'search',
      placeholder: 'Найти режиссёра или актёра',
      on: { input: () => runSearch(search.value.trim()) },
    });

    function roleOf(personTab) {
      return personTab === 'directors' ? 'director' : 'actor';
    }

    function renderList(items) {
      list.replaceChildren(...items.map(({ person, role }) => {
        const done = data.done[`${role}:${person.id}`];
        return h('li', {}, h('button', {
          class: done ? 'person done' : 'person',
          on: { click: () => showDeck(person, role, tab) },
        },
        person.photo
          ? h('img', { src: imageUrl(person.photo, 'w185'), alt: '', loading: 'lazy' })
          : h('span', { class: 'nophoto' }),
        h('span', { class: 'caption', textContent: done ? `${person.name} ✓` : person.name })));
      }));
    }

    function selectTab(next) {
      tab = next;
      search.value = '';
      searchToken += 1;
      status.textContent = '';
      for (const [name, button] of Object.entries(tabs)) button.setAttribute('aria-pressed', name === tab);
      renderList(people[tab].map((person) => ({ person, role: roleOf(tab) })));
    }

    let debounce;
    function runSearch(query) {
      clearTimeout(debounce);
      searchToken += 1;
      const token = searchToken;
      if (!query) {
        selectTab(tab);
        return;
      }
      debounce = setTimeout(async () => {
        try {
          const { results } = await tmdb('/search/person', { query, include_adult: false });
          if (token !== searchToken) return;
          status.textContent = results.length ? '' : 'Никого не нашлось';
          renderList(results.map((person) => ({
            person: { id: person.id, name: person.name, photo: person.profile_path || null },
            role: person.known_for_department === 'Directing' ? 'director' : 'actor',
          })));
        } catch (error) {
          if (token !== searchToken) return;
          status.textContent = `Поиск не сработал: ${error.message}`;
        }
      }, 300);
    }

    const toSort = unsortedFilms(data.answers).length + pendingFilms(data.answers, data.ranking).length;
    show(h('div', { class: 'stack' },
      header('Мои фильмы',
        h('button', {
          textContent: `Мой рейтинг: ${seenFilms(data.answers).length}${toSort ? ` (разобрать: ${toSort})` : ''}`,
          on: { click: () => showRating(tab) },
        }),
        h('button', { textContent: '⚙', title: 'Настройки', 'aria-label': 'Настройки', on: { click: () => showSettings(tab) } })),
      syncStatus.state === 'error'
        ? h('p', { class: 'error', textContent: `${syncStatus.message}. Подробнее в настройках.` })
        : [],
      h('div', { class: 'row' }, tabs.directors, tabs.actors),
      search,
      status,
      list,
      h('p', { class: 'muted', textContent: TMDB_NOTICE })));
    selectTab(tab);
  }

  async function showDeck(person, role, backTab) {
    show(h('p', { class: 'muted', textContent: `Загружаю фильмы: ${person.name}…` }));
    let credits;
    try {
      credits = await tmdb(`/person/${person.id}/movie_credits`);
    } catch (error) {
      failure(error, () => showDeck(person, role, backTab));
      return;
    }
    renderDeck(person, role, credits, backTab);
  }

  function renderDeck(person, role, credits, backTab) {
    const today = new Date().toISOString().slice(0, 10);
    const doneKey = `${role}:${person.id}`;
    const history = [];
    let busy = false;
    // A right swipe says "seen" and leaves the card up, waiting for a bucket.
    let asking = false;

    function top(...children) {
      return h('div', { class: 'row spread' },
        h('button', { textContent: '← К списку', on: { click: () => showPeople(backTab) } }),
        h('span', { class: 'muted' }, children));
    }

    function undo() {
      while (history.length) {
        const id = history.pop();
        // The film may already have been removed from the list below.
        if (data.answers[id]) {
          delete data.answers[id];
          commit();
          render();
          return;
        }
      }
    }

    function record(film, status, bucket, direction) {
      if (busy) return;
      busy = true;
      asking = false;
      const card = app.querySelector('.card');
      card.classList.add('flying');
      card.style.transform = `translateX(${direction * 120}%) rotate(${direction * 12}deg)`;
      setTimeout(() => {
        data.answers[film.id] = {
          status,
          title: film.title,
          year: film.year,
          poster: film.poster,
          at: Date.now(),
          ...(bucket ? { bucket } : {}),
        };
        commit();
        history.push(film.id);
        busy = false;
        render();
      }, 150);
    }

    function goRight(film) {
      if (asking) {
        record(film, 'seen', null, 1);
        return;
      }
      asking = true;
      render();
    }

    function goLeft(film) {
      record(film, 'unseen', null, -1);
    }

    function attachSwipe(card, seenStamp, unseenStamp, film) {
      const restingSeen = asking ? 1 : 0;
      let startX = null;
      let dx = 0;
      card.addEventListener('pointerdown', (event) => {
        startX = event.clientX;
        card.setPointerCapture(event.pointerId);
      });
      card.addEventListener('pointermove', (event) => {
        if (startX === null) return;
        dx = event.clientX - startX;
        card.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
        seenStamp.style.opacity = Math.max(restingSeen, Math.min(Math.max(dx, 0) / SWIPE_DISTANCE, 1));
        unseenStamp.style.opacity = Math.min(Math.max(-dx, 0) / SWIPE_DISTANCE, 1);
      });
      const finish = () => {
        if (startX === null) return;
        startX = null;
        if (dx > SWIPE_DISTANCE) goRight(film);
        else if (dx < -SWIPE_DISTANCE) goLeft(film);
        else {
          card.style.transform = '';
          seenStamp.style.opacity = restingSeen;
          unseenStamp.style.opacity = 0;
        }
        dx = 0;
      };
      card.addEventListener('pointerup', finish);
      card.addEventListener('pointercancel', finish);
    }

    function refresh() {
      const scroll = window.scrollY;
      render();
      window.scrollTo(0, scroll);
    }

    function watchedSections() {
      return personGroups(credits, role, data.answers, data.ranking).map((group) => h('section', { class: 'stack' },
        h('h2', { class: 'group-title', textContent: `${group.label}: ${group.films.length}` }),
        h('ul', { class: 'film-list' }, group.films.map((film) => filmRow(film, refresh)))));
    }

    function render() {
      const deck = buildDeck(credits, role, data.answers, today);
      // Галочка актуальна, только пока нечего отмечать: фильм могли убрать из просмотренных.
      if (deck.length) delete data.done[doneKey];
      else data.done[doneKey] = true;
      saveData();

      const undoButton = h('button', {
        textContent: '↩',
        title: 'Отменить (Backspace)',
        disabled: !history.length,
        on: { click: undo },
      });

      if (!deck.length) {
        show(h('div', { class: 'stack' },
          h('div', { class: 'sort stack' },
            top(person.name),
            h('p', { textContent: `Все фильмы отмечены: ${person.name}` }),
            h('div', { class: 'row' }, undoButton)),
          watchedSections()));
        keyHandler = (event) => {
          if (event.key === 'Backspace') undo();
        };
        return;
      }

      const film = deck[0];
      if (deck[1] && deck[1].poster) new Image().src = imageUrl(deck[1].poster, 'w500');
      const seenStamp = h('span', { class: 'stamp seen', textContent: 'ВИДЕЛ' });
      const unseenStamp = h('span', { class: 'stamp unseen', textContent: 'НЕ ВИДЕЛ' });
      seenStamp.style.opacity = asking ? 1 : 0;
      const yearLine = film.originalTitle && film.originalTitle !== film.title
        ? `${film.originalTitle}, ${film.year}`
        : film.year;
      const card = h('article', { class: 'card fit' },
        poster(film, 'w500'),
        seenStamp,
        unseenStamp,
        h('div', { class: 'info' },
          h('h2', { textContent: film.title }),
          h('p', { class: asking ? 'prompt' : 'muted', textContent: asking ? 'Видел. Выбери корзину' : yearLine })));
      attachSwipe(card, seenStamp, unseenStamp, film);

      show(h('div', { class: 'stack' },
        h('div', { class: 'sort stack' },
          top(`${person.name}: осталось ${deck.length}`),
          card,
          h('div', { class: asking ? 'buckets asking' : 'buckets' }, BUCKETS.map((bucket, index) => h('button', {
            textContent: `${index + 1}. ${bucket.label}`,
            on: { click: () => record(film, 'seen', bucket.id, 1) },
          }))),
          h('div', { class: 'actions' },
            h('button', { class: 'no', textContent: '✕ Не видел', on: { click: () => goLeft(film) } }),
            undoButton,
            h('button', {
              class: 'yes',
              textContent: asking ? 'Выберу потом' : '✓ Видел',
              on: { click: () => goRight(film) },
            }))),
        watchedSections()));
      keyHandler = (event) => {
        if (event.repeat) return;
        const bucket = BUCKETS[Number(event.key) - 1];
        if (bucket) record(film, 'seen', bucket.id, 1);
        else if (event.key === 'ArrowRight') goRight(film);
        else if (event.key === 'ArrowLeft') goLeft(film);
        else if (event.key === 'Backspace') {
          if (asking) {
            asking = false;
            render();
          } else {
            undo();
          }
        }
      };
    }

    render();
  }

  function downloadBackup() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = h('a', {
      href: URL.createObjectURL(blob),
      download: `my-films-${new Date().toISOString().slice(0, 10)}.json`,
    });
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function poster(film, size) {
    return film.poster
      ? h('img', { src: imageUrl(film.poster, size), alt: '', draggable: false })
      : h('div', { class: 'noposter', textContent: 'Нет постера' });
  }

  function filmOf(id) {
    return { ...data.answers[id], id };
  }

  function showSorting(backTab) {
    const history = [];

    function undo() {
      const id = history.pop();
      if (id === undefined) return;
      setFilmBucket(id, null);
      render();
    }

    function choose(film, bucket) {
      setFilmBucket(film.id, bucket);
      history.push(film.id);
      render();
    }

    function render() {
      const queue = unsortedFilms(data.answers);
      if (!queue.length) {
        if (pendingFilms(data.answers, data.ranking).length) showCompare(backTab);
        else showRating(backTab);
        return;
      }
      const film = queue[0];
      if (queue[1] && queue[1].poster) new Image().src = imageUrl(queue[1].poster, 'w500');
      show(h('div', { class: 'sort stack' },
        h('div', { class: 'row spread' },
          h('button', { textContent: '← К рейтингу', on: { click: () => showRating(backTab) } }),
          h('span', { class: 'muted', textContent: `Осталось разложить: ${queue.length}` })),
        h('article', { class: 'card still fit' },
          poster(film, 'w500'),
          h('div', { class: 'info' },
            h('h2', { textContent: film.title }),
            h('p', { class: 'muted', textContent: film.year }))),
        h('div', { class: 'buckets' }, BUCKETS.map((bucket, index) => h('button', {
          textContent: `${index + 1}. ${bucket.label}`,
          on: { click: () => choose(film, bucket.id) },
        }))),
        h('button', {
          textContent: '↩ Отменить',
          title: 'Backspace',
          disabled: !history.length,
          on: { click: undo },
        })));
      keyHandler = (event) => {
        if (event.repeat) return;
        const bucket = BUCKETS[Number(event.key) - 1];
        if (bucket) choose(film, bucket.id);
        else if (event.key === 'Backspace') undo();
      };
    }

    render();
  }

  function showCompare(backTab) {
    const history = [];

    function undo() {
      const last = history.pop();
      if (!last) return;
      data.ranking = last.ranking;
      data.insertion = last.insertion;
      commit();
      render();
    }

    function choose(preferNewFilm) {
      history.push({ ranking: [...data.ranking], insertion: data.insertion });
      data.insertion = chooseInsertion(data.insertion, preferNewFilm);
      render();
    }

    function versus(film, caption, preferNewFilm) {
      return h('button', { class: 'versus', on: { click: () => choose(preferNewFilm) } },
        poster(film, 'w500'),
        h('span', { class: 'versus-title', textContent: film.title }),
        h('span', { class: 'muted', textContent: `${film.year} · ${caption}` }));
    }

    function render() {
      if (!data.insertion) {
        const [next] = pendingFilms(data.answers, data.ranking);
        if (!next) {
          commit();
          showRating(backTab);
          return;
        }
        data.insertion = startInsertion(next.id, data.ranking.length);
      }
      const index = comparisonIndex(data.insertion);
      if (index === null) {
        data.ranking = finishInsertion(data.ranking, data.insertion);
        data.insertion = null;
        render();
        return;
      }
      commit();

      const waiting = pendingFilms(data.answers, data.ranking).length;
      show(h('div', { class: 'compare stack' },
        h('div', { class: 'row spread' },
          h('button', { textContent: '← К рейтингу', on: { click: () => showRating(backTab) } }),
          h('span', {
            class: 'muted',
            textContent: `Осталось добавить: ${waiting}. Для этого фильма ещё вопросов: до ${comparisonsLeft(data.insertion)}`,
          })),
        h('h1', { class: 'center', textContent: 'Какой лучше?' }),
        h('div', { class: 'versus-grid' },
          versus(filmOf(data.insertion.filmId), 'новый', true),
          versus(filmOf(data.ranking[index]), `сейчас ${index + 1}-е место`, false)),
        h('div', { class: 'center' }, h('button', {
          textContent: '↩ Отменить',
          title: 'Backspace',
          disabled: !history.length,
          on: { click: undo },
        }))));
      keyHandler = (event) => {
        if (event.repeat) return;
        if (event.key === 'ArrowLeft') choose(true);
        else if (event.key === 'ArrowRight') choose(false);
        else if (event.key === 'Backspace') undo();
      };
    }

    render();
  }

  // One watched film with its bucket controls, on the ranking screen and on a person's page.
  function filmRow(film, refresh) {
    function setBucket(bucket) {
      setFilmBucket(film.id, bucket);
      refresh();
    }

    function compareAgain() {
      data.ranking = data.ranking.filter((id) => id !== film.id);
      commit();
      refresh();
    }

    function remove() {
      delete data.answers[film.id];
      commit();
      refresh();
    }

    const select = h('select', {
      title: 'Корзина',
      on: { change: () => setBucket(select.value) },
    },
    h('option', { value: '', textContent: 'Без корзины' }),
    BUCKETS.map((bucket) => h('option', { value: bucket.id, textContent: bucket.label })));
    select.value = film.bucket || '';

    return h('li', { class: 'film-row' },
      h('span', { class: 'rank', textContent: film.rank || '' }),
      h('div', { class: 'thumb' }, poster(film, 'w92')),
      h('div', { class: 'film-meta' },
        h('div', { textContent: film.title }),
        h('div', {
          class: 'muted',
          textContent: film.bucket === 'top' && !film.rank ? `${film.year} · ждёт сравнения` : film.year,
        })),
      h('div', { class: 'row' },
        select,
        film.rank ? h('button', { textContent: 'Сравнить заново', on: { click: compareAgain } }) : [],
        h('button', { textContent: 'Убрать', on: { click: remove } })));
  }

  function showRating(backTab) {
    function refresh() {
      const scroll = window.scrollY;
      showRating(backTab);
      window.scrollTo(0, scroll);
    }

    const total = seenFilms(data.answers).length;
    const unsorted = unsortedFilms(data.answers).length;
    const pending = pendingFilms(data.answers, data.ranking).length;
    const groups = ratingGroups(data.answers, data.ranking);

    show(h('div', { class: 'stack' },
      header('Мой рейтинг',
        h('button', { textContent: '← К списку', on: { click: () => showPeople(backTab) } })),
      unsorted || pending
        ? h('div', { class: 'row' },
          unsorted
            ? h('button', {
              class: 'primary',
              textContent: `Разложить по корзинам: ${unsorted}`,
              on: { click: () => showSorting(backTab) },
            })
            : [],
          pending
            ? h('button', {
              class: 'primary',
              textContent: `Сравнить фильмы: ${pending}`,
              on: { click: () => showCompare(backTab) },
            })
            : [])
        : [],
      total
        ? groups.map((group) => h('section', { class: 'stack' },
          h('h2', { class: 'group-title', textContent: `${group.label}: ${group.films.length}` }),
          h('ul', { class: 'film-list' }, group.films.map((film) => filmRow(film, refresh)))))
        : h('p', { class: 'muted', textContent: 'Пока пусто: выбери человека и начни свайпать.' })));
  }

  function showSettings(backTab) {
    const status = h('p', { class: 'muted' });
    const fileInput = h('input', {
      type: 'file',
      accept: 'application/json',
      hidden: true,
      on: {
        change: async () => {
          const [file] = fileInput.files;
          if (!file) return;
          try {
            const text = await file.text();
            // Otherwise the browser ignores picking the same file again.
            fileInput.value = '';
            const backup = parseBackup(text);
            if (!confirm('Заменить текущие отметки и рейтинг данными из файла?')) return;
            data = backup;
            // A restore is a deliberate overwrite: it has to beat what the gist holds.
            localStorage.setItem(FORCE_PUSH_STORAGE, '1');
            savedBody = '';
            saveData();
            status.textContent = `Загружено фильмов: ${Object.keys(data.answers).length}`;
          } catch (error) {
            status.textContent = `Файл не подошёл: ${error.message}`;
          }
        },
      },
    });

    const syncLine = h('p', { class: 'muted' });
    const syncBox = h('div', { class: 'stack' });

    function renderSync() {
      const connected = Boolean(localStorage.getItem(TOKEN_STORAGE));
      syncLine.className = syncStatus.state === 'error' ? 'error' : 'muted';
      syncLine.textContent = {
        running: 'Синхронизирую…',
        ok: syncStatus.message,
        error: syncStatus.message,
        idle: connected ? 'Подключено' : '',
      }[syncStatus.state];

      if (connected) {
        syncBox.replaceChildren(h('div', { class: 'row' },
          h('button', { textContent: 'Синхронизировать сейчас', on: { click: runSync } }),
          h('button', {
            textContent: 'Отключить на этом устройстве',
            on: {
              click: () => {
                localStorage.removeItem(TOKEN_STORAGE);
                localStorage.removeItem(GIST_STORAGE);
                localStorage.removeItem(SYNCED_STORAGE);
                localStorage.removeItem(FORCE_PUSH_STORAGE);
                setSyncStatus('idle', '');
                renderSync();
              },
            },
          })));
        return;
      }

      const input = h('input', {
        type: 'password',
        placeholder: 'Токен GitHub',
        autocomplete: 'off',
      });
      const connect = (event) => {
        event.preventDefault();
        const token = input.value.trim();
        if (!token) return;
        localStorage.setItem(TOKEN_STORAGE, token);
        runSync();
        renderSync();
      };
      syncBox.replaceChildren(h('form', { class: 'stack', on: { submit: connect } },
        h('p', {},
          'Отметки и рейтинг будут одинаковыми на всех устройствах и сохранятся в твоём приватном gist. ',
          h('a', {
            href: TOKEN_URL,
            target: '_blank',
            rel: 'noreferrer',
            textContent: 'Создай токен',
          }),
          ' с правом gist, срок выбери No expiration, и вставь его сюда. На втором устройстве вставь этот же токен.'),
        input,
        h('button', { type: 'submit', textContent: 'Подключить' })));
    }

    show(h('div', { class: 'stack' },
      header('Настройки',
        h('button', { textContent: '← К списку', on: { click: () => showPeople(backTab) } })),
      h('h2', { class: 'group-title', textContent: 'Синхронизация' }),
      syncLine,
      syncBox,
      h('h2', { class: 'group-title', textContent: 'Данные' }),
      h('div', { class: 'row' },
        h('button', { textContent: 'Скачать копию', on: { click: downloadBackup } }),
        h('button', { textContent: 'Загрузить копию', on: { click: () => fileInput.click() } }),
        h('button', { textContent: 'Сменить ключ TMDB', on: { click: () => showSetup() } }),
        fileInput),
      status));
    renderSync();
    onSyncStatus = renderSync;
  }

  document.addEventListener('keydown', (event) => {
    // Arrow keys on a focused bucket list must change the list, not answer the card.
    if (event.target.matches('select, input')) return;
    if (keyHandler) keyHandler(event);
  });

  // Returning to the app picks up what the other device did; leaving sends what this one did.
  document.addEventListener('visibilitychange', () => {
    runSync();
  });
  window.addEventListener('online', () => {
    runSync();
  });

  async function start() {
    if (localStorage.getItem(TOKEN_STORAGE)) {
      show(h('p', { class: 'muted', textContent: 'Синхронизирую…' }));
      await Promise.race([runSync(), wait(STARTUP_SYNC_WAIT)]);
    }
    appStarted = true;
    if (localStorage.getItem(KEY_STORAGE)) showPeople();
    else showSetup();
  }

  start();
})();
