import * as z from "zod";
import { NRK } from "./client";
import { NrkHttpError } from "./nrk-client-raw";
import {
    getEpisodesInput,
    getProgramsInput,
    getSeriesInput,
    searchCatalogInput,
} from "./ai-schemas";
import type {
    GetEpisodesInput,
    GetProgramsInput,
    GetSeriesInput,
    SearchCatalogInput,
    AiCatalogItem,
    AiContributor,
    AiCatalogPage,
    AiEpisode,
    AiEpisodesPage,
    AiError,
    AiProgram,
    AiProgramsResult,
    AiResult,
    AiSeries,
} from "./ai-types";
import type { Episode, SeasonsWithEpisodes } from "./nrk-response";

/** The part of NrkClient that AiClient uses. Lets tests inject a fake. */
export type NrkLike = Pick<
    typeof NRK,
    "letter" | "getSeasons" | "getAllEpisodes" | "getProgramById" | "getMetadata"
>;

export interface AiClientOptions {
    readonly nrk?: NrkLike;
    /** Letters that make up the catalog index. Default: a-z, æ, ø, å. */
    readonly letters?: string;
    /** Minimum time between two requests to NRK. Default 250 ms. */
    readonly minIntervalMs?: number;
    /** How long series/season/program lookups are cached. Default 10 min. */
    readonly cacheTtlMs?: number;
    /** How long the catalog index is kept before it is reloaded. Default 6 h. */
    readonly catalogTtlMs?: number;
    /** Max credited people returned per program/episode. Default 15 (p99 is 17). */
    readonly maxContributors?: number;
    /** Clock, for tests. */
    readonly now?: () => number;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzæøå";
/** ListedContent.description falls back to this when NRK has none. */
const NO_DESCRIPTION = "No description";

interface IndexEntry {
    readonly item: AiCatalogItem;
    readonly title: string; // lower-case
    readonly description: string; // lower-case
}

interface Catalog {
    readonly entries: ReadonlyArray<IndexEntry>;
    readonly loadedAt: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const truncate = (text: string, max: number): string => {
    return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
};

const tokenize = (query: string | undefined): string[] => {
    if (!query) return [];
    const terms = query
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter((t) => t.length >= 2);
    return [...new Set(terms)];
};

const toMinutes = (seconds: number): number => {
    return Math.round(seconds / 60);
};

const describeIssues = (error: z.ZodError): string => {
    return error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; ");
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
    if (e instanceof z.ZodError) {
        return {
            code: "invalid_response",
            message: "NRK returned an unexpected response shape: " + describeIssues(e),
        };
    }
    if (e instanceof TypeError) {
        return { code: "network", message: e.message };
    }
    return { code: "unknown", message: e instanceof Error ? e.message : String(e) };
};

const parseInput = <S extends z.ZodType>(schema: S, input: unknown): AiResult<z.output<S>> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) {
        return { ok: true, data: parsed.data };
    }
    return {
        ok: false,
        error: { code: "invalid_input", message: describeIssues(parsed.error) },
    };
};

const ok = <T>(data: T): AiResult<T> => ({ ok: true, data });
const fail = <T>(error: AiError): AiResult<T> => ({ ok: false, error });

/**
 * A wrapper around the NRK client that is shaped for an AI agent:
 *
 *  - small, flat results with only the fields needed to pick content and build
 *    a schedule (ids, titles, duration, availability window),
 *  - keyword search over the whole archive (NRK has no search endpoint, so the
 *    letter index is loaded once and searched in memory),
 *  - paging with total/hasMore so the agent knows what it did not see,
 *  - methods never throw: they return { ok, data } or { ok: false, error },
 *    with error codes an agent can act on (for instance rate_limited),
 *  - requests are spaced out and lookups cached, because NRK answers 429 when
 *    it is hit hard.
 */
export class AiClient {
    private readonly nrk: NrkLike;
    private readonly letters: string;
    private readonly minIntervalMs: number;
    private readonly cacheTtlMs: number;
    private readonly catalogTtlMs: number;
    private readonly maxContributors: number;
    private readonly now: () => number;

    private nextRequestAt = 0;
    private catalog: Catalog | null = null;
    private catalogLoading: Promise<AiResult<Catalog>> | null = null;
    private readonly cache = new Map<string, { at: number; value: unknown }>();

    constructor(options: AiClientOptions = {}) {
        this.nrk = options.nrk ?? NRK;
        this.letters = options.letters ?? ALPHABET;
        this.minIntervalMs = options.minIntervalMs ?? 250;
        this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000;
        this.catalogTtlMs = options.catalogTtlMs ?? 6 * 60 * 60 * 1000;
        this.maxContributors = options.maxContributors ?? 15;
        this.now = options.now ?? Date.now;
    }

    // ── Catalog ─────────────────────────────────────────────────────

