# Мои фильмы

A personal app for remembering and ranking the films I've seen. Pick a director or an actor, swipe their films, sort the ones you've seen into buckets, and order the top bucket with "which is better?" comparisons.

Live at <https://dzmitryshut.github.io/movie-ranking/>. It is a static page with no server and no build step.

## Data and keys

Nothing personal lives in this repository. Each device keeps its own data:

- **TMDB key:** you paste your own [free key](https://www.themoviedb.org/settings/api) on first launch. It stays in that browser's `localStorage`.
- **Marks and ranking:** kept in `localStorage`. With sync turned on in the settings, they are also stored in a private gist on your own GitHub account, using a token with only the `gist` scope. That token also stays in the browser.

If two devices change data before they can sync, each film keeps its latest answer and the newer device's ranking wins. Top-bucket films ranked only on the other device go back to waiting for comparisons.

## Tests

```sh
node --test
```

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
