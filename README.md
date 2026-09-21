# narko-klient

A TypeScript client for NRK TV (`psapi.nrk.no`) that returns small, flat results for AI agents. No dependencies at all: response
validation is built in, so there is nothing else to install or keep in sync.

> Unofficial. This package is not affiliated with NRK. It uses NRK's public API, which is not
> versioned or guaranteed to stay the same, and NRK answers `429 Too Many Requests` when it is hit
> hard, so keep your request rate low.

Requires Node.js 20 or newer (it uses the global `fetch`). Published as CommonJS; ESM and TypeScript
consumers import the named export as shown below.

```sh
npm install narko-klient
```

## What it exports

One class, `NrkClient`. Everything else is a TypeScript type (`AiResult`, `AiProgram`, ...) that
describes what it accepts and returns, and does not exist at runtime. The rest is internal.

## NrkClient

An API against NRK, made for agents that pick content and build schedules.

- **Small results**: ids, titles, descriptions, duration, availability window, category, production
  year, first broadcast date and credited people. No images or links.
- **Never throws**: every method returns `{ ok: true, data }` or `{ ok: false, error }`.
- **Partial results**: where one call needs several requests (`listCatalog`, `getPrograms`) you get what
  could be fetched, plus a `failed` list.
- **Gentle**: requests are spaced 250 ms apart, and it stops asking when NRK answers 429.
- **Stores nothing.** Every call goes to NRK. NRK has no search endpoint, so `listCatalog` gives you the
  archive to build your own index from, and keeping a copy of it or caching what you fetch is up to you.

```ts
import { NrkClient } from "narko-klient";

const ai = new NrkClient();

// The whole archive: about 30 requests and roughly 12,000 items. Store it and search it yourself.
const catalog = await ai.listCatalog();
if (!catalog.ok) throw new Error(catalog.error.message);
for (const item of catalog.data.items) {
  console.log(item.id, item.type, item.title, item.description);
}
console.log(catalog.data.failed); // letters that could not be fetched, if any

const series = await ai.getSeries({ seriesId: "dagsrevyen" });
const episodes = await ai.getEpisodes({
  seriesId: "dagsrevyen",
  seasonName: "2024",
  availableOn: "2026-10-03", // only episodes that can be streamed that day
});

// Full details, including NRK's description and credited people (max 20 ids per call)
const programs = await ai.getPrograms({ programIds: ["MKTF73000514"] });

// Everything a player needs to play a program or an episode (pass the episode's `id`)
const playback = await ai.getPlayback("MKTF73000514");
if (playback.ok) {
  const { streamUrl, subtitles, posterUrl, title, durationSeconds } = playback.data;
  // give streamUrl to an HLS player, subtitles[].url are WebVTT files
} else if (playback.error.code === "not_playable") {
  console.log(playback.error.message); // NRK's text for the viewer, e.g. "Ikke tilgjengelig lenger"
}
```

| Method | Returns |
| --- | --- |
| `listCatalog({ letters? }?)` | every program and series NRK lists, one request per letter |
| `getSeries({ seriesId })` | title, type, category, seasons |
| `getEpisodes({ seriesId, seasonName, availableOn? })` | all episodes of the season, with duration and availability |
| `getProgram(id)` / `getPrograms({ programIds })` | one or more programs with description and credited people |
| `getPlayback(id)` | what a player needs: HLS `streamUrl`, `mimeType`, subtitle tracks (WebVTT), poster, duration, aspect ratio, title and end of the streaming window |

Error codes: `not_found`, `forbidden`, `rate_limited` (with `retryAfterSeconds`), `upstream_error`,
`invalid_response`, `invalid_input`, `not_playable` (`getPlayback` only), `network`, `unknown`.

The client takes no options: `new NrkClient()`.

### Results are checked

`NrkClient` checks what it returns against the declared TypeScript type before handing it over, so
a value that contradicts a signature never reaches you. It returns an `invalid_response` error
instead of throwing. Arguments are validated the same way (`invalid_input`).

### Good to know

- About 1 in 10 items has no description at NRK; `description` is then an empty string.
- `getPlayback` costs two requests (the manifest and the playback metadata). The stream address NRK
  gives is not permanent, so ask for it when the viewer presses play instead of storing it. A program
  that NRK will not stream now (expired, not published yet) is a `not_playable` error whose message is
  NRK's own text for the viewer, in Norwegian. Live channels are not supported.
- `getPrograms` costs two requests per program (the page and the playback metadata, which carries the
  description). `getEpisodes` costs one request per season and returns the whole season, which for a
  long-running news series can be a few hundred episodes.
- NRK's Google Analytics fields are filled with placeholders, so production year, category and
  episode number are read from other fields. `productionMonth` / `productionDay` are not available.

## Errors, timeouts and rate limits

- Every request times out after 30 s (`TimeoutError`), sends `Accept: application/json` and a
  `User-Agent` of `narko-klient/<version>`.
- A non-2xx answer becomes an error result: `rate_limited` on 429 (with `retryAfterSeconds`,
  NRK typically asks for 600, and the current call stops early), `not_found`, `forbidden` or
  `upstream_error` otherwise. Timeouts and connection failures are `network`.
- The client does not retry. Retrying is a policy decision for the application (and retrying a 429
  early extends the block).

## Stability

- The exported API follows semantic versioning: a breaking change to what the package exports bumps
  the major version. See `CHANGELOG.md`.
- NRK's API is undocumented for some endpoints (`letter`, `getRecommendation`) and unversioned for
  all of them. Every result is validated, so a change on NRK's side shows up as a
  `invalid_response` error rather than as wrong data. The offline test suite runs
  against recorded NRK responses; `npm run test:live` runs against the real API.
- Internal helpers (the validators, test seams) are not exported and may change at any time.

## License

ISC.
