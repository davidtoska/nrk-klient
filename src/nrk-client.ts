import { NRK } from "./client";
import { nearestImageUrl } from "./nrk-format";
import { NrkHttpError } from "./nrk-client-raw";
import { NrkValidationError, Validator, formatIssues, safeParse } from "./validate";
import {
    catalogValidator,
    episodesValidator,
    programValidator,
    playbackValidator,
    recommendationsValidator,
    programsValidator,
    seriesValidator,
    getEpisodesInput,
    getProgramInput,
    getProgramsInput,
    getRecommendationInput,
    getSeriesInput,
    listCatalogInput,
    searchInput,
    searchResultsValidator,
} from "./types";
import type {
    GetEpisodesInput,
    GetProgramInput,
    GetProgramsInput,
    GetRecommendationInput,
    GetSeriesInput,
    ListCatalogInput,
    SearchInput,
    SearchResults,
    ContentItem,
    Contributor,
    Catalog,
    Episode,
    Episodes,
    NrkError,
    Playback,
    Program,
    Programs,
    RecommendedItem,
    Recommendations,
    Result,
    Series,
} from "./types";
import type { NrkEpisode, SeasonsWithEpisodes } from "./nrk-response";

/**
 * The part of the raw NRK client that NrkClient uses.
 * @internal
 */
export type NrkLike = Pick<
    typeof NRK,
    "letter" | "getSeasons" | "getAllEpisodes" | "getProgramById" | "getMetadata" | "getPlayback" | "getRecommendation" | "search"
>;

/**
 * Seams for tests. Not part of the public API: the published declarations only have
 * `new NrkClient()`.
 * @internal
 */
export interface NrkClientConfig {
    nrk?: NrkLike;
    letters?: string;
    minIntervalMs?: number;
    maxContributors?: number;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzæøå";
/** Minimum time between two requests to NRK: NRK answers 429 when it is hit hard. */
const MIN_INTERVAL_MS = 250;
/** Most credited people returned per program or episode (p99 is 17). */
const MAX_CONTRIBUTORS = 15;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const toMinutes = (seconds: number): number => {
    return Math.round(seconds / 60);
};

/** Node's fetch throws TypeError("fetch failed") with a cause; timeouts throw a TimeoutError. */
const isNetworkFailure = (e: unknown): boolean =>
    (e instanceof TypeError && (e.message === "fetch failed" || "cause" in e)) ||
    (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));

/**
 * Converts anything thrown by the NRK client into an NrkError.
 * @internal
 */
export const toNrkError = (e: unknown): NrkError => {
    if (e instanceof NrkHttpError) {
        let where = e.url;
        try {
            where = decodeURIComponent(new URL(e.url).pathname);
        } catch {
            // keep the full url
        }
        const message = `NRK responded ${e.status} for ${where}`;
        if (e.status === 400 || e.status === 404 || e.status === 410) {
            return { code: "not_found", message };
        }
        if (e.status === 403) {
            return { code: "forbidden", message };
        }
        if (e.status === 429) {
            return e.retryAfterSeconds === null
                ? { code: "rate_limited", message }
                : { code: "rate_limited", message, retryAfterSeconds: e.retryAfterSeconds };
        }
        return { code: "upstream_error", message };
    }
    if (e instanceof NrkValidationError) {
        return {
            code: "invalid_response",
            message: "NRK returned an unexpected response shape: " + formatIssues(e.issues, 3),
        };
    }
    if (isNetworkFailure(e)) {
        return { code: "network", message: e instanceof Error ? e.message : String(e) };
    }
    return { code: "unknown", message: e instanceof Error ? e.message : String(e) };
};

const parseInput = <T>(validator: Validator<T>, input: unknown): Result<T> => {
    const parsed = safeParse(validator, input);
    if (parsed.success) {
        return { ok: true, data: parsed.data };
    }
    return {
        ok: false,
        error: { code: "invalid_input", message: formatIssues(parsed.issues, 3) },
    };
};

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = <T>(error: NrkError): Result<T> => ({ ok: false, error });

/**
 * Every result is checked against its declared type before it is returned. A value that
 * does not match becomes an invalid_response error instead of reaching the caller.
 */
