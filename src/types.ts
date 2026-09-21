import * as v from "./validate";

// What NrkClient accepts and returns. Deliberately small: only what an agent needs to pick
// content and build a schedule. One small image per item, no display strings or HAL links.
// All dates are ISO 8601 strings exactly as NRK sends them (or null).
//
// Each type is followed by its validator, typed `Validator<TheType>` so the compiler makes
// it agree with the interface. Inputs are validated on the way in and results on the way
// out, so a caller never gets a value that contradicts the declared type. The validators
// carry the internal tag and are stripped from the published declarations.

// ── Values NRK uses ─────────────────────────────────────────────────

export type AvailabilityStatus = "coming" | "available" | "expires" | "expired" | "notAvailableOnline";
/** @internal */
export const AVAILABILITY_STATUSES = v.allOf<AvailabilityStatus>({
    coming: true,
    available: true,
    expires: true,
    expired: true,
    notAvailableOnline: true,
});

export type SeriesType = "sequential" | "news" | "standard";
/** @internal */
export const SERIES_TYPES = v.allOf<SeriesType>({ sequential: true, news: true, standard: true });

export type SeasonType = "latest" | "extramaterial" | "season";
/** @internal */
export const SEASON_TYPES = v.allOf<SeasonType>({ latest: true, extramaterial: true, season: true });

const isoDate = v.stringOf({ pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: "expected YYYY-MM-DD" });

// ── Input ───────────────────────────────────────────────────────────

/** Arguments for NrkClient.listCatalog. */
export interface ListCatalogInput {
    /**
     * Which letters to list, e.g. "abc". Default: the whole alphabet (a-z, æ, ø, å),
     * which is about 30 requests and roughly 12,000 items.
     */
    letters?: string | undefined;
}
/** @internal */
export const listCatalogInput: v.Validator<ListCatalogInput> = v.object({
    letters: v.optional(
        v.stringOf({ min: 1, max: 29, pattern: /^\p{L}+$/u, patternMessage: "letters only, e.g. \"abc\"" }),
    ),
});

export interface GetSeriesInput {
    /** Series id from listCatalog or search (`type: "series"`), for instance "dagsrevyen". */
    id: string;
}
/** @internal */
export const getSeriesInput: v.Validator<GetSeriesInput> = v.object({
    id: v.stringOf({ min: 1, max: 200 }),
});

export interface GetEpisodesInput {
    seriesId: string;
    /** A season name from getSeries. */
    seasonName: string;
    /** YYYY-MM-DD: only episodes that can be streamed on this date. */
    availableOn?: string | undefined;
}
/** @internal */
export const getEpisodesInput: v.Validator<GetEpisodesInput> = v.object({
    seriesId: v.stringOf({ min: 1, max: 200 }),
    seasonName: v.stringOf({ min: 1, max: 200 }),
    availableOn: v.optional(
        v.stringOf({ pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: "Use YYYY-MM-DD" }),
    ),
});

export interface GetProgramInput {
    /** A program id, or an episode's `id`, for instance "MKTF73000514". */
    id: string;
}
/** @internal */
export const getProgramInput: v.Validator<GetProgramInput> = v.object({
    id: v.stringOf({ min: 1, max: 50 }),
});

export interface GetProgramsInput {
    /** 1-20 program ids. */
    ids: string[];
}
/** @internal */
export const getProgramsInput: v.Validator<GetProgramsInput> = v.object({
    ids: v.array(v.stringOf({ min: 1, max: 50 }), { min: 1, max: 20 }),
});

// ── Errors ──────────────────────────────────────────────────────────

/**
 * - `not_found`: 400/404/410, the id does not exist (or is gone)
 * - `forbidden`: 403, not available to us (e.g. geoblocked)
 * - `rate_limited`: 429, back off for retryAfterSeconds
 * - `upstream_error`: 5xx or another unexpected HTTP status
 * - `invalid_response`: NRK answered with an unexpected shape, or the result did not match its type
 * - `invalid_input`: the caller sent bad arguments
 * - `not_playable`: getPlayback only. The program exists but NRK will not stream it now (expired,
 *   not published yet, ...). `message` is NRK's text for the end user, in Norwegian.
 * - `network`: the request never completed
 * - `unknown`
 */
export type NrkErrorCode =
    | "not_found"
    | "forbidden"
    | "rate_limited"
    | "upstream_error"
    | "invalid_response"
    | "invalid_input"
    | "not_playable"
    | "network"
    | "unknown";
const ERROR_CODES = v.allOf<NrkErrorCode>({
    not_found: true,
    forbidden: true,
    rate_limited: true,
    upstream_error: true,
    invalid_response: true,
    invalid_input: true,
    not_playable: true,
    network: true,
    unknown: true,
});

