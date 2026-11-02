const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./logic.js');

const TODAY = '2026-11-01';

function film(id, extra = {}) {
  return {
    id,
    title: `Фильм ${id}`,
    original_title: `Film ${id}`,
    release_date: '2000-01-01',
    poster_path: `/${id}.jpg`,
    vote_count: 100,
    ...extra,
  };
}

test('aggregatePeople считает режиссёров и актёров первого плана по фильмам', () => {
  const nolan = { id: 1, name: 'Нолан', job: 'Director', profile_path: '/n.jpg' };
  const { directors, actors } = aggregatePeople([
    {
      crew: [nolan, { id: 2, name: 'Оператор', job: 'Director of Photography' }],
      cast: [{ id: 10, name: 'Бейл', order: 0 }, { id: 11, name: 'Массовка', order: 5 }],
    },
    { crew: [nolan], cast: [{ id: 10, name: 'Бейл', order: 1 }] },
    { crew: [{ id: 3, name: 'Финчер', job: 'Director' }], cast: [] },
  ]);

  assert.deepEqual(directors.map((p) => [p.name, p.count]), [['Нолан', 2], ['Финчер', 1]]);
  assert.deepEqual(actors.map((p) => [p.name, p.count]), [['Бейл', 2]]);
});

test('aggregatePeople не считает человека дважды за один фильм', () => {
  const twice = { id: 1, name: 'Сорежиссёр', job: 'Director' };
  const { directors } = aggregatePeople([{ crew: [twice, twice], cast: [] }]);
  assert.equal(directors[0].count, 1);
});

test('buildDeck берёт для режиссёра только режиссуру', () => {
  const deck = buildDeck(
    { crew: [film(1, { job: 'Director' }), film(2, { job: 'Producer' })], cast: [film(3)] },
    'director',
    {},
    TODAY,
  );
  assert.deepEqual(deck.map((f) => f.id), [1]);
});

test('buildDeck убирает документальное кино и камео актёра в роли себя', () => {
  const deck = buildDeck(
    {
      cast: [
        film(1, { character: 'Бэтмен' }),
        film(2, { character: 'Self' }),
        film(3, { character: 'Himself (archive footage)' }),
        film(4, { character: 'Голос', genre_ids: [99] }),
      ],
    },
    'actor',
    {},
    TODAY,
  );
  assert.deepEqual(deck.map((f) => f.id), [1]);
});

test('buildDeck убирает отмеченные, невышедшие, без даты, для взрослых и с малым числом голосов', () => {
  const deck = buildDeck(
    {
      cast: [
        film(1),
        film(2),
        film(3, { release_date: '2030-01-01' }),
        film(4, { release_date: '' }),
        film(5, { adult: true }),
        film(6, { vote_count: 4 }),
      ],
    },
    'actor',
    { 2: { status: 'unseen' } },
    TODAY,
  );
  assert.deepEqual(deck.map((f) => f.id), [1]);
});

test('buildDeck убирает дубли и ставит самые известные фильмы первыми', () => {
  const deck = buildDeck(
    { cast: [film(1, { vote_count: 10 }), film(2, { vote_count: 900 }), film(1, { vote_count: 10 })] },
    'actor',
    {},
    TODAY,
  );
  assert.deepEqual(deck.map((f) => f.id), [2, 1]);
  assert.equal(deck[0].year, '2000');
});

test('seenFilms возвращает только просмотренные, новые первыми', () => {
  const films = seenFilms({
    1: { status: 'seen', title: 'Старый', at: 1 },
    2: { status: 'unseen', title: 'Не видел', at: 2 },
    3: { status: 'seen', title: 'Новый', at: 3 },
  });
  assert.deepEqual(films.map((f) => [f.id, f.title]), [[3, 'Новый'], [1, 'Старый']]);
});

test('parseBackup принимает свой формат и отвергает чужой файл', () => {
  const backup = parseBackup(JSON.stringify({ answers: { 1: { status: 'seen' } } }));
  assert.deepEqual(backup, { answers: { 1: { status: 'seen' } }, done: {}, ranking: [], insertion: null, updatedAt: 0 });

  assert.throws(() => parseBackup('не json'));
  assert.throws(() => parseBackup('{"answers":[]}'));
  assert.throws(() => parseBackup('{"answers":{"1":{"status":"maybe"}}}'));
  assert.throws(() => parseBackup('{"answers":{"1":{"status":"seen","bucket":"best"}}}'));
  assert.throws(() => parseBackup('{"answers":{},"ranking":"1,2"}'));
  assert.throws(() => parseBackup('null'));
});

