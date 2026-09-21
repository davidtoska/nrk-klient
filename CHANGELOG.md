# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
[Semantic Versioning](https://semver.org/): breaking changes to the exported API bump the
major version. NRK's own API is not versioned; changes there that the client absorbs are
listed as fixes.

## [Unreleased]

### Added
- `NrkClient`, the only export: an API against NRK for AI agents, with compact results, that
  never throws (`listCatalog`, `getSeries`, `getEpisodes`, `getProgram`, `getPrograms`).
- `NrkClient.getPlayback(id)`: the stream (HLS), subtitles, poster, duration and title a player
  needs, or a `not_playable` error with NRK's text for the viewer.
- `NrkClient.search({ query })`: free-text search in NRK TV (series, programs and episodes).
- `NrkClient.getRecommendation({ basedOn })`: recommendations from NRK for what the viewer likes,
  merged over 1-5 ids.
- The types its methods return (`Result`, `Program`, `Catalog`, ...).
- Results and arguments are validated against their declared types.
- Requests time out after 30 s and identify themselves with a `User-Agent`.
- Program and episode results carry production year, first broadcast date and credited
  people, for personalisation.

### Notes
- No runtime dependencies; response validation is built in.
- Node.js 20 or newer (uses the global `fetch`).
- CommonJS build; ESM consumers import the named export.