export interface NrkError {
    readonly code: NrkErrorCode;
    readonly message: string;
    readonly retryAfterSeconds?: number | undefined;
}
const nrkErrorValidator: v.Validator<NrkError> = v.object({
    code: v.oneOf(...ERROR_CODES),
    message: v.string,
    retryAfterSeconds: v.optional(v.number),
});

// what a call reports in `failed`: what it asked for, and why that part failed
const failedLetters = v.array(v.object({ letter: v.string, error: nrkErrorValidator }));
const failedIds = v.array(v.object({ id: v.string, error: nrkErrorValidator }));

export type Result<T> =
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly error: NrkError };

// ── Catalog ─────────────────────────────────────────────────────────

export interface ContentItem {
    /**
     * A program id or episode id (use it with getProgram or getPlayback) or a series id
     * (use it with getSeries), for instance 'MKTF73000514' or 'dagsrevyen'.
     */
    readonly id: string;
    readonly type: "program" | "series" | "episode";
    readonly title: string;
    /**
     * NRK's own text, complete. Empty when NRK
     * has none (about 1 in 10). Nothing richer exists at NRK for a single program;
     * per-episode text is only available through getProgram(s).
     */
    readonly description: string;
    /** false when it cannot currently be streamed on demand. */
    readonly availableNow: boolean;
    readonly geoBlocked: boolean;
    /** Episodes (search only): the series it belongs to. Absent for programs and series. */
    readonly seriesId?: string | undefined;
    readonly seriesTitle?: string | undefined;
    /**
     * A small picture (about 300 px wide) for lists and cards, or null when NRK has none.
     * getPlayback has a larger poster for the player.
     */
    readonly imageUrl: string | null;
}
const contentItemValidator: v.Validator<ContentItem> = v.object({
    id: v.nonEmptyString(),
    type: v.oneOf("program", "series", "episode"),
    title: v.string,
    description: v.string,
    availableNow: v.boolean,
    geoBlocked: v.boolean,
    seriesId: v.optional(v.string),
    seriesTitle: v.optional(v.string),
    imageUrl: v.nullable(v.url),
});

/** The archive's programs and series (one entry per program or series, from NRK's letter index). */
export interface Catalog {
    readonly items: ReadonlyArray<ContentItem>;
    /** Letters that could not be fetched; the rest are still returned. */
    readonly failed: ReadonlyArray<{ readonly letter: string; readonly error: NrkError }>;
}
/** @internal */
export const catalogValidator: v.Validator<Catalog> = v.object({
    items: v.array(contentItemValidator),
    failed: failedLetters,
});

// ── Series and episodes ─────────────────────────────────────────────

export interface Season {
    /** Pass this as seasonName to getEpisodes. */
    readonly name: string;
    readonly title: string;
}
const seasonValidator: v.Validator<Season> = v.object({ name: v.string, title: v.string });

export interface Series {
    readonly id: string;
    readonly title: string;
    /** 'standard' | 'sequential' (numbered episodes) | 'news' (daily bulletins). */
    readonly seriesType: SeriesType;
    /** NRK's classification, e.g. { id: "dokumentar", name: "Dokumentar" }. */
    readonly category: { readonly id: string; readonly name: string } | null;
    readonly seasons: ReadonlyArray<Season>;
    /**
     * A small picture (about 300 px wide) for lists and cards, or null when NRK has none.
     * getPlayback has a larger poster for the player.
     */
    readonly imageUrl: string | null;
}
/** @internal */
export const seriesValidator: v.Validator<Series> = v.object({
    id: v.nonEmptyString(),
    title: v.string,
    seriesType: v.oneOf(...SERIES_TYPES),
    category: v.nullable(v.object({ id: v.string, name: v.string })),
    seasons: v.array(seasonValidator),
    imageUrl: v.nullable(v.url),
});

/** A person credited on a program: presenter, performer, actor, ... */
export interface Contributor {
    readonly name: string;
    /** NRK's label: "Medvirkende", "Programleder", "Artister/Utøvere", "Skuespillere", ... */
    readonly role: string;
}
const contributorValidator: v.Validator<Contributor> = v.object({ name: v.string, role: v.string });