test('parseBackup сохраняет корзины и рейтинг', () => {
  const answers = {
    1: { status: 'seen', bucket: 'top' },
    2: { status: 'seen', bucket: 'top' },
    3: { status: 'seen', bucket: 'good' },
  };
  const backup = parseBackup(JSON.stringify({ answers, ranking: [2, 1] }));
  assert.deepEqual(backup.ranking, [2, 1]);
  assert.equal(backup.answers[3].bucket, 'good');
});

// Runs one film through binary insertion, answering from a hidden "true" order.
function insert(ranking, filmId, isBetter) {
  let insertion = startInsertion(filmId, ranking.length);
  let comparisons = 0;
  while (comparisonIndex(insertion) !== null) {
    const opponent = ranking[comparisonIndex(insertion)];
    insertion = chooseInsertion(insertion, isBetter(filmId, opponent));
    comparisons += 1;
  }
  return { ranking: finishInsertion(ranking, insertion), comparisons };
}

test('вставка: пример с «Интерстелларом» — 7 фильмов, 3 вопроса, 3-е место', () => {
  const asked = [];
  let insertion = startInsertion(99, 7);
  for (const preferNew of [true, false, true]) {
    asked.push(comparisonIndex(insertion));
    assert.equal(comparisonsLeft(insertion), 3 - asked.length + 1);
    insertion = chooseInsertion(insertion, preferNew);
  }
  assert.deepEqual(asked, [3, 1, 2], 'сравнения с 4-м, 2-м и 3-м местом');
  assert.equal(comparisonIndex(insertion), null);
  assert.equal(comparisonsLeft(insertion), 0);
  assert.deepEqual(finishInsertion([1, 2, 3, 4, 5, 6, 7], insertion), [1, 2, 99, 3, 4, 5, 6, 7]);
});

test('вставка: первый фильм встаёт без сравнений', () => {
  const insertion = startInsertion(5, 0);
  assert.equal(comparisonIndex(insertion), null);
  assert.deepEqual(finishInsertion([], insertion), [5]);
});

test('вставка: любой порядок собирается точно и укладывается в log2 сравнений', () => {
  for (let size = 1; size <= 40; size += 1) {
    const truth = Array.from({ length: size }, (_, index) => index + 1);
    // Seeded Fisher-Yates, so a failure reproduces.
    const arrival = [...truth];
    let seed = size;
    for (let index = arrival.length - 1; index > 0; index -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const other = seed % (index + 1);
      [arrival[index], arrival[other]] = [arrival[other], arrival[index]];
    }
    let ranking = [];
    for (const film of arrival) {
      const result = insert(ranking, film, (a, b) => a < b);
      assert.ok(
        result.comparisons <= Math.ceil(Math.log2(ranking.length + 1)),
        `${result.comparisons} сравнений при ${ranking.length} фильмах`,
      );
      ranking = result.ranking;
    }
    assert.deepEqual(ranking, truth);
  }
});

test('топ-100 с нуля укладывается примерно в 500 сравнений, как обещано', () => {
  let ranking = [];
  let total = 0;
  for (let film = 100; film >= 1; film -= 1) {
    const result = insert(ranking, film, (a, b) => a < b);
    ranking = result.ranking;
    total += result.comparisons;
  }
  assert.ok(total <= 580, `вышло ${total}`);
});

test('unsortedFilms и pendingFilms идут от старых к новым и не пересекаются', () => {
  const answers = {
    1: { status: 'seen', at: 3 },
    2: { status: 'seen', at: 1 },
    3: { status: 'unseen', at: 2 },
    4: { status: 'seen', at: 4, bucket: 'top' },
    5: { status: 'seen', at: 5, bucket: 'top' },
    6: { status: 'seen', at: 6, bucket: 'top' },
    7: { status: 'seen', at: 7, bucket: 'good' },
  };
  assert.deepEqual(unsortedFilms(answers).map((f) => f.id), [2, 1]);
  assert.deepEqual(pendingFilms(answers, [5]).map((f) => f.id), [4, 6]);
});

