# nrk-klient

A TypeScript client for NRK TV (`psapi.nrk.no`), plus an `AiClient` that returns small, flat results
for AI agents. No dependencies at all: response validation is built in, so there is nothing else to
install or keep in sync.

> Unofficial. This package is not affiliated with NRK. It uses NRK's public API, which is not
> versioned or guaranteed to stay the same, and NRK answers `429 Too Many Requests` when it is hit
> hard, so keep your request rate low.

Requires Node.js 18 or newer (it uses the global `fetch`).

```sh
npm install nrk-klient
```

## What it exports

| Export | What it is |
| --- | --- |
| `NRK` | the client for psapi.nrk.no |
| `AiClient` | a client shaped for AI agents |
| `NrkHttpError` | what `NRK` throws when NRK answers with a non-2xx status |

Everything else is a TypeScript type (`ProgramById`, `AiResult`, ...) and does not exist at runtime.

## NRK

The methods validate NRK's responses. If the shape is not what is expected they throw an error named
`NrkValidationError` that lists the offending fields (check `error.name`).

```ts
import { NRK, NrkHttpError } from "nrk-klient";

try {
  const program = await NRK.getProgramById("MKTF73000514");
  console.log(program.title, program.durationInSeconds, program.contributors);

  const series = await NRK.getSeasons("dagsrevyen");
  const season = series.seasons[0];
  if (season) {
    const { episodes } = await NRK.getAllEpisodes("dagsrevyen", season.name);
  }
} catch (e) {
  if (e instanceof NrkHttpError) {
    console.error(e.status, e.url, e.retryAfterSeconds); // retryAfterSeconds is set on 429
  } else {
    throw e;
  }
}
```

Methods: `letter`, `getAllLetters`, `getProgramById`, `getManifest`, `getMetadata`, `prfIdGetAll`,
`getSeriesType`, `getSeasons`, `getAllEpisodes`, `getRecommendation`.

## AiClient

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
import { AiClient } from "nrk-klient";

const ai = new AiClient();

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
```

| Method | Returns |
| --- | --- |
| `listCatalog({ letters? }?)` | every program and series NRK lists, one request per letter |
| `getSeries({ seriesId })` | title, type, category, seasons |
| `getEpisodes({ seriesId, seasonName, availableOn? })` | all episodes of the season, with duration and availability |
| `getProgram(id)` / `getPrograms({ programIds })` | one or more programs with description and credited people |

Error codes: `not_found`, `forbidden`, `rate_limited` (with `retryAfterSeconds`), `upstream_error`,
`invalid_response`, `invalid_input`, `network`, `unknown`.

The client takes no options: `new AiClient()`.

### Results are checked

Both clients check what they return against the declared TypeScript type before handing it over, so
a value that contradicts a signature never reaches you. `NRK` throws a `NrkValidationError` whose
message starts with `Invalid result from NRK.<method>`; `AiClient` returns an `invalid_response`
error instead of throwing. Arguments to `AiClient` are validated the same way (`invalid_input`).

### Good to know

- About 1 in 10 items has no description at NRK; `description` is then an empty string.
- `getPrograms` costs two requests per program (the page and the playback metadata, which carries the
  description). `getEpisodes` costs one request per season and returns the whole season, which for a
  long-running news series can be a few hundred episodes.
- NRK's Google Analytics fields are filled with placeholders, so production year, category and
  episode number are read from other fields. `productionMonth` / `productionDay` are not available.

## License

ISC.
