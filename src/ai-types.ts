import * as v from "./validate";
import { AVAILABILITY_STATUSES, SEASON_TYPES, SERIES_TYPES, isoDate } from "./nrk-response";
import type { AvailabilityStatus, SeasonType, SeriesType } from "./nrk-response";

// What AiClient accepts and returns. Deliberately small: only what an agent needs to pick
// content and build a schedule. No image urls, display strings or HAL links.
// All dates are ISO 8601 strings exactly as NRK sends them (or null).
//
// Each type is followed by its validator, typed `Validator<TheType>` so the compiler makes
// it agree with the interface. Inputs are validated on the way in and results on the way
// out, so a caller never gets a value that contradicts the declared type. The validators
// carry the internal tag and are stripped from the published declarations.

// ── Input ───────────────────────────────────────────────────────────

/**
 * What the validators produce: defaults applied, so only the truly optional fields may be missing.
 * @internal
 */
export type WithDefaults<I, Optional extends keyof I = never> = {
    [K in Exclude<keyof I, Optional>]-?: Exclude<I[K], undefined>;
} & { [K in Optional]?: I[K] };

/** Arguments for AiClient.searchCatalog. Everything is optional. */
export interface SearchCatalogInput {
    /** Keywords separated by space or comma; matches title and description. Omit to browse. */
    query?: string | undefined;
    /** Default "any". */
    type?: "program" | "series" | "any" | undefined;
    /** Require all keywords to match instead of any. Default false. */
    matchAll?: boolean | undefined;
    /** Only items that can be streamed now. Default true. */
    onDemandOnly?: boolean | undefined;
    /** Include items that are geoblocked outside Norway. Default false. */
    includeGeoBlocked?: boolean | undefined;
    /** Shorten descriptions to this many characters (20-5000). Default: full text. */
    descriptionMaxChars?: number | undefined;
    /** 1-50, default 20. */
    limit?: number | undefined;
    /** Default 0. */
    offset?: number | undefined;
}
/** @internal */
export type SearchCatalogQuery = WithDefaults<SearchCatalogInput, "query" | "descriptionMaxChars">;
/** @internal */
export const searchCatalogInput: v.Validator<SearchCatalogQuery> = v.object({
    query: v.optional(v.stringOf({ max: 200 })),
    type: v.withDefault(v.oneOf("program", "series", "any"), "any"),
    matchAll: v.withDefault(v.boolean, false),
    onDemandOnly: v.withDefault(v.boolean, true),
    includeGeoBlocked: v.withDefault(v.boolean, false),
    descriptionMaxChars: v.optional(v.integer({ min: 20, max: 5000 })),
    limit: v.withDefault(v.integer({ min: 1, max: 50 }), 20),
    offset: v.withDefault(v.integer({ min: 0 }), 0),
});

export interface GetSeriesInput {
    seriesId: string;
}
/** @internal */
export const getSeriesInput: v.Validator<GetSeriesInput> = v.object({
    seriesId: v.stringOf({ min: 1, max: 200 }),
});

export interface GetEpisodesInput {
    seriesId: string;
    /** A season name from getSeries. */
    seasonName: string;
    /** YYYY-MM-DD: only episodes that can be streamed on this date. */
    availableOn?: string | undefined;
    /** 1-200, default 50. */
    limit?: number | undefined;
    /** Default 0. */
    offset?: number | undefined;
}
/** @internal */
export type GetEpisodesQuery = WithDefaults<GetEpisodesInput, "availableOn">;
/** @internal */
export const getEpisodesInput: v.Validator<GetEpisodesQuery> = v.object({
    seriesId: v.stringOf({ min: 1, max: 200 }),
    seasonName: v.stringOf({ min: 1, max: 200 }),
    availableOn: v.optional(
        v.stringOf({ pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: "Use YYYY-MM-DD" }),
    ),
    limit: v.withDefault(v.integer({ min: 1, max: 200 }), 50),
    offset: v.withDefault(v.integer({ min: 0 }), 0),
});

export interface GetProgramsInput {
    /** 1-20 program ids. */
    programIds: string[];
}
/** @internal */
export const getProgramsInput: v.Validator<GetProgramsInput> = v.object({
    programIds: v.array(v.stringOf({ min: 1, max: 50 }), { min: 1, max: 20 }),
});

// ── Errors ──────────────────────────────────────────────────────────

/**
 * - `not_found`: 400/404/410, the id does not exist (or is gone)
 * - `forbidden`: 403, not available to us (e.g. geoblocked)
 * - `rate_limited`: 429, back off for retryAfterSeconds
 * - `upstream_error`: 5xx or another unexpected HTTP status
 * - `invalid_response`: NRK answered with an unexpected shape, or the result did not match its type
 * - `invalid_input`: the caller sent bad arguments
 * - `network`: the request never completed
 * - `unknown`
 */
export type AiErrorCode =
    | "not_found"
    | "forbidden"
    | "rate_limited"
    | "upstream_error"
    | "invalid_response"
    | "invalid_input"
    | "network"
    | "unknown";
/** @internal */
export const AI_ERROR_CODES = v.allOf<AiErrorCode>({
    not_found: true,
    forbidden: true,
    rate_limited: true,
    upstream_error: true,
    invalid_response: true,
    invalid_input: true,
    network: true,
    unknown: true,
});

export interface AiError {
    readonly code: AiErrorCode;
    readonly message: string;
    readonly retryAfterSeconds?: number | undefined;
}
/** @internal */
export const aiError: v.Validator<AiError> = v.object({
    code: v.oneOf(...AI_ERROR_CODES),
    message: v.string,
    retryAfterSeconds: v.optional(v.number),
});

