import { NRK } from "./client";
import { NrkHttpError } from "./nrk-client-raw";
import { NrkValidationError, Validator, formatIssues, safeParse } from "./validate";
import {
    catalogValidator,
    seasonEpisodesValidator,
    programValidator,
    playbackValidator,
    programsResultValidator,
    seriesValidator,
    getEpisodesInput,
    getProgramsInput,
    getSeriesInput,
    listCatalogInput,
} from "./types";
import type {
    GetEpisodesInput,
    GetProgramsInput,
    GetSeriesInput,
    ListCatalogInput,
    CatalogItem,
    Contributor,
    Catalog,
    Episode,
    SeasonEpisodes,
    NrkError,
    Playback,
    Program,
    ProgramsResult,
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
    "letter" | "getSeasons" | "getAllEpisodes" | "getProgramById" | "getMetadata" | "getPlayback"
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
export const toAiError = (e: unknown): NrkError => {
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
     * 30 requests and roughly 12,000 items). NRK has no search endpoint, so this listing is
     * what an index is built from. Letters that could not be fetched are reported in
     * `failed` and the rest are returned; the call stops early on rate limiting.
     */
    listCatalog = async (input: ListCatalogInput = {}): Promise<Result<Catalog>> => {
        const parsed = parseInput(listCatalogInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const letters = [...new Set((parsed.data.letters ?? this.letters).toLowerCase().split(""))];

        const items: CatalogItem[] = [];
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
                    });
                }
            } catch (e) {
                const error = toAiError(e);
                failed.push({ letter, error });
                // no point in hammering NRK when it asks us to slow down
                if (error.code === "rate_limited") break;
            }
        }
        return checked(catalogValidator, { items, failed });
    };

    // ── Series and episodes ─────────────────────────────────────────

    getSeries = async (input: GetSeriesInput): Promise<Result<Series>> => {
        const parsed = parseInput(getSeriesInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { seriesId } = parsed.data;

        try {
            const series = await this.call(() => this.nrk.getSeasons(seriesId));
            return checked(seriesValidator, {
                id: series.seriesId,
                title: series.title,
                seriesType: series.seriesType,
                category: series.category,
                seasons: series.seasons.map((s) => ({ name: s.name, title: s.title })),
            });
        } catch (e) {
            return fail(toAiError(e));
        }
    };

    /** All episodes of one season (NRK returns a season in one response). */
    getEpisodes = async (input: GetEpisodesInput): Promise<Result<SeasonEpisodes>> => {
        const parsed = parseInput(getEpisodesInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { seriesId, seasonName, availableOn } = parsed.data;

        try {
            const season = await this.call(() => this.nrk.getAllEpisodes(seriesId, seasonName));
            return checked(seasonEpisodesValidator, toEpisodes(season, availableOn, this.maxContributors));
        } catch (e) {
            return fail(toAiError(e));
        }
    };

    // ── Programs ────────────────────────────────────────────────────

    getProgram = async (programId: string): Promise<Result<Program>> => {
        const parsed = parseInput(getProgramsInput, { programIds: [programId] });
        if (!parsed.ok) return fail(parsed.error);

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
            });
        } catch (e) {
            return fail(toAiError(e));
        }
    };

    /**
     * What a player needs to play one episode or program (pass an episode's `id`): the HLS
     * stream, subtitles, poster, duration and title. Hand the data to the player as it is.
     * A program NRK will not stream now (expired, not published yet) gives `not_playable`,
     * with NRK's text for the end user as the message.
     */
    getPlayback = async (programId: string): Promise<Result<Playback>> => {
        const parsed = parseInput(getProgramsInput, { programIds: [programId] });
        if (!parsed.ok) return fail(parsed.error);

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
            return fail(toAiError(e));
        }
    };

    /**
     * Several programs at once. Partial success: programs that could not be
     * fetched are listed in `failed`, the rest are returned.
     */
    getPrograms = async (input: GetProgramsInput): Promise<Result<ProgramsResult>> => {
        const parsed = parseInput(getProgramsInput, input);
        if (!parsed.ok) return fail(parsed.error);

        const programs: Program[] = [];
        const failed: Array<{ id: string; error: NrkError }> = [];
        for (const id of parsed.data.programIds) {
            const result = await this.getProgram(id);
            if (result.ok) {
                programs.push(result.data);
            } else {
                failed.push({ id, error: result.error });
                // no point in hammering NRK when it asks us to slow down
                if (result.error.code === "rate_limited") break;
            }
        }
        return checked(programsResultValidator, { programs, failed });
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
            const code = toAiError(e).code;
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
): SeasonEpisodes => {
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