const checked = <T>(validator: Validator<T>, value: T): Result<T> => {
    const result = safeParse(validator, value);
    if (result.success) {
        return ok(result.data);
    }
    return fail({
        code: "invalid_response",
        message: "Result does not match its type: " + formatIssues(result.issues, 3),
    });
};

/**
 * An API against NRK, shaped for an AI agent:
 *
 *  - small, flat results with only the fields needed to pick content and build
 *    a schedule (ids, titles, duration, availability window, credited people),
 *  - methods never throw: they return { ok, data } or { ok: false, error },
 *    with error codes an agent can act on (for instance rate_limited),
 *  - partial results where a call covers several requests (listCatalog, getPrograms),
 *  - requests are spaced 250 ms apart, because NRK answers 429 when it is hit hard.
 *
 * It stores nothing. Every call goes to NRK, so keeping a copy of the catalog, searching
 * it, and caching what has been fetched is up to the code that uses this class.
 *
 * Ids: a program or episode id is a "prfId" such as "MKTF73000514"; a series id is a
 * slug such as "dagsrevyen". Catalog items and episodes carry the ids to pass on.
 * Typical flow: listCatalog -> getSeries -> getEpisodes -> getPlayback (or getProgram).
 * search finds content from free text; getRecommendations finds more of what a viewer
 * might like, from ids they liked.
 *
 * @example
 * const client = new NrkClient();
 * const playback = await client.getPlayback({ id: "MKTF73000514" });
 * if (playback.ok) {
 *   player.load(playback.data.streamUrl);
 * } else {
 *   console.log(playback.error.code, playback.error.message);
 * }
 */
export class NrkClient {
    private readonly nrk: NrkLike;
    private readonly letters: string;
    private readonly minIntervalMs: number;
    private readonly maxContributors: number;

    private nextRequestAt = 0;

    /** @internal */
    constructor(config: NrkClientConfig);
    constructor();
    constructor(config: NrkClientConfig = {}) {
        this.nrk = config.nrk ?? NRK;
        this.letters = config.letters ?? ALPHABET;
        this.minIntervalMs = config.minIntervalMs ?? MIN_INTERVAL_MS;
        this.maxContributors = config.maxContributors ?? MAX_CONTRIBUTORS;
    }

    // ── Catalog ─────────────────────────────────────────────────────