export interface Episode {
    /** Program id - use this in a schedule and with getPrograms. */
    readonly id: string;
    readonly title: string;
    readonly subtitle: string | null;
    readonly durationSeconds: number;
    readonly durationMinutes: number;
    /** Only for 'sequential' series. */
    readonly episodeNumber: number | null;
    readonly availableFrom: string | null;
    /** null = no known expiry. A schedule must not air the episode after this. */
    readonly availableTo: string | null;
    readonly status: AvailabilityStatus;
    readonly productionYear: number | null;
    /** When NRK first broadcast it, YYYY-MM-DD. Known for ~90% of episodes. */
    readonly firstAired: string | null;
    /** Credited people (about 1 in 3 episodes have any), at most 15. */
    readonly contributors: ReadonlyArray<Contributor>;
    /**
     * A small picture (about 300 px wide) for lists and cards, or null when NRK has none.
     * getPlayback has a larger poster for the player.
     */
    readonly imageUrl: string | null;
}
const episodeValidator: v.Validator<Episode> = v.object({
    id: v.nonEmptyString(),
    title: v.string,
    subtitle: v.nullable(v.string),
    durationSeconds: v.number,
    durationMinutes: v.number,
    episodeNumber: v.nullable(v.number),
    availableFrom: v.nullable(v.string),
    availableTo: v.nullable(v.string),
    status: v.oneOf(...AVAILABILITY_STATUSES),
    productionYear: v.nullable(v.number),
    firstAired: v.nullable(isoDate),
    contributors: v.array(contributorValidator),
    imageUrl: v.nullable(v.url),
});

/** All episodes of one season (NRK returns a season in one response). */
export interface Episodes {
    readonly seriesId: string;
    readonly seasonName: string;
    readonly seasonType: SeasonType;
    readonly episodes: ReadonlyArray<Episode>;
}
/** @internal */
export const episodesValidator: v.Validator<Episodes> = v.object({
    seriesId: v.nonEmptyString(),
    seasonName: v.string,
    seasonType: v.oneOf(...SEASON_TYPES),
    episodes: v.array(episodeValidator),
});

// ── Programs ────────────────────────────────────────────────────────

export interface Program {
    readonly id: string;
    readonly title: string;
    readonly subtitle: string | null;
    /** NRK category id, e.g. 'dokumentar', 'sport', 'barn'. */
    readonly category: string;
    /**
     * NRK's text about this program (for an episode: about that episode).
     * "" = NRK has none. null = could not be fetched (e.g. not yet published).
     */
    readonly description: string | null;
    readonly durationSeconds: number;
    readonly durationMinutes: number;
    readonly availableFrom: string | null;
    readonly availableTo: string | null;
    readonly status: AvailabilityStatus;
    readonly productionYear: number | null;
    /** When NRK first broadcast it, YYYY-MM-DD (null when unknown). */
    readonly firstAired: string | null;
    /** Credited people (about 1 in 5 programs have any), at most 15. */
    readonly contributors: ReadonlyArray<Contributor>;
    /** Set when this program is an episode of a series (use it to group history by series). */
    readonly seriesId: string | null;
    /**
     * A small picture (about 300 px wide) for lists and cards, or null when NRK has none.
     * getPlayback has a larger poster for the player.
     */
    readonly imageUrl: string | null;
}
/** @internal */
export const programValidator: v.Validator<Program> = v.object({
    id: v.nonEmptyString(),
    title: v.string,
    subtitle: v.nullable(v.string),
    category: v.string,
    description: v.nullable(v.string),
    durationSeconds: v.number,
    durationMinutes: v.number,
    availableFrom: v.nullable(v.string),
    availableTo: v.nullable(v.string),
    status: v.oneOf(...AVAILABILITY_STATUSES),
    productionYear: v.nullable(v.number),
    firstAired: v.nullable(isoDate),
    contributors: v.array(contributorValidator),
    seriesId: v.nullable(v.nonEmptyString()),
    imageUrl: v.nullable(v.url),
});

export interface Programs {
    readonly programs: ReadonlyArray<Program>;
    /** Ids that could not be fetched; the rest are still returned. */
    readonly failed: ReadonlyArray<{ readonly id: string; readonly error: NrkError }>;
}
/** @internal */
export const programsValidator: v.Validator<Programs> = v.object({
    programs: v.array(programValidator),
    failed: failedIds,
});

// ── Playback ────────────────────────────────────────────────────────

/** One subtitle file, WebVTT. */
export interface SubtitleTrack {
    /** Language code, for instance "nb". */
    readonly language: string;
    /** Text for a language menu, for instance "Norsk på all tale". */
    readonly label: string;
    /** URL of the .vtt file. */
    readonly url: string;
    /** NRK's advice: show this track by default. */
    readonly defaultOn: boolean;
}
const subtitleTrackValidator: v.Validator<SubtitleTrack> = v.object({
    language: v.nonEmptyString(),
    label: v.string,
    url: v.url,
    defaultOn: v.boolean,
});