test('normalizeData не теряет старые данные без корзин и рейтинга', () => {
  const answers = { 1: { status: 'seen', title: 'Начало', at: 1 }, 2: { status: 'unseen' } };
  assert.deepEqual(normalizeData({ answers, done: { 'director:1': true } }), {
    answers,
    done: { 'director:1': true },
    ranking: [],
    insertion: null,
    updatedAt: 0,
  });
});

test('decideSync: кто менялся, тот и определяет действие', () => {
  const decide = (localAt, remoteAt, syncedAt) => decideSync({ localAt, remoteAt, syncedAt });
  assert.equal(decide(5, null, 0), 'push', 'в gist ещё ничего нет');
  assert.equal(decide(5, 5, 5), 'none', 'никто не менялся');
  assert.equal(decide(6, 5, 5), 'push', 'изменился только этот');
  assert.equal(decide(5, 6, 5), 'pull', 'изменился только другой');
  assert.equal(decide(6, 7, 5), 'merge', 'изменились оба');
  assert.equal(decide(0, 7, 0), 'pull', 'новое устройство с пустыми данными');
  assert.equal(decide(4, 7, 0), 'merge', 'первое подключение устройства со своими отметками');
  assert.equal(decide(7, 7, 0), 'none', 'уже одинаковые');
});

test('mergeData берёт по каждому фильму более свежий ответ, ничего не теряя', () => {
  const local = {
    answers: {
      1: { status: 'seen', title: 'Только тут', at: 1 },
      2: { status: 'seen', bucket: 'good', at: 1, changedAt: 50 },
      3: { status: 'seen', bucket: 'bad', at: 1, changedAt: 10 },
    },
    done: { 'director:1': true },
    ranking: [],
    updatedAt: 100,
  };
  const remote = {
    answers: {
      4: { status: 'unseen', title: 'Только там', at: 2 },
      2: { status: 'seen', bucket: 'ok', at: 1, changedAt: 40 },
      3: { status: 'seen', bucket: 'good', at: 1, changedAt: 20 },
    },
    done: { 'actor:2': true },
    ranking: [],
    updatedAt: 90,
  };
  const merged = mergeData(local, remote);
  assert.deepEqual(Object.keys(merged.answers).sort(), ['1', '2', '3', '4']);
  assert.equal(merged.answers[2].bucket, 'good', 'новее здесь');
  assert.equal(merged.answers[3].bucket, 'good', 'новее там');
  assert.deepEqual(merged.done, { 'director:1': true, 'actor:2': true });
  assert.equal(merged.updatedAt, 100);
});

test('mergeData оставляет рейтинг более новой стороны, остальной топ ждёт сравнения', () => {
  const top = (at) => ({ status: 'seen', bucket: 'top', at });
  const local = { answers: { 1: top(1), 2: top(2) }, done: {}, ranking: [2, 1], insertion: { filmId: 9 }, updatedAt: 200 };
  const remote = { answers: { 1: top(1), 3: top(3) }, done: {}, ranking: [3, 1], updatedAt: 100 };
  const merged = mergeData(local, remote);
  assert.deepEqual(merged.ranking, [2, 1]);
  assert.equal(merged.insertion, null);
  assert.deepEqual(pendingFilms(merged.answers, merged.ranking).map((f) => f.id), [3]);
  assert.deepEqual(mergeData(remote, local).ranking, [2, 1], 'порядок аргументов не важен');
});

test('mergeData выбрасывает из рейтинга фильм, ушедший из верхней корзины на другой стороне', () => {
  const local = {
    answers: { 1: { status: 'seen', bucket: 'top', at: 1 }, 2: { status: 'seen', bucket: 'top', at: 1 } },
    done: {},
    ranking: [1, 2],
    updatedAt: 200,
  };
  const remote = {
    answers: { 1: { status: 'seen', bucket: 'bad', at: 1, changedAt: 150 }, 2: { status: 'seen', bucket: 'top', at: 1 } },
    done: {},
    ranking: [2],
    updatedAt: 100,
  };
  assert.deepEqual(mergeData(local, remote).ranking, [2]);
});

test('normalizeData убирает из рейтинга всё, что больше не в верхней корзине', () => {
  const data = normalizeData({
    answers: {
      1: { status: 'seen', bucket: 'top' },
      2: { status: 'seen', bucket: 'good' },
      3: { status: 'unseen', bucket: 'top' },
      4: { status: 'seen', bucket: 'top' },
    },
    ranking: [4, 2, 3, 99, 'x', 1, 4],
  });
  assert.deepEqual(data.ranking, [4, 1]);
});

