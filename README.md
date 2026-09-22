# narko-klient

A TypeScript client for NRK TV (`psapi.nrk.no`) that returns small, flat results for AI agents. No dependencies at all: response
validation is built in, so there is nothing else to install or keep in sync.

> Unofficial. This package is not affiliated with NRK. It uses NRK's public API, which is not
> versioned or guaranteed to stay the same, and NRK answers `429 Too Many Requests` when it is hit
> hard, so keep your request rate low. NRK's terms restrict live channels and streams to private
> use; building a public service around `getChannels` / `getSchedule` / `getLivePlayback` needs
> NRK's approval.

Requires Node.js 20 or newer (it uses the global `fetch`). Published as CommonJS; ESM and TypeScript
consumers import the named export as shown below. The code itself uses only standard web APIs
(`fetch`, `URL`, `AbortSignal`, ...), nothing Node-specific, so it also runs in a browser once a
bundler resolves the CommonJS module.

```sh
npm install narko-klient
```

## What it exports

One class, `NrkClient`. Everything else is a TypeScript type (`Result`, `Program`, ...) that
describes what its methods return, and does not exist at runtime. What the methods accept and
return is documented on the methods and the types themselves (hover in your editor, or see
`dist/nrk-client.d.ts` and `dist/types.d.ts`). The rest is internal.

## NrkClient

An API against NRK, made for agents that pick content and build schedules.

- **Small results**: ids, titles, descriptions, duration, availability window, category, production
  year, first broadcast date and credited people, and one small picture (`imageUrl`, about 300 px wide) for lists and cards. No
  links or display strings. `getPlayback` has a larger poster for the player.
- **Never throws**: every method returns `{ ok: true, data }` or `{ ok: false, error }`.
- **Partial results**: where one call needs several requests (`listCatalog`, `getPrograms`,
  `getRecommendations`) you get what could be fetched, plus a `failed` list.
- **Gentle**: requests are spaced 250 ms apart, and it stops asking when NRK answers 429.
- **Stores nothing.** Every call goes to NRK. `listCatalog` gives you the whole
  archive to build your own index from, `search` looks up one theme; keeping a copy or caching what you fetch is up to you.
- **Live TV**: `getChannels` and `getSchedule` cover NRK's programme guide; `getLivePlayback` plays a
  channel when NRK's stream allows it (most live TV is DRM-protected, see "Good to know").

```ts
import { NrkClient } from "narko-klient";

const client = new NrkClient();

// The whole archive: about 30 requests and roughly 12,000 items. Store it and search it yourself.
const catalog = await client.listCatalog();
if (!catalog.ok) throw new Error(catalog.error.message);
for (const item of catalog.data.items) {
  console.log(item.id, item.type, item.title, item.description);
}
console.log(catalog.data.failed); // letters that could not be fetched, if any

const series = await client.getSeries({ id: "dagsrevyen" });
const episodes = await client.getEpisodes({
  seriesId: "dagsrevyen",
  seasonName: "2024",
  availableOn: "2026-10-03", // only episodes that can be streamed that day
});

// Full details, including NRK's description and credited people (max 20 ids per call)
const programs = await client.getPrograms({ ids: ["MKTF73000514"] });

// Free-text search: a theme, a title or a person. Series, programs and single episodes.
const found = await client.search({ query: "norsk historie" });
if (found.ok) {
  for (const item of found.data.items) console.log(item.type, item.id, item.title, item.availableNow);
}

// More of what the viewer likes, from ids they liked or watched (1-5 program, episode or series ids)
const recs = await client.getRecommendations({ basedOn: ["MKTF73000514", "dagsrevyen"] });
if (recs.ok) {
  for (const item of recs.data.items) console.log(item.type, item.id, item.title, item.basedOn);
}

// Everything a player needs to play a program or an episode (pass the episode's `id`)
const playback = await client.getPlayback({ id: "MKTF73000514" });
if (playback.ok) {
  const { streamUrl, subtitles, posterUrl, title, durationSeconds } = playback.data;
  // give streamUrl to an HLS player, subtitles[].url are WebVTT files
} else if (playback.error.code === "not_playable") {
  console.log(playback.error.message); // NRK's text for the viewer, e.g. "Ikke tilgjengelig lenger"
}

// Live TV: the channels, today's guide for one of them, and (rarely) its stream
const channels = await client.getChannels();
const guide = await client.getSchedule({ channelIds: ["nrk1"] });
if (guide.ok) {
  for (const item of guide.data) console.log(item.start, item.title, item.availableNow);
}
const live = await client.getLivePlayback({ id: "nrk1" });
```

