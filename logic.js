// Чистая логика без DOM и сети: её покрывает logic.test.js.
(function (root) {
  const TOP_BILLED = 5;
  const MIN_VOTES = 5;
  const PEOPLE_LIMIT = 300;
  const DOCUMENTARY_GENRE = 99;
  const SELF_ROLE = /\b(self|himself|herself|themselves|archive footage)\b/i;
  const TOP_BUCKET = 'top';
  const BUCKETS = [
    { id: TOP_BUCKET, label: 'Советую всем' },
    { id: 'good', label: 'Хорошо' },
    { id: 'ok', label: 'Нормально' },
    { id: 'bad', label: 'Плохо' },
  ];

  function addPerson(people, person, seenInFilm) {
    if (seenInFilm.has(person.id)) return;
    seenInFilm.add(person.id);
    const existing = people.get(person.id);
    if (existing) {
      existing.count += 1;
    } else {
      people.set(person.id, {
        id: person.id,
        name: person.name,
        photo: person.profile_path || null,
        count: 1,
      });
    }
  }

  function rankPeople(people) {
    return [...people.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, PEOPLE_LIMIT);
  }

  // Режиссёры и актёры первого плана, отсортированные по числу известных фильмов.
  function aggregatePeople(creditsList) {
    const directors = new Map();
    const actors = new Map();
    for (const credits of creditsList) {
      const filmDirectors = new Set();
      for (const person of credits.crew || []) {
        if (person.job === 'Director') addPerson(directors, person, filmDirectors);
      }
      const filmActors = new Set();
      for (const person of credits.cast || []) {
        if (person.order < TOP_BILLED) addPerson(actors, person, filmActors);
      }
    }
    return { directors: rankPeople(directors), actors: rankPeople(actors) };
  }

  function isActingRole(film) {
    if (SELF_ROLE.test(film.character || '')) return false;
    return !(film.genre_ids || []).includes(DOCUMENTARY_GENRE);
  }

  function sourceFilms(credits, role) {
    return role === 'director'
      ? (credits.crew || []).filter((film) => film.job === 'Director')
      : (credits.cast || []).filter(isActingRole);
  }

  // Колода человека: ещё не отмеченные вышедшие фильмы, самые известные сверху.
  function buildDeck(credits, role, answers, today) {
    const deck = new Map();
    for (const film of sourceFilms(credits, role)) {
      if (film.adult || answers[film.id] || deck.has(film.id)) continue;
      if (!film.release_date || film.release_date > today) continue;
      if ((film.vote_count || 0) < MIN_VOTES) continue;
      deck.set(film.id, {
        id: film.id,
        title: film.title,
        originalTitle: film.original_title,
        year: film.release_date.slice(0, 4),
        poster: film.poster_path || null,
        votes: film.vote_count,
      });
    }
    return [...deck.values()].sort((a, b) => b.votes - a.votes);
  }

  function seenFilms(answers) {
    return Object.entries(answers)
      .filter(([, answer]) => answer.status === 'seen')
      .map(([id, answer]) => ({ ...answer, id: Number(id) }))
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  // Seen films the user has not put in a bucket yet, oldest first.
  function unsortedFilms(answers) {
    return seenFilms(answers).filter((film) => !film.bucket).reverse();
  }

  // Top-bucket films that still need comparisons to get their place, oldest first.
  function pendingFilms(answers, ranking) {
    return seenFilms(answers)
      .filter((film) => film.bucket === TOP_BUCKET && !ranking.includes(film.id))
      .reverse();
  }

  // Drops whatever edits to the answers made stale: only top-bucket films stay ranked,
  // and an unfinished insertion survives only if the ranking it was started on is unchanged.
  function normalizeData(raw) {
    const answers = raw.answers || {};
    const isTop = (id) => Number.isInteger(id)
      && Boolean(answers[id])
      && answers[id].status === 'seen'
      && answers[id].bucket === TOP_BUCKET;
    const ranking = [...new Set(Array.isArray(raw.ranking) ? raw.ranking : [])].filter(isTop);
    const insertion = raw.insertion;
    const insertionIsValid = Boolean(insertion)
      && isTop(insertion.filmId)
      && !ranking.includes(insertion.filmId)
      && insertion.size === ranking.length
      && Number.isInteger(insertion.low)
      && Number.isInteger(insertion.high)
      && insertion.low >= 0
      && insertion.low <= insertion.high
      && insertion.high <= ranking.length;
    return {
      answers,
      done: raw.done || {},
      ranking,
      insertion: insertionIsValid ? insertion : null,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    };
  }

  // What a sync should do, given the revision each side holds and the one last agreed on.
  function decideSync({ localAt, remoteAt, syncedAt }) {
    if (remoteAt === null) return 'push';
    if (localAt === remoteAt) return 'none';
    const localChanged = localAt !== syncedAt;
    const remoteChanged = remoteAt !== syncedAt;
    if (localChanged && remoteChanged) return 'merge';
    if (remoteChanged) return 'pull';
    return localChanged ? 'push' : 'none';
  }

  function changedAt(answer) {
    return answer.changedAt || answer.at || 0;
  }

  // Both devices changed since the last sync: keep each film's latest answer and the newer
  // side's ranking. A top film only the other side had ranked goes back to waiting for
  // comparisons, and a film removed on one side comes back: neither loses a user's marks.
  function mergeData(local, remote) {
    const answers = { ...remote.answers };
    for (const [id, answer] of Object.entries(local.answers)) {
      if (!answers[id] || changedAt(answer) >= changedAt(answers[id])) answers[id] = answer;
    }
    const newer = local.updatedAt >= remote.updatedAt ? local : remote;
    return normalizeData({
      answers,
      done: { ...remote.done, ...local.done },
      ranking: newer.ranking,
      insertion: null,
      updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    });
  }

  // Binary insertion: each answer halves the range of places the new film can take.
  function startInsertion(filmId, size) {
    return { filmId, low: 0, high: size, size };
  }

  // The ranking index to compare against, or null once the place is known.
  function comparisonIndex(insertion) {
    if (insertion.low >= insertion.high) return null;
    return Math.floor((insertion.low + insertion.high) / 2);
  }

  function chooseInsertion(insertion, preferNewFilm) {
    const index = comparisonIndex(insertion);
    return preferNewFilm ? { ...insertion, high: index } : { ...insertion, low: index + 1 };
  }

  function finishInsertion(ranking, insertion) {
    const next = [...ranking];
    next.splice(insertion.low, 0, insertion.filmId);
    return next;
  }

  // The most comparisons this film can still need.
  function comparisonsLeft(insertion) {
    return Math.ceil(Math.log2(insertion.high - insertion.low + 1));
  }

  // The rating screen's sections: ranked films first, then the other buckets by title.
  function ratingGroups(answers, ranking) {
    const seen = seenFilms(answers);
    const byId = new Map(seen.map((film) => [film.id, film]));
    const byTitle = (a, b) => String(a.title).localeCompare(String(b.title));
    const groups = BUCKETS.map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      films: bucket.id === TOP_BUCKET
        ? [
          ...ranking.map((id, index) => ({ ...byId.get(id), rank: index + 1 })),
          ...pendingFilms(answers, ranking),
        ]
        : seen.filter((film) => film.bucket === bucket.id).sort(byTitle),
    }));
    groups.push({ id: null, label: 'Без корзины', films: unsortedFilms(answers) });
    return groups.filter((group) => group.films.length);
  }

  // A person's watched films by bucket. Places stay those of the overall ranking.
  function personGroups(credits, role, answers, ranking) {
    const ids = new Set(sourceFilms(credits, role).map((film) => film.id));
    return ratingGroups(answers, ranking)
      .map((group) => ({ ...group, films: group.films.filter((film) => ids.has(film.id)) }))
      .filter((group) => group.films.length);
  }

  // Проверяет файл резервной копии перед тем, как заменить им сохранённые данные.
  function parseBackup(text) {
    const data = JSON.parse(text);
    const bucketIds = BUCKETS.map((bucket) => bucket.id);
    const valid = data && typeof data === 'object'
      && data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers)
      && Object.values(data.answers).every(
        (answer) => answer
          && (answer.status === 'seen' || answer.status === 'unseen')
          && (answer.bucket === undefined || bucketIds.includes(answer.bucket)),
      )
      && (data.ranking === undefined || Array.isArray(data.ranking));
    if (!valid) throw new Error('Это не резервная копия приложения');
    return normalizeData(data);
  }

  const api = {
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
  };
  root.MovieLogic = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
