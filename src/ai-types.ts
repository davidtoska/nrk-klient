/**
 * What AiClient returns. Deliberately small: only what an agent needs to pick
 * content and build a schedule. No image urls, display strings or HAL links.
 * All dates are ISO 8601 strings exactly as NRK sends them (or null).
 */

/** Arguments for AiClient.searchCatalog. Everything is optional. */
export interface SearchCatalogInput {
    /** Keywords separated by space or comma; matches title and description. Omit to browse. */
    query?: string;
    /** Default "any". */
    type?: "program" | "series" | "any";
    /** Require all keywords to match instead of any. Default false. */
    matchAll?: boolean;
    /** Only items that can be streamed now. Default true. */
    onDemandOnly?: boolean;
    /** Include items that are geoblocked outside Norway. Default false. */
    includeGeoBlocked?: boolean;
    /** Shorten descriptions to this many characters (20-5000). Default: full text. */
    descriptionMaxChars?: number;
    /** 1-50, default 20. */
    limit?: number;
    /** Default 0. */
    offset?: number;
}

export interface GetSeriesInput {
    seriesId: string;
}

export interface GetEpisodesInput {
    seriesId: string;
    /** A season name from getSeries. */
    seasonName: string;
    /** YYYY-MM-DD: only episodes that can be streamed on this date. */
    availableOn?: string;
    /** 1-200, default 50. */
    limit?: number;
    /** Default 0. */
    offset?: number;
}

export interface GetProgramsInput {
    /** 1-20 program ids. */
    programIds: string[];
}

export type AiErrorCode =
    | "not_found" // 400/404/410 - the id does not exist (or is gone)
    | "forbidden" // 403 - not available to us (e.g. geoblocked)
    | "rate_limited" // 429 - back off for retryAfterSeconds
    | "upstream_error" // 5xx or other unexpected HTTP status
    | "invalid_response" // NRK answered 200 with an unexpected shape
    | "invalid_input" // the caller sent bad arguments
    | "network" // the request never completed
    | "unknown";

export interface AiError {
    readonly code: AiErrorCode;
    readonly message: string;
    readonly retryAfterSeconds?: number;
}

export type AiResult<T> =
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly error: AiError };

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

export interface AiCatalogPage {
    readonly items: ReadonlyArray<AiCatalogItem>;
    /** Number of items matching the filters (before offset/limit). */
    readonly total: number;
    readonly offset: number;
    readonly hasMore: boolean;
    /** Number of items in the whole catalog index. */
    readonly catalogSize: number;
}

export interface AiSeason {
    /** Pass this as seasonName to getEpisodes. */
    readonly name: string;
    readonly title: string;
}

export interface AiSeries {
    readonly id: string;
    readonly title: string;
    /** 'standard' | 'sequential' (numbered episodes) | 'news' (daily bulletins). */
    readonly seriesType: "standard" | "sequential" | "news";
    /** NRK's classification, e.g. { id: "dokumentar", name: "Dokumentar" }. */
    readonly category: { readonly id: string; readonly name: string } | null;
    readonly seasons: ReadonlyArray<AiSeason>;
}

export type AiAvailabilityStatus =
    | "coming"
    | "available"
    | "expires"
    | "expired"
    | "notAvailableOnline";

/** A person credited on a program: presenter, performer, actor, ... */
export interface AiContributor {
    readonly name: string;
    /** NRK's label: "Medvirkende", "Programleder", "Artister/Utøvere", "Skuespillere", ... */
    readonly role: string;
}

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
    /** Credited people (about 1 in 3 episodes have any), capped at AiClientOptions.maxContributors. */
    readonly contributors: ReadonlyArray<AiContributor>;
}

export interface AiEpisodesPage {
    readonly seriesId: string;
    readonly seasonName: string;
    readonly seasonType: "latest" | "extramaterial" | "season";
    /** Number of episodes matching the filters (before offset/limit). */
    readonly total: number;
    readonly offset: number;
    readonly hasMore: boolean;
    readonly episodes: ReadonlyArray<AiEpisode>;
}

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
    /** Credited people (about 1 in 5 programs have any), capped at AiClientOptions.maxContributors. */
    readonly contributors: ReadonlyArray<AiContributor>;
    /** Set when this program is an episode of a series (use it to group history by series). */
    readonly seriesId: string | null;
}

export interface AiProgramsResult {
    readonly programs: ReadonlyArray<AiProgram>;
    /** Ids that could not be fetched; the rest are still returned. */
    readonly failed: ReadonlyArray<{ readonly id: string; readonly error: AiError }>;
}
