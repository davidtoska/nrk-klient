import { NRK } from "./client";
import { NrkHttpError } from "./nrk-client-raw";
import { NrkValidationError, Validator, formatIssues, safeParse } from "./validate";
import {
    aiCatalog,
    aiEpisodes,
    aiProgram,
    aiProgramsResult,
    aiSeries,
    getEpisodesInput,
    getProgramsInput,
    getSeriesInput,
    listCatalogInput,
} from "./ai-types";
import type {
    GetEpisodesInput,
    GetProgramsInput,
    GetSeriesInput,
    ListCatalogInput,
    AiCatalogItem,
    AiContributor,
    AiCatalog,
    AiEpisode,
    AiEpisodes,
    AiError,
    AiProgram,
    AiProgramsResult,
    AiResult,
    AiSeries,
} from "./ai-types";
import type { Episode, SeasonsWithEpisodes } from "./nrk-response";

/**
 * The part of NrkClient that AiClient uses.
 * @internal
 */
export type NrkLike = Pick<
    typeof NRK,
    "letter" | "getSeasons" | "getAllEpisodes" | "getProgramById" | "getMetadata"
>;

/**
 * Seams for tests. Not part of the public API: the published declarations only have
 * `new AiClient()`.
 * @internal
 */
export interface AiClientConfig {
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
/** ListedContent.description falls back to this when NRK has none. */
const NO_DESCRIPTION = "No description";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const toMinutes = (seconds: number): number => {
    return Math.round(seconds / 60);
};

/** Converts anything thrown by the NRK client into an AiError. */
export const toAiError = (e: unknown): AiError => {
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
    if (e instanceof TypeError) {
        return { code: "network", message: e.message };
    }
    return { code: "unknown", message: e instanceof Error ? e.message : String(e) };
};

const parseInput = <T>(validator: Validator<T>, input: unknown): AiResult<T> => {
    const parsed = safeParse(validator, input);
    if (parsed.success) {
        return { ok: true, data: parsed.data };
    }
    return {
        ok: false,
        error: { code: "invalid_input", message: formatIssues(parsed.issues, 3) },
    };
};

const ok = <T>(data: T): AiResult<T> => ({ ok: true, data });
const fail = <T>(error: AiError): AiResult<T> => ({ ok: false, error });

/**
 * Every result is checked against its declared type before it is returned. A value that
 * does not match becomes an invalid_response error instead of reaching the caller.
 */
const checked = <T>(validator: Validator<T>, value: T): AiResult<T> => {
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
export class AiClient {
    private readonly nrk: NrkLike;
    private readonly letters: string;
    private readonly minIntervalMs: number;
    private readonly maxContributors: number;

    private nextRequestAt = 0;

    /** @internal */
    constructor(config: AiClientConfig);
    constructor();
    constructor(config: AiClientConfig = {}) {
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
    listCatalog = async (input: ListCatalogInput = {}): Promise<AiResult<AiCatalog>> => {
        const parsed = parseInput(listCatalogInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const letters = [...new Set((parsed.data.letters ?? this.letters).toLowerCase().split(""))];

        const items: AiCatalogItem[] = [];
        const failed: Array<{ letter: string; error: AiError }> = [];
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
                        description: c.description === NO_DESCRIPTION ? "" : c.description,
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
        return checked(aiCatalog, { items, failed });
    };

    // ── Series and episodes ─────────────────────────────────────────

    getSeries = async (input: GetSeriesInput): Promise<AiResult<AiSeries>> => {
        const parsed = parseInput(getSeriesInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { seriesId } = parsed.data;

        try {
            const series = await this.call(() => this.nrk.getSeasons(seriesId));
            return checked(aiSeries, {
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
    getEpisodes = async (input: GetEpisodesInput): Promise<AiResult<AiEpisodes>> => {
        const parsed = parseInput(getEpisodesInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { seriesId, seasonName, availableOn } = parsed.data;

        try {
            const season = await this.call(() => this.nrk.getAllEpisodes(seriesId, seasonName));
            return checked(aiEpisodes, toEpisodes(season, availableOn, this.maxContributors));
        } catch (e) {
            return fail(toAiError(e));
        }
    };

    // ── Programs ────────────────────────────────────────────────────

    getProgram = async (programId: string): Promise<AiResult<AiProgram>> => {
        const parsed = parseInput(getProgramsInput, { programIds: [programId] });
        if (!parsed.ok) return fail(parsed.error);

        try {
            const p = await this.call(() => this.nrk.getProgramById(programId));
            const description = await this.getDescription(programId);
            return checked(aiProgram, {
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
     * Several programs at once. Partial success: programs that could not be
     * fetched are listed in `failed`, the rest are returned.
     */
    getPrograms = async (input: GetProgramsInput): Promise<AiResult<AiProgramsResult>> => {
        const parsed = parseInput(getProgramsInput, input);
        if (!parsed.ok) return fail(parsed.error);

        const programs: AiProgram[] = [];
        const failed: Array<{ id: string; error: AiError }> = [];
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
        return checked(aiProgramsResult, { programs, failed });
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

const toContributor = (c: { name: string; role: string }): AiContributor => {
    return { name: c.name, role: c.role };
};

const toEpisode = (e: Episode, maxContributors: number): AiEpisode => {
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
const isAvailableOn = (e: Episode, day: string): boolean => {
    if (e.availabilityStatus === "notAvailableOnline") return false;
    if (e.availableFromDate !== null && e.availableFromDate.slice(0, 10) > day) return false;
    if (e.availableToDate !== null && e.availableToDate.slice(0, 10) < day) return false;
    return true;
};

const toEpisodes = (
    season: SeasonsWithEpisodes,
    availableOn: string | undefined,
    maxContributors: number,
): AiEpisodes => {
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