    /**
     * Keyword search over the archive (programs and series).
     * The first call loads the index (about 30 requests), later calls are instant.
     */
    searchCatalog = async (input: SearchCatalogInput = {}): Promise<AiResult<AiCatalogPage>> => {
        const parsed = parseInput(searchCatalogInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const q = parsed.data;

        const catalog = await this.getCatalog();
        if (!catalog.ok) return fail(catalog.error);

        const terms = tokenize(q.query);
        const scored: Array<{ entry: IndexEntry; score: number }> = [];
        for (const entry of catalog.data.entries) {
            const { item } = entry;
            if (q.type !== "any" && item.type !== q.type) continue;
            if (q.onDemandOnly && !item.availableNow) continue;
            if (!q.includeGeoBlocked && item.geoBlocked) continue;

            let score = 0;
            let matched = 0;
            for (const term of terms) {
                const inTitle = entry.title.includes(term);
                const inDescription = entry.description.includes(term);
                if (inTitle || inDescription) matched++;
                if (inTitle) score += 3;
                if (inDescription) score += 1;
            }
            if (terms.length > 0) {
                if (q.matchAll ? matched < terms.length : matched === 0) continue;
            }
            scored.push({ entry, score });
        }

        scored.sort(
            (a, b) =>
                b.score - a.score || a.entry.item.title.localeCompare(b.entry.item.title, "nb"),
        );
        const max = q.descriptionMaxChars;
        const items = scored
            .slice(q.offset, q.offset + q.limit)
            .map(({ entry }) =>
                max === undefined
                    ? entry.item
                    : { ...entry.item, description: truncate(entry.item.description, max) },
            );
        return ok({
            items,
            total: scored.length,
            offset: q.offset,
            hasMore: q.offset + items.length < scored.length,
            catalogSize: catalog.data.entries.length,
        });
    };

    /** Drops the cached index so the next search reloads it. */
    refreshCatalog = (): void => {
        this.catalog = null;
    };

    // ── Series and episodes ─────────────────────────────────────────

    getSeries = async (input: GetSeriesInput): Promise<AiResult<AiSeries>> => {
        const parsed = parseInput(getSeriesInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { seriesId } = parsed.data;

        try {
            const series = await this.memo(`series:${seriesId}`, () =>
                this.call(() => this.nrk.getSeasons(seriesId)),
            );
            return ok({
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

    getEpisodes = async (input: GetEpisodesInput): Promise<AiResult<AiEpisodesPage>> => {
        const parsed = parseInput(getEpisodesInput, input);
        if (!parsed.ok) return fail(parsed.error);
        const { seriesId, seasonName, availableOn, limit, offset } = parsed.data;

        try {
            const season = await this.memo(`season:${seriesId}/${seasonName}`, () =>
                this.call(() => this.nrk.getAllEpisodes(seriesId, seasonName)),
            );
            return ok(toEpisodesPage(season, availableOn, limit, offset, this.maxContributors));
        } catch (e) {
            return fail(toAiError(e));
        }
    };

    // ── Programs ────────────────────────────────────────────────────

    getProgram = async (programId: string): Promise<AiResult<AiProgram>> => {
        const parsed = parseInput(getProgramsInput, { programIds: [programId] });
        if (!parsed.ok) return fail(parsed.error);

        try {
            const p = await this.memo(`program:${programId}`, () =>
                this.call(() => this.nrk.getProgramById(programId)),
            );
            const description = await this.getDescription(programId);
            return ok({
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
        return ok({ programs, failed });
    };

    // ── Internals ───────────────────────────────────────────────────

    private getCatalog = async (): Promise<AiResult<Catalog>> => {
        if (this.catalog && this.now() - this.catalog.loadedAt < this.catalogTtlMs) {
            return ok(this.catalog);
        }
        // concurrent searches share one load
        this.catalogLoading ??= this.loadCatalog().finally(() => {
            this.catalogLoading = null;
        });
        return this.catalogLoading;
    };

    private loadCatalog = async (): Promise<AiResult<Catalog>> => {
        try {
            const responses = await Promise.all(
                this.letters.split("").map((l) => this.call(() => this.nrk.letter(l))),
            );
            const seen = new Set<string>();
            const entries: IndexEntry[] = [];
            for (const response of responses) {
                const listed = [
                    ...response.programs.map((c) => ({ c, type: "program" as const })),
                    ...response.series.map((c) => ({ c, type: "series" as const })),
                ];
                for (const { c, type } of listed) {
                    const key = `${type}:${c.id}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const description = c.description === NO_DESCRIPTION ? "" : c.description;
                    entries.push({
                        item: {
                            id: c.id,
                            type,
                            title: c.title,
                            description,
                            availableNow: c.hasOnDemandRights,
                            geoBlocked: c.isGeoBlocked,
                        },
                        title: c.title.toLowerCase(),
                        description: description.toLowerCase(),
                    });
                }
            }
            this.catalog = { entries, loadedAt: this.now() };
            return ok(this.catalog);
        } catch (e) {
            return fail(toAiError(e));
        }
    };

    /**
     * The program page has no text; the playback metadata does (one extra request).
     * Programs that are not published yet have no metadata, which gives null.
     * Rate limiting and network problems are not swallowed.
     */
    private getDescription = async (programId: string): Promise<string | null> => {
        try {
            const meta = await this.memo(`meta:${programId}`, () =>
                this.call(() => this.nrk.getMetadata(programId)),
            );
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

    private memo = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
        const hit = this.cache.get(key);
        if (hit && this.now() - hit.at < this.cacheTtlMs) {
            return hit.value as T;
        }
        const value = await fn();
        this.cache.set(key, { at: this.now(), value });
        return value;
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

const toEpisodesPage = (
    season: SeasonsWithEpisodes,
    availableOn: string | undefined,
    limit: number,
    offset: number,
    maxContributors: number,
): AiEpisodesPage => {
    const matching = availableOn
        ? season.episodes.filter((e) => isAvailableOn(e, availableOn))
        : season.episodes;
    const episodes = matching.slice(offset, offset + limit).map((e) => toEpisode(e, maxContributors));
    return {
        seriesId: season.seriesId,
        seasonName: season.seasonName,
        seasonType: season.seasonType,
        total: matching.length,
        offset,
        hasMore: offset + episodes.length < matching.length,
        episodes,
    };
};