export type AiResult<T> =
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly error: AiError };

// ── Catalog ─────────────────────────────────────────────────────────

export interface AiCatalogItem {
    /** Program id (e.g. 'MKTF73000514') or series id (e.g. 'dagsrevyen'). */
    readonly id: string;
    readonly type: "program" | "series";
    readonly title: string;
    /**
     * NRK's own text, complete unless descriptionMaxChars was given. Empty when NRK
     * has none (about 1 in 10). Nothing richer exists at NRK for a single program;
     * per-episode text is only available through getProgram(s).
     */
    readonly description: string;
    /** false when it cannot currently be streamed on demand. */
    readonly availableNow: boolean;
    readonly geoBlocked: boolean;
}
/** @internal */
export const aiCatalogItem: v.Validator<AiCatalogItem> = v.object({
    id: v.nonEmptyString(),
    type: v.oneOf("program", "series"),
    title: v.string,
    description: v.string,
    availableNow: v.boolean,
    geoBlocked: v.boolean,
});

export interface AiCatalogPage {
    readonly items: ReadonlyArray<AiCatalogItem>;
    /** Number of items matching the filters (before offset/limit). */
    readonly total: number;
    readonly offset: number;
    readonly hasMore: boolean;
    /** Number of items in the whole catalog index. */
    readonly catalogSize: number;
}
/** @internal */
export const aiCatalogPage: v.Validator<AiCatalogPage> = v.object({
    items: v.array(aiCatalogItem),
    total: v.integer({ min: 0 }),
    offset: v.integer({ min: 0 }),
    hasMore: v.boolean,
    catalogSize: v.integer({ min: 0 }),
});

// ── Series and episodes ─────────────────────────────────────────────

export interface AiSeason {
    /** Pass this as seasonName to getEpisodes. */
    readonly name: string;
    readonly title: string;
}
/** @internal */
export const aiSeason: v.Validator<AiSeason> = v.object({ name: v.string, title: v.string });

export interface AiSeries {
    readonly id: string;
    readonly title: string;
    /** 'standard' | 'sequential' (numbered episodes) | 'news' (daily bulletins). */
    readonly seriesType: SeriesType;
    /** NRK's classification, e.g. { id: "dokumentar", name: "Dokumentar" }. */
    readonly category: { readonly id: string; readonly name: string } | null;
    readonly seasons: ReadonlyArray<AiSeason>;
}
/** @internal */
export const aiSeries: v.Validator<AiSeries> = v.object({
    id: v.nonEmptyString(),
    title: v.string,
    seriesType: v.oneOf(...SERIES_TYPES),
    category: v.nullable(v.object({ id: v.string, name: v.string })),
    seasons: v.array(aiSeason),
});

export type AiAvailabilityStatus = AvailabilityStatus;

/** A person credited on a program: presenter, performer, actor, ... */
export interface AiContributor {
    readonly name: string;
    /** NRK's label: "Medvirkende", "Programleder", "Artister/Utøvere", "Skuespillere", ... */
    readonly role: string;
}
/** @internal */
export const aiContributor: v.Validator<AiContributor> = v.object({ name: v.string, role: v.string });

export interface AiEpisode {
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
    readonly status: AiAvailabilityStatus;
    readonly productionYear: number | null;
    /** When NRK first broadcast it, YYYY-MM-DD. Known for ~90% of episodes. */
    readonly firstAired: string | null;
    /** Credited people (about 1 in 3 episodes have any), at most 15. */
    readonly contributors: ReadonlyArray<AiContributor>;
}
/** @internal */
export const aiEpisode: v.Validator<AiEpisode> = v.object({
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
    contributors: v.array(aiContributor),
});

export interface AiEpisodesPage {
    readonly seriesId: string;
    readonly seasonName: string;
    readonly seasonType: SeasonType;
    /** Number of episodes matching the filters (before offset/limit). */
    readonly total: number;
    readonly offset: number;
    readonly hasMore: boolean;
    readonly episodes: ReadonlyArray<AiEpisode>;
}
/** @internal */
export const aiEpisodesPage: v.Validator<AiEpisodesPage> = v.object({
    seriesId: v.nonEmptyString(),
    seasonName: v.string,
    seasonType: v.oneOf(...SEASON_TYPES),
    total: v.integer({ min: 0 }),
    offset: v.integer({ min: 0 }),
    hasMore: v.boolean,
    episodes: v.array(aiEpisode),
});

// ── Programs ────────────────────────────────────────────────────────

export interface AiProgram {
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
    readonly status: AiAvailabilityStatus;
    readonly productionYear: number | null;
    /** When NRK first broadcast it, YYYY-MM-DD (null when unknown). */
    readonly firstAired: string | null;
    /** Credited people (about 1 in 5 programs have any), at most 15. */
    readonly contributors: ReadonlyArray<AiContributor>;
    /** Set when this program is an episode of a series (use it to group history by series). */
    readonly seriesId: string | null;
}
/** @internal */
export const aiProgram: v.Validator<AiProgram> = v.object({
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
    contributors: v.array(aiContributor),
    seriesId: v.nullable(v.nonEmptyString()),
});

export interface AiProgramsResult {
    readonly programs: ReadonlyArray<AiProgram>;
    /** Ids that could not be fetched; the rest are still returned. */
    readonly failed: ReadonlyArray<{ readonly id: string; readonly error: AiError }>;
}
/** @internal */
export const aiProgramsResult: v.Validator<AiProgramsResult> = v.object({
    programs: v.array(aiProgram),
    failed: v.array(v.object({ id: v.string, error: aiError })),
});