| Method | Returns |
| --- | --- |
| `listCatalog({ letters? }?)` | every program and series NRK lists, one request per letter |
| `getSeries({ id })` | title, type, category, seasons |
| `getEpisodes({ seriesId, seasonName, availableOn? })` | all episodes of the season, with duration and availability |
| `getProgram({ id })` / `getPrograms({ ids })` | one or more programs with description and credited people |
| `search({ query, limit? })` | free-text search in NRK TV (title and description words, small typos forgiven): series, programs and single episodes with their ids, best match first |
| `getRecommendations({ basedOn, count? })` | what NRK recommends for 1-5 ids the viewer likes: merged, without the ids you gave, strongest matches first, each with the ids that led to it (no descriptions: follow up with `getProgram`) |
| `getPlayback({ id })` | what a player needs: HLS `streamUrl`, `mimeType`, subtitle tracks (WebVTT), poster, duration, aspect ratio, title and end of the streaming window |
| `getChannels()` | NRK's live TV channels: id, title, description and picture |
| `getSchedule({ channelIds, date? })` | the programme guide for one or more channels: what aired, is airing and is coming up, with `availableNow` for what can already be played |
| `getLivePlayback({ id })` | what a player needs to play a live channel, in the shape as `getPlayback` - usually `not_playable`, since NRK's live streams are DRM-protected |

Error codes: `not_found`, `forbidden`, `rate_limited` (with `retryAfterSeconds`), `upstream_error`,
`invalid_response`, `invalid_input`, `not_playable` (`getPlayback` / `getLivePlayback` only),
`network`, `unknown`.

The client takes no options: `new NrkClient()`.

### Results are checked

`NrkClient` checks what it returns against the declared TypeScript type before handing it over, so
a value that contradicts a signature never reaches you. It returns an `invalid_response` error
instead of throwing. Arguments are validated the same way (`invalid_input`).

### Good to know

- About 1 in 10 items has no description at NRK; `description` is then an empty string.
- `imageUrl` is `null` when NRK lists no picture. If you pass results on to a language model, leave the
  field out: the address only costs tokens, and it is meant for your user interface.
- `search` is one request. NRK's search is by words, not meaning: "norsk historie" finds titles and
  descriptions with those words, not everything about the subject, so try several phrasings.
  It uses an endpoint that is not in NRK's swagger files, so it is the most likely to change.
  There is no paging; ask for up to 100 hits with `limit`.
- `getRecommendations` costs one request per id in `basedOn`. NRK does not say whether a recommended item
  can be streamed now, so check with `getProgram` (`status`) or `getPlayback` before scheduling it.
- `getPlayback` costs two requests (the manifest and the playback metadata). The stream address NRK
  gives is not permanent, so ask for it when the viewer presses play instead of storing it. A program
  that NRK will not stream now (expired, not published yet) is a `not_playable` error whose message is
  NRK's own text for the viewer, in Norwegian.
- `getPrograms` costs two requests per program (the page and the playback metadata, which carries the
  description). `getEpisodes` costs one request per season and returns the whole season, which for a
  long-running news series can be a few hundred episodes.
- NRK's Google Analytics fields are filled with placeholders, so production year, category and
  episode number are read from other fields. `productionMonth` / `productionDay` are not available.
- `getLivePlayback` almost always returns `not_playable`: NRK's live TV streams are encrypted
  (DRM, a static key this library does not have), so a plain HLS player cannot use them. Use
  `getChannels` / `getSchedule` for the guide, and follow up on-demand items (`availableNow`) with
  `getProgram` / `getPlayback`. Radio is not covered.

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
- NRK's API is undocumented for some endpoints (the letter list behind `listCatalog`,
  `getRecommendations` and `search`) and unversioned for all of them. Every result is validated, so a change on NRK's side shows up as an
  `invalid_response` error rather than as wrong data. The offline test suite runs
  against recorded NRK responses; `npm run test:live` runs against the real API.
- Internal helpers (the validators, test seams) are not exported and may change at any time.

## License

ISC.