    /**
     * The archive's programs and series, one request per letter (the whole alphabet is about
     * 30 requests and roughly 12,000 items). This listing is what to build your own
     * index from (use `search` to look up a single theme). Letters that could not be fetched are reported in
     * `failed` and the rest are returned; the call stops early on rate limiting.
     *
     * @param input.letters Letters to list, for instance `"abc"` (letters only, a-z, æ, ø, å).
     *   Default: the whole alphabet.
     * @example
     * const all = await client.listCatalog();
     * const onlyA = await client.listCatalog({ letters: "a" });
     */
    listCatalog = async (input: ListCatalogInput = {}): Promise<Result<Catalog>> => {
        const parsed = parseInput(listCatalogInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const letters = [...new Set((parsed.data.letters ?? this.letters).toLowerCase().split(""))];

        const items: ContentItem[] = [];
        const failed: Array<{ letter: string; error: NrkError }> = [];
        const seen = new Set<string>();
        for (const letter of letters) {
            try {
                const response = await this.call(() => this.nrk.letter(letter));
                const listed = [
                    ...response.programs.map((c) => ({ c, type: "program" as const })),
                    ...response.series.map((c) => ({ c, type: "series" as const })),
                ];
                for (const { c, type } of listed) {
                    const key = `${type}:${c.id}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    items.push({
                        id: c.id,
                        type,
                        title: c.title,
                        description: c.description,
                        availableNow: c.hasOnDemandRights,
                        geoBlocked: c.isGeoBlocked,
                        imageUrl: c.imageUrl,
                    });
                }
            } catch (e) {
                const error = toNrkError(e);
                failed.push({ letter, error });
                // no point in hammering NRK when it asks us to slow down
                if (error.code === "rate_limited") break;
            }
        }
        return checked(catalogValidator, { items, failed });
    };

    /**
     * Free-text search in NRK TV: series, programs and single episodes, best match first. Use it
     * to look for a theme, a title or a person without holding a copy of the catalog. One request.
     * An episode hit has its own program id (use it with getPlayback) and the series it belongs to.
     *
     * NRK matches words in titles and descriptions and forgives small spelling mistakes, but it
     * is not a semantic search: "norsk historie" finds programs with those words, not everything
     * about the subject. Try several phrasings. Nothing matching gives an empty list, not an error.
     *
     * @param input.query Text to search for, for instance `"norsk historie"` (max 200 characters).
     * @param input.limit Most hits to return, 1-100. Default 20.
     * @example
     * const found = await client.search({ query: "norsk historie", limit: 30 });
     * if (found.ok) console.log(found.data.items.map((i) => `${i.type} ${i.id} ${i.title}`));
     */
    search = async (input: SearchInput): Promise<Result<SearchResults>> => {
        const parsed = parseInput(searchInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { query, limit } = parsed.data;

        try {
            const hits = await this.call(() => this.nrk.search(query, limit ?? 20));
            return checked(searchResultsValidator, {
                items: hits.map((hit) => ({
                    id: hit.id,
                    type: hit.type,
                    title: hit.title,
                    description: hit.description,
                    availableNow: hit.hasRights,
                    geoBlocked: hit.isGeoBlocked,
                    imageUrl: hit.imageUrl,
                    ...(hit.seriesId === null
                        ? {}
                        : {
                              seriesId: hit.seriesId,
                              ...(hit.seriesTitle === null ? {} : { seriesTitle: hit.seriesTitle }),
                          }),
                })),
            });
        } catch (e) {
            return fail(toNrkError(e));
        }
    };

    // ── Series and episodes ─────────────────────────────────────────

    /**
     * A series with its title, type, category and seasons. Pass a season's `name` to getEpisodes.
     *
     * @param input.id Series id from listCatalog or search (`type: "series"`), for instance `"dagsrevyen"`.
     * @example
     * const series = await client.getSeries({ id: "dagsrevyen" });
     */
    getSeries = async (input: GetSeriesInput): Promise<Result<Series>> => {
        const parsed = parseInput(getSeriesInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const seriesId = parsed.data.id;

        try {
            const series = await this.call(() => this.nrk.getSeasons(seriesId));
            return checked(seriesValidator, {
                id: series.seriesId,
                title: series.title,
                seriesType: series.seriesType,
                category: series.category,
                seasons: series.seasons.map((s) => ({ name: s.name, title: s.title })),
                imageUrl: series.imageUrl300,
            });
        } catch (e) {
            return fail(toNrkError(e));
        }
    };

    /**
     * All episodes of one season (NRK returns a season in one response, which for a
     * long-running news series can be a few hundred episodes).
     *
     * @param input.seriesId Series id, for instance `"dagsrevyen"`.
     * @param input.seasonName A season's `name` from getSeries, for instance `"2024"`.
     * @param input.availableOn Optional date, `YYYY-MM-DD`. Only episodes that can be streamed on
     *   that day are returned (useful when building a schedule).
     * @example
     * const season = await client.getEpisodes({
     *   seriesId: "dagsrevyen",
     *   seasonName: "2024",
     *   availableOn: "2026-10-03",
     * });
     */
    getEpisodes = async (input: GetEpisodesInput): Promise<Result<Episodes>> => {
        const parsed = parseInput(getEpisodesInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { seriesId, seasonName, availableOn } = parsed.data;

        try {
            const season = await this.call(() => this.nrk.getAllEpisodes(seriesId, seasonName));
            return checked(episodesValidator, toEpisodes(season, availableOn, this.maxContributors));
        } catch (e) {
            return fail(toNrkError(e));
        }
    };

    // ── Programs ────────────────────────────────────────────────────

    /**
     * One program or episode with NRK's description, credited people, duration, availability
     * window, production year and first broadcast date. Two requests.
     *
     * @param input.id Program id, or an episode's `id`, for instance `"MKTF73000514"`.
     * @example
     * const program = await client.getProgram({ id: "MKTF73000514" });
     */
    getProgram = async (input: GetProgramInput): Promise<Result<Program>> => {
        const parsed = parseInput(getProgramInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const programId = parsed.data.id;

        try {
            const p = await this.call(() => this.nrk.getProgramById(programId));
            const description = await this.getDescription(programId);
            return checked(programValidator, {
                id: p.id,
                title: p.title,
                // NRK often repeats the description as the subtitle; that adds only tokens
                subtitle: p.subtitle && p.subtitle !== description ? p.subtitle : null,
                category: p.category,
                description,
                durationSeconds: p.durationInSeconds,
                durationMinutes: toMinutes(p.durationInSeconds),
                availableFrom: p.availableFromDate,
                availableTo: p.availableToDate,
                status: p.availabilityStatus,
                productionYear: p.productionYear,
                firstAired: p.firstAired,
                contributors: p.contributors.slice(0, this.maxContributors).map(toContributor),
                seriesId: p.seriesId,
                imageUrl: nearestImageUrl(p.images),
            });
        } catch (e) {
            return fail(toNrkError(e));
        }
    };

    /**
     * What a player needs to play one episode or program (pass an episode's `id`): the HLS
     * stream, subtitles, poster, duration and title. Hand the data to the player as it is.
     * A program NRK will not stream now (expired, not published yet) gives `not_playable`,
     * with NRK's text for the end user as the message. The stream address is not permanent:
     * ask for it when the viewer presses play, and do not store it.
     *
     * @param input.id Program id, or an episode's `id`, for instance `"MKTF73000514"`.
     * @example
     * const playback = await client.getPlayback({ id: "MKTF73000514" });
     */
    getPlayback = async (input: GetProgramInput): Promise<Result<Playback>> => {
        const parsed = parseInput(getProgramInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const programId = parsed.data.id;

        try {
            const source = await this.call(() => this.nrk.getPlayback(programId));
            if (!source.playable) {
                return fail({ code: "not_playable", message: source.message });
            }
            return checked(playbackValidator, {
                id: source.prfId,
                title: source.title,
                subtitle: source.subtitle === "" ? null : source.subtitle,
                streamUrl: source.streamUrl,
                mimeType: source.mimeType,
                mediaType: source.mediaType,
                durationSeconds: source.durationSeconds,
                aspectRatio: source.aspectRatio,
                posterUrl: source.posterUrl,
                subtitles: source.subtitles,
                availableTo: source.availableTo,
            });
        } catch (e) {
            return fail(toNrkError(e));
        }
    };

    // ── Recommendations ─────────────────────────────────────────────

    /**
     * Programs and series NRK recommends to someone who liked the given ones. Give it what the
     * viewer likes or has watched (program, episode or series ids); the results for all of them
     * are merged, the given ids are left out, and items that come up for several of them are
     * listed first. One request per id, and each item says which of your ids led to it.
     *
     * NRK gives no descriptions or availability here. Follow up with getProgram (`status`,
     * description), getSeries or getPlayback. An id NRK does not know gets general
     * recommendations, not an error. Ids NRK fails on are reported in `failed`; if all of them
     * fail, the call returns the error.
     *
     * @param input.basedOn 1-5 ids, for instance `["MKTF73000514", "dagsrevyen"]`.
     * @param input.count Recommendations per id: 5, 10, 15, 20 or 25. Default 10.
     * @example
     * const recs = await client.getRecommendations({ basedOn: ["MKTF73000514"] });
     * if (recs.ok) console.log(recs.data.items.map((i) => i.title));
     */
    getRecommendations = async (input: GetRecommendationInput): Promise<Result<Recommendations>> => {
        const parsed = parseInput(getRecommendationInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { basedOn, count } = parsed.data;
        const asked = [...new Set(basedOn)];

        const found = new Map<string, { id: string; type: "program" | "series"; title: string; subtitle: string | null; basedOn: string[]; imageUrl: string | null }>();
        const failed: Array<{ id: string; error: NrkError }> = [];
        for (const id of asked) {
            try {
                const response = await this.call(() => this.nrk.getRecommendation(id, { count: count ?? 10 }));
                for (const item of [...response.programs, ...response.series]) {
                    if (asked.includes(item.id)) continue;
                    const known = found.get(item.id);
                    if (known) {
                        known.basedOn.push(id);
                    } else {
                        found.set(item.id, {
                            id: item.id,
                            type: item.type,
                            title: item.title,
                            subtitle: item.subtitle === "" || item.subtitle === null ? null : item.subtitle,
                            basedOn: [id],
                            imageUrl: nearestImageUrl(item.images),
                        });
                    }
                }
            } catch (e) {
                failed.push({ id, error: toNrkError(e) });
                // no point in hammering NRK when it asks us to slow down
                if (failed[failed.length - 1]?.error.code === "rate_limited") break;
            }
        }
        if (failed.length === asked.length) {
            const first = failed[0];
            if (first) return fail(first.error);
        }
        // more of your ids behind an item means a stronger match; Array.sort is stable, so
        // NRK's own order decides between equals
        const items: RecommendedItem[] = [...found.values()].sort((a, b) => b.basedOn.length - a.basedOn.length);
        return checked(recommendationsValidator, { items, failed });
    };

    /**
     * Several programs at once. Partial success: programs that could not be
     * fetched are listed in `failed`, the rest are returned. Two requests per program.
     *
     * @param input.ids 1-20 program ids.
     * @example
     * const many = await client.getPrograms({ ids: ["MKTF73000514", "FFIL63000263"] });
     */
    getPrograms = async (input: GetProgramsInput): Promise<Result<Programs>> => {
        const parsed = parseInput(getProgramsInput, input);
        if (!parsed.ok) return fail(parsed.error);

        const programs: Program[] = [];
        const failed: Array<{ id: string; error: NrkError }> = [];
        for (const id of parsed.data.ids) {
            const result = await this.getProgram({ id });
            if (result.ok) {
                programs.push(result.data);
            } else {
                failed.push({ id, error: result.error });
                // no point in hammering NRK when it asks us to slow down
                if (result.error.code === "rate_limited") break;
            }
        }
        return checked(programsValidator, { programs, failed });
    };

    // ── Internals ───────────────────────────────────────────────────

    /**
     * The program page has no text; the playback metadata does (one extra request).
     * Programs that are not published yet have no metadata, which gives null.
     * Rate limiting and network problems are not swallowed.
     */
    private getDescription = async (programId: string): Promise<string | null> => {
        try {
            const meta = await this.call(() => this.nrk.getMetadata(programId));
            return meta.description;
        } catch (e) {
            const code = toNrkError(e).code;
            if (code === "rate_limited" || code === "network" || code === "upstream_error") {
                throw e;
            }
            return null;
        }
    };

    /** Spaces requests to NRK at least minIntervalMs apart. */
    private call = async <T>(fn: () => Promise<T>): Promise<T> => {
        const now = Date.now();
        const start = Math.max(now, this.nextRequestAt);
        this.nextRequestAt = start + this.minIntervalMs;
        if (start > now) {
            await sleep(start - now);
        }
        return fn();
    };
}

const toContributor = (c: { name: string; role: string }): Contributor => {
    return { name: c.name, role: c.role };
};

const toEpisode = (e: NrkEpisode, maxContributors: number): Episode => {
    return {
        id: e.prfId,
        title: e.title,
        subtitle: e.subtitle,
        durationSeconds: e.durationInSeconds,
        durationMinutes: toMinutes(e.durationInSeconds),
        episodeNumber: e.episodeNumber,
        availableFrom: e.availableFromDate,
        availableTo: e.availableToDate,
        status: e.availabilityStatus,
        productionYear: e.productionYear,
        firstAired: e.firstAired,
        contributors: e.contributors.slice(0, maxContributors).map(toContributor),
        imageUrl: nearestImageUrl(e.images),
    };
};

/** Dates are compared as calendar days (the date part NRK sends, Oslo time). */
const isAvailableOn = (e: NrkEpisode, day: string): boolean => {
    if (e.availabilityStatus === "notAvailableOnline") return false;
    if (e.availableFromDate !== null && e.availableFromDate.slice(0, 10) > day) return false;
    if (e.availableToDate !== null && e.availableToDate.slice(0, 10) < day) return false;
    return true;
};

const toEpisodes = (
    season: SeasonsWithEpisodes,
    availableOn: string | undefined,
    maxContributors: number,
): Episodes => {
    const matching = availableOn
        ? season.episodes.filter((e) => isAvailableOn(e, availableOn))
        : season.episodes;
    return {
        seriesId: season.seriesId,
        seasonName: season.seasonName,
        seasonType: season.seasonType,
        episodes: matching.map((e) => toEpisode(e, maxContributors)),
    };
};
