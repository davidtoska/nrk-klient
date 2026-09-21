# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
[Semantic Versioning](https://semver.org/): breaking changes to the exported API bump the
major version. NRK's own API is not versioned; changes there that the client absorbs are
listed as fixes.

## [Unreleased]

### Added
- `NRK`: client for psapi.nrk.no with validated results (`letter`, `getAllLetters`,
  `getProgramById`, `getManifest`, `getMetadata`, `prfIdGetAll`, `getSeriesType`,
  `getSeasons`, `getAllEpisodes`, `getRecommendation`).
- `AiClient`: an API for AI agents with compact results that never throws
  (`listCatalog`, `getSeries`, `getEpisodes`, `getProgram`, `getPrograms`).
- `NrkHttpError` (non-2xx responses, with `retryAfterSeconds`) and `NrkValidationError`
  (a response or a result that does not match its declared type).
- Requests time out after 30 s and identify themselves with a `User-Agent`.
- Program and episode results carry production year, first broadcast date, credited
  people and series link, for personalisation.

### Notes
- No runtime dependencies; response validation is built in.
- Node.js 20 or newer (uses the global `fetch`).
- CommonJS build; ESM consumers import the named exports.