test('normalizeData сохраняет начатую вставку, только пока рейтинг не менялся', () => {
  const answers = {
    1: { status: 'seen', bucket: 'top' },
    2: { status: 'seen', bucket: 'top' },
    3: { status: 'seen', bucket: 'top' },
  };
  const insertion = { filmId: 3, low: 1, high: 2, size: 2 };
  assert.deepEqual(normalizeData({ answers, ranking: [1, 2], insertion }).insertion, insertion);
  assert.equal(normalizeData({ answers, ranking: [1], insertion }).insertion, null, 'рейтинг изменился');
  assert.equal(normalizeData({ answers, ranking: [1, 2, 3], insertion }).insertion, null, 'фильм уже в рейтинге');
  assert.equal(
    normalizeData({ answers: { ...answers, 3: { status: 'seen', bucket: 'ok' } }, ranking: [1, 2], insertion }).insertion,
    null,
    'фильм ушёл из верхней корзины',
  );
  assert.equal(
    normalizeData({ answers, ranking: [1, 2], insertion: { ...insertion, high: 9 } }).insertion,
    null,
    'границы вне рейтинга',
  );
});

test('personGroups показывает только фильмы человека и сохраняет места общего рейтинга', () => {
  const answers = {
    1: { status: 'seen', title: 'Его первый', bucket: 'top', at: 1 },
    2: { status: 'seen', title: 'Чужой', bucket: 'top', at: 2 },
    3: { status: 'seen', title: 'Его второй', bucket: 'top', at: 3 },
    4: { status: 'seen', title: 'Его хороший', bucket: 'good', at: 4 },
    5: { status: 'seen', title: 'Его без корзины', at: 5 },
    6: { status: 'unseen', title: 'Его не видел', at: 6 },
    7: { status: 'seen', title: 'Продюсировал', bucket: 'bad', at: 7 },
  };
  const credits = {
    crew: [
      film(1, { job: 'Director' }),
      film(3, { job: 'Director' }),
      film(4, { job: 'Director' }),
      film(5, { job: 'Director' }),
      film(6, { job: 'Director' }),
      film(7, { job: 'Producer' }),
    ],
    cast: [film(2)],
  };
  const groups = personGroups(credits, 'director', answers, [2, 1, 3]);

  assert.deepEqual(groups.map((g) => g.id), ['top', 'good', null]);
  assert.deepEqual(groups[0].films.map((f) => [f.id, f.rank]), [[1, 2], [3, 3]]);
  assert.deepEqual(groups[1].films.map((f) => f.id), [4]);
  assert.deepEqual(groups[2].films.map((f) => f.id), [5]);
});

test('personGroups для актёра берёт только его роли', () => {
  const answers = { 1: { status: 'seen', title: 'Роль', at: 1 }, 2: { status: 'seen', title: 'Режиссура', at: 2 } };
  const credits = { cast: [film(1, { character: 'Герой' })], crew: [film(2, { job: 'Director' })] };
  const groups = personGroups(credits, 'actor', answers, []);
  assert.deepEqual(groups.map((g) => g.films.map((f) => f.id)), [[1]]);
});

test('ratingGroups: сначала места рейтинга, остальные корзины по названию, пустых нет', () => {
  const groups = ratingGroups({
    1: { status: 'seen', title: 'Первый', bucket: 'top', at: 1 },
    2: { status: 'seen', title: 'Второй', bucket: 'top', at: 2 },
    3: { status: 'seen', title: 'Ждёт сравнения', bucket: 'top', at: 3 },
    4: { status: 'seen', title: 'Яблоко', bucket: 'ok', at: 4 },
    5: { status: 'seen', title: 'Арбуз', bucket: 'ok', at: 5 },
    6: { status: 'seen', title: 'Без корзины', at: 6 },
    7: { status: 'unseen', title: 'Не видел', at: 7 },
  }, [2, 1]);

  assert.deepEqual(groups.map((g) => g.id), ['top', 'ok', null]);
  assert.deepEqual(groups[0].films.map((f) => [f.id, f.rank]), [[2, 1], [1, 2], [3, undefined]]);
  assert.deepEqual(groups[1].films.map((f) => f.title), ['Арбуз', 'Яблоко']);
  assert.deepEqual(groups[2].films.map((f) => f.id), [6]);
});