/** What a player needs to play one episode or program. Give it to the player as it is. */
export interface Playback {
    /** The prfId that was asked for. */
    readonly id: string;
    readonly title: string;
    /** null when NRK has none. */
    readonly subtitle: string | null;
    /** HLS master playlist. Play it with any HLS player (hls.js, AVPlayer, ExoPlayer, Safari). */
    readonly streamUrl: string;
    /** Content type of streamUrl, "application/vnd.apple.mpegurl". */
    readonly mimeType: string;
    readonly mediaType: "video" | "audio";
    /** null when NRK gives no usable duration. */
    readonly durationSeconds: number | null;
    /** null when NRK does not state it. */
    readonly aspectRatio: "16:9" | "4:3" | null;
    /** A poster to show before playback, about 960 px wide. null when there is none. */
    readonly posterUrl: string | null;
    /** Empty when the program has no subtitles. */
    readonly subtitles: ReadonlyArray<SubtitleTrack>;
    /** End of the streaming window (ISO 8601), or null when NRK gives none. */
    readonly availableTo: string | null;
}
/** @internal */
export const playbackValidator: v.Validator<Playback> = v.object({
    id: v.nonEmptyString(),
    title: v.string,
    subtitle: v.nullable(v.string),
    streamUrl: v.url,
    mimeType: v.nonEmptyString(),
    mediaType: v.oneOf("video", "audio"),
    durationSeconds: v.nullable(v.number),
    aspectRatio: v.nullable(v.oneOf("16:9", "4:3")),
    posterUrl: v.nullable(v.url),
    subtitles: v.array(subtitleTrackValidator),
    availableTo: v.nullable(v.string),
});

// ── Recommendations ─────────────────────────────────────────────────

/** Arguments for NrkClient.getRecommendations. */
export interface GetRecommendationInput {
    /** 1-5 ids the viewer likes or has watched: program ids, episode ids or series ids. */
    basedOn: string[];
    /** How many recommendations NRK gives for each id. Default 10. */
    count?: 5 | 10 | 15 | 20 | 25 | undefined;
}
/** @internal */
export const getRecommendationInput: v.Validator<GetRecommendationInput> = v.object({
    basedOn: v.array(v.stringOf({ min: 1, max: 200 }), { min: 1, max: 5 }),
    count: v.optional(v.oneOf(5, 10, 15, 20, 25)),
});

export interface RecommendedItem {
    /** A program id (use it with getProgram or getPlayback) or a series id (use it with getSeries). */
    readonly id: string;
    readonly type: "program" | "series";
    readonly title: string;
    /** null when NRK has none. */
    readonly subtitle: string | null;
    /** Which of the ids you passed in led to this recommendation. More than one means a stronger match. */
    readonly basedOn: ReadonlyArray<string>;
    /**
     * A small picture (about 300 px wide) for lists and cards, or null when NRK has none.
     * getPlayback has a larger poster for the player.
     */
    readonly imageUrl: string | null;
}
const recommendedItemValidator: v.Validator<RecommendedItem> = v.object({
    id: v.nonEmptyString(),
    type: v.oneOf("program", "series"),
    title: v.string,
    subtitle: v.nullable(v.string),
    basedOn: v.array(v.nonEmptyString(), { min: 1 }),
    imageUrl: v.nullable(v.url),
});

export interface Recommendations {
    /**
     * Best matches first: items recommended for several of your ids come before the rest.
     * The ids you passed in are left out. NRK does not say whether an item can be streamed
     * now; check with getProgram (`status`) or getPlayback.
     */
    readonly items: ReadonlyArray<RecommendedItem>;
    /** Ids NRK could not give recommendations for. The other ids still contributed. */
    readonly failed: ReadonlyArray<{ readonly id: string; readonly error: NrkError }>;
}
/** @internal */
export const recommendationsValidator: v.Validator<Recommendations> = v.object({
    items: v.array(recommendedItemValidator),
    failed: failedIds,
});

// ── Search ──────────────────────────────────────────────────────────

/** Arguments for NrkClient.search. */
export interface SearchInput {
    /** What to look for: a theme, a title or a person, in Norwegian, e.g. "norsk historie". */
    query: string;
    /** Most hits to return, 1-100. Default 20. */
    limit?: number | undefined;
}
/** @internal */
export const searchInput: v.Validator<SearchInput> = v.object({
    query: v.stringOf({ min: 1, max: 200, pattern: /\S/, patternMessage: "must not be blank" }),
    limit: v.optional(v.integer({ min: 1, max: 100 })),
});

export interface SearchResults {
    /** Best match first. Empty when nothing matches. */
    readonly items: ReadonlyArray<ContentItem>;
}
/** @internal */
export const searchResultsValidator: v.Validator<SearchResults> = v.object({
    items: v.array(contentItemValidator),
});
