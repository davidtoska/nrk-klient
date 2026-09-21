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

Made for agents that pick content and build schedules.

- **Small results**: ids, titles, descriptions, duration, availability window, category, production
  year, first broadcast date and credited people. No images or links.
- **Keyword search**: NRK has no search endpoint, so the client loads the letter index once (about
  30 requests, roughly 12,000 programs and series) and searches it in memory.
- **Never throws**: every method returns `{ ok: true, data }` or `{ ok: false, error }`.
- **Paged**: `total`, `offset` and `hasMore` tell the agent what it did not see.
- **Gentle**: requests are spaced out (250 ms) and lookups are cached.

```ts
import { AiClient } from "nrk-klient";

const ai = new AiClient();

const found = await ai.searchCatalog({ query: "natur, dyr", type: "series", limit: 10 });
if (!found.ok) throw new Error(found.error.message);

for (const item of found.data.items) {
  console.log(item.id, item.title, item.description);
}

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
| `searchCatalog(input?)` | ranked items with `total` / `hasMore` |
| `getSeries({ seriesId })` | title, type, category, seasons |
| `getEpisodes({ seriesId, seasonName, availableOn?, limit?, offset? })` | episodes with duration and availability |
| `getProgram(id)` / `getPrograms({ programIds })` | one or more programs with description and credited people |
| `refreshCatalog()` | drops the cached index |

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
  description). Episode lists cost one request per season.
- NRK's Google Analytics fields are filled with placeholders, so production year, category and
  episode number are read from other fields. `productionMonth` / `productionDay` are not available.

## License

ISC.
