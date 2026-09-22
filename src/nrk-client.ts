import { nrkApi } from "./nrk-api";
import { flattenContributors, nearestImageUrl, parseFirstAired, parseIsoDuration, seriesIdFromHref } from "./nrk-format";
import { NrkHttpError } from "./nrk-client-raw";
import { NrkValidationError, Validator, formatIssues, safeParse } from "./validate";
import {
    catalogValidator,
    channelsValidator,
    episodesValidator,
    programValidator,
    playbackValidator,
    recommendationsValidator,
    programsValidator,
    scheduleValidator,
    seriesValidator,
    getChannelInput,
    getEpisodesInput,
    getProgramInput,
    getProgramsInput,
    getRecommendationInput,
    getScheduleInput,
    getSeriesInput,
    listCatalogInput,
    searchInput,
    searchResultsValidator,
} from "./types";
import type {
    GetChannelInput,
    GetEpisodesInput,
    GetProgramInput,
    GetProgramsInput,
    GetRecommendationInput,
    GetScheduleInput,
    GetSeriesInput,
    ListCatalogInput,
    SearchInput,
    SearchResults,
    AvailabilityStatus,
    Channel,
    ContentItem,
    Catalog,
    Episodes,
    NrkError,
    Playback,
    Program,
    Programs,
    RecommendedItem,
    Recommendations,
    Result,
    ScheduleItem,
    Series,
} from "./types";

/**
 * Seams for tests. Not part of the public API: the published declarations only have
 * `new NrkClient()`.
 * @internal
 */
export interface NrkClientConfig {
    letters?: string;
    minIntervalMs?: number;
    maxContributors?: number;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzæøå";
/** Minimum time between two requests to NRK: NRK answers 429 when it is hit hard. */
const MIN_INTERVAL_MS = 250;
/** Most credited people returned per program or episode (p99 is 17). */
const MAX_CONTRIBUTORS = 15;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Node's fetch throws TypeError("fetch failed") with a cause; timeouts throw a TimeoutError. */
const isNetworkFailure = (e: unknown): boolean =>
    (e instanceof TypeError && (e.message === "fetch failed" || "cause" in e)) ||
    (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));

/** Converts anything thrown while talking to NRK into an NrkError. */
const toNrkError = (e: unknown): NrkError => {
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

/** Validates the arguments of a call. Bad arguments become an invalid_input error. */
const parseInput = <T>(validator: Validator<T>, input: unknown): Result<T> => {
    const parsed = safeParse(validator, input);
    return parsed.success
        ? ok(parsed.data)
        : fail({ code: "invalid_input", message: formatIssues(parsed.issues, 3) });
};

/** For methods that take no arguments at all (getChannels). */
const noInput: Validator<undefined> = () => undefined;

/**
 * The shape of every method: check the arguments, do the work, and turn anything thrown
 * into an error result, so that no method ever throws.
 */
const run = async <I, T>(
    inputValidator: Validator<I>,
    input: unknown,
    work: (input: I) => Promise<Result<T>>,
): Promise<Result<T>> => {
    const parsed = parseInput(inputValidator, input);
    if (!parsed.ok) return fail(parsed.error);
    try {
        return await work(parsed.data);
    } catch (e) {
        return fail(toNrkError(e));
    }
};

/**
 * An API against NRK, shaped for an AI agent:
 *
 *  - small, flat results with only the fields needed to pick content and build
 *    a schedule (ids, titles, duration, availability window, credited people),
 *  - methods never throw: they return { ok, data } or { ok: false, error },
 *    with error codes an agent can act on (for instance rate_limited),
 *  - partial results where a call covers several requests (listCatalog, getPrograms,
 *    getRecommendations),
 *  - requests are spaced 250 ms apart, because NRK answers 429 when it is hit hard.
 *
 * It stores nothing. Every call goes to NRK, so keeping a copy of the catalog, searching
 * it, and caching what has been fetched is up to the code that uses this class.
 *
 * Ids: a program or episode id is a "prfId" such as "MKTF73000514"; a series id is a
 * slug such as "dagsrevyen". Catalog items and episodes carry the ids to pass on.
 * Typical flow: listCatalog -> getSeries -> getEpisodes -> getPlayback (or getProgram).
 * search finds content from free text; getRecommendations finds more of what a viewer
 * might like, from ids they liked. getChannels and getSchedule cover NRK's live TV guide;
 * getLivePlayback plays a channel when NRK's stream allows it (most are DRM-protected).
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
    private readonly letters: string;
    private readonly minIntervalMs: number;
    private readonly maxContributors: number;

    private nextRequestAt = 0;

    /** @internal */
    constructor(config: NrkClientConfig);
    constructor();
    constructor(config: NrkClientConfig = {}) {
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
    listCatalog = async (input: ListCatalogInput = {}): Promise<Result<Catalog>> =>
        run(listCatalogInput, input, async ({ letters }) => {
            const items: ContentItem[] = [];
            const failed: Array<{ letter: string; error: NrkError }> = [];
            const seen = new Set<string>();
            for (const letter of new Set((letters ?? this.letters).toLowerCase())) {
                try {
                    const listed = await this.call(() => nrkApi.letter(letter));
                    // programs first, then series, each in NRK's order
                    const ordered = [
                        ...listed.filter((c) => c.type === "programme"),
                        ...listed.filter((c) => c.type === "series"),
                    ];
                    for (const c of ordered) {
                        const type = c.type === "programme" ? "program" : "series";
                        if (seen.has(`${type}:${c.id}`)) continue;
                        seen.add(`${type}:${c.id}`);
                        items.push({
                            id: c.id,
                            type,
                            title: c.title,
                            description: c.description ?? "",
                            availableNow: c.hasOndemandRights,
                            geoBlocked: c.isGeoBlocked,
                            imageUrl: nearestImageUrl(c.image.webImages, 0), // the smallest picture
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
        });

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
    search = async (input: SearchInput): Promise<Result<SearchResults>> =>
        run(searchInput, input, async ({ query, limit }) => {
            const hits = await this.call(() => nrkApi.search(query, limit ?? 20));
            return checked(searchResultsValidator, {
                items: hits
                    .filter(({ hit }) => hit.hideInSearchResults !== true)
                    .map(({ kind, hit }) => ({
                        id: hit.id,
                        type: kind,
                        title: hit.title,
                        description: hit.description ?? "",
                        availableNow: hit.usageRights?.hasRightsNow ?? hit.hasRights ?? false,
                        geoBlocked: hit.usageRights?.isGeoBlocked ?? false,
                        imageUrl: nearestImageUrl(hit.image?.webImages ?? []),
                        // only episodes name their series
                        ...(kind === "episode" && hit.seriesId != null
                            ? {
                                  seriesId: hit.seriesId,
                                  ...(hit.seriesTitle != null ? { seriesTitle: hit.seriesTitle } : {}),
                              }
                            : {}),
                    })),
            });
        });

    // ── Series and episodes ─────────────────────────────────────────

    /**
     * A series with its title, type, category and seasons. Pass a season's `name` to getEpisodes.
     *
     * @param input.id Series id from listCatalog or search (`type: "series"`), for instance `"dagsrevyen"`.
     * @example
     * const series = await client.getSeries({ id: "dagsrevyen" });
     */
    getSeries = async (input: GetSeriesInput): Promise<Result<Series>> =>
        run(getSeriesInput, input, async ({ id }) => {
            const data = await this.call(() => nrkApi.series(id));
            const series =
                data.seriesType === "news" ? data.news : data.seriesType === "standard" ? data.standard : data.sequential;
            return checked(seriesValidator, {
                id,
                title: series.titles.title,
                seriesType: data.seriesType,
                category: series.category ?? null,
                seasons: data._links.seasons,
                imageUrl: nearestImageUrl(series.image, 300),
            });
        });

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
    getEpisodes = async (input: GetEpisodesInput): Promise<Result<Episodes>> =>
        run(getEpisodesInput, input, async ({ seriesId, seasonName, availableOn }) => {
            const season = await this.call(() => nrkApi.season(seriesId, seasonName));
            const all = [...(season._embedded.episodes ?? []), ...(season._embedded.instalments ?? [])];
            return checked(episodesValidator, {
                seriesId,
                seasonName,
                seasonType: season.seasonType,
                episodes: all
                    .filter((e) => !availableOn || isAvailableOn(e, availableOn))
                    .map((e) => ({
                        id: e.prfId,
                        title: e.titles.title,
                        subtitle: e.titles.subtitle ?? null,
                        durationSeconds: e.durationInSeconds,
                        durationMinutes: Math.round(e.durationInSeconds / 60),
                        episodeNumber: e.sequenceNumber ?? null,
                        availableFrom: e.usageRights.from.date,
                        availableTo: e.usageRights.to.date,
                        status: e.availability.status,
                        productionYear: e.productionYear ?? null,
                        firstAired: parseFirstAired(e.transmissions?.first?.displayValue, e.firstTransmissionDateDisplayValue),
                        contributors: (e.contributors ?? []).slice(0, this.maxContributors),
                        imageUrl: nearestImageUrl(e.image),
                    })),
            });
        });

    // ── Programs ────────────────────────────────────────────────────

    /**
     * One program or episode with NRK's description, credited people, duration, availability
     * window, production year and first broadcast date. Two requests.
     *
     * @param input.id Program id, or an episode's `id`, for instance `"MKTF73000514"`.
     * @example
     * const program = await client.getProgram({ id: "MKTF73000514" });
     */
    getProgram = async (input: GetProgramInput): Promise<Result<Program>> =>
        run(getProgramInput, input, async ({ id }) => {
            const page = await this.call(() => nrkApi.program(id));
            const description = await this.getDescription(id);
            const { programInformation: info, moreInformation: more } = page;
            const subtitle = info.titles.subtitle;
            return checked(programValidator, {
                id,
                title: info.titles.title,
                // NRK often repeats the description as the subtitle; that adds only tokens
                subtitle: subtitle && subtitle !== description ? subtitle : null,
                category: more.category.id,
                description,
                durationSeconds: more.duration.seconds,
                durationMinutes: Math.round(more.duration.seconds / 60),
                availableFrom: more.usageRights.from.date,
                availableTo: more.usageRights.to.date,
                status: info.availability.status,
                productionYear: more.productionYear,
                firstAired: parseFirstAired(more.transmissions?.first?.displayValue),
                contributors: flattenContributors(page.contributors).slice(0, this.maxContributors),
                seriesId: seriesIdFromHref(page._links.seriesPage?.href),
                imageUrl: nearestImageUrl(info.image),
            });
        });

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
    getPlayback = async (input: GetProgramInput): Promise<Result<Playback>> =>
        run(getProgramInput, input, async ({ id }) => {
            const [manifest, metadata] = await this.call(() =>
                Promise.all([nrkApi.manifest(id), nrkApi.metadata(id)]),
            );
            return toPlayback(id, manifest, metadata);
        });

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
    getRecommendations = async (input: GetRecommendationInput): Promise<Result<Recommendations>> =>
        run(getRecommendationInput, input, async ({ basedOn, count }) => {
            const asked = [...new Set(basedOn)];
            const found = new Map<string, RecommendedItem>();
            const failed: Array<{ id: string; error: NrkError }> = [];
            for (const id of asked) {
                try {
                    const response = await this.call(() => nrkApi.recommendations(id, count ?? 10));
                    const listed = response._embedded.recommendations;
                    const bodyOf = (r: (typeof listed)[number]) =>
                        r.type === "program" ? { type: r.type, body: r.program } : { type: r.type, body: r.series };
                    // programs first, then series, each in NRK's order
                    const items = [
                        ...listed.filter((r) => r.type === "program"),
                        ...listed.filter((r) => r.type === "series"),
                    ].map(bodyOf);
                    for (const { type, body } of items) {
                        if (asked.includes(body.id)) continue;
                        const known = found.get(body.id);
                        found.set(
                            body.id,
                            known
                                ? { ...known, basedOn: [...known.basedOn, id] }
                                : {
                                      id: body.id,
                                      type,
                                      title: body.titles.title,
                                      subtitle: body.titles.subtitle || null,
                                      basedOn: [id],
                                      imageUrl: nearestImageUrl(body.image.webImages),
                                  },
                        );
                    }
                } catch (e) {
                    const error = toNrkError(e);
                    failed.push({ id, error });
                    // no point in hammering NRK when it asks us to slow down
                    if (error.code === "rate_limited") break;
                }
            }
            const first = failed[0];
            if (first && failed.length === asked.length) return fail(first.error);
            // more of your ids behind an item means a stronger match; Array.sort is stable, so
            // NRK's own order decides between equals
            const items = [...found.values()].sort((a, b) => b.basedOn.length - a.basedOn.length);
            return checked(recommendationsValidator, { items, failed });
        });

    /**
     * Several programs at once. Partial success: programs that could not be
     * fetched are listed in `failed`, the rest are returned. Two requests per program.
     *
     * @param input.ids 1-20 program ids.
     * @example
     * const many = await client.getPrograms({ ids: ["MKTF73000514", "FFIL63000263"] });
     */
    getPrograms = async (input: GetProgramsInput): Promise<Result<Programs>> =>
        run(getProgramsInput, input, async ({ ids }) => {
            const programs: Program[] = [];
            const failed: Array<{ id: string; error: NrkError }> = [];
            for (const id of ids) {
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
        });

    // ── Live TV ───────────────────────────────────────────────────────

    /**
     * NRK's live TV channels: the national ones (NRK1, NRK2, NRK3, NRK Super, NRK Tegnspråk) and
     * NRK1's regional opt-out variants (`parentChannelId` set on those). Pass an id to
     * getSchedule or getLivePlayback.
     *
     * @example
     * const channels = await client.getChannels();
     * if (channels.ok) console.log(channels.data.map((c) => c.title));
     */
    getChannels = async (): Promise<Result<ReadonlyArray<Channel>>> =>
        run(noInput, undefined, async () => {
            const channels = await this.call(() => nrkApi.channels());
            return checked(
                channelsValidator,
                channels.map((c) => ({
                    id: c.id,
                    title: c._embedded.playback.title,
                    description: c._embedded.playback.description ?? "",
                    parentChannelId: c.districtChannel?.parent ?? null,
                    geoBlocked: c._embedded.playback.isGeoBlocked,
                    imageUrl: nearestImageUrl(c._embedded.playback.posters[0]?.image.items ?? []),
                })),
            );
        });

    /**
     * The programme guide for one or more channels, for one day: what is airing, what aired
     * before and what is coming up. Slots NRK has nothing to show for are left out. An item
     * already on demand (`availableNow`) can be played right away with getProgram or getPlayback;
     * a live or upcoming one cannot, until NRK publishes it.
     *
     * @param input.channelIds 1-20 channel ids from getChannels, e.g. `["nrk1", "nrksuper"]`.
     * @param input.date YYYY-MM-DD. Default: today.
     * @example
     * const guide = await client.getSchedule({ channelIds: ["nrk1"] });
     * if (guide.ok) console.log(guide.data.map((i) => `${i.start} ${i.title}`));
     */
    getSchedule = async (input: GetScheduleInput): Promise<Result<ReadonlyArray<ScheduleItem>>> =>
        run(getScheduleInput, input, async ({ channelIds, date }) => {
            const channels = await this.call(() => nrkApi.schedule(channelIds, date));
            const items = channels.flatMap((channel) =>
                channel.transmissionGroups.flatMap((group) =>
                    group.entries.flatMap((entry) => {
                        if ((entry.itemType !== "episode" && entry.itemType !== "program") || !entry.programId) {
                            return [];
                        }
                        return [
                            {
                                id: entry.programId,
                                channelId: channel.channelId,
                                channelTitle: channel.title,
                                title: entry.title ?? "",
                                seriesId: entry.seriesId ?? null,
                                description: entry.description ?? "",
                                category: entry.category?.id ?? "",
                                durationSeconds: entry.duration ? (parseIsoDuration(entry.duration.iso8601) ?? 0) : 0,
                                start: entry.start.planned,
                                end: entry.end.planned,
                                isLive: entry.liveTransmission ?? false,
                                availableNow: entry.availableAs === "ondemand",
                                imageUrl: nearestImageUrl(entry.posterImages ?? []),
                            },
                        ];
                    }),
                ),
            );
            return checked(scheduleValidator, items);
        });

    /**
     * What a player needs to play one live TV channel - the same shape as getPlayback. Most of
     * NRK's live streams are DRM-protected (a plain HLS player cannot use them), so this usually
     * gives a `not_playable` result; use getChannels and getSchedule for the guide regardless.
     *
     * @param input.id Channel id from getChannels, for instance `"nrk1"`.
     * @example
     * const live = await client.getLivePlayback({ id: "nrk1" });
     */
    getLivePlayback = async (input: GetChannelInput): Promise<Result<Playback>> =>
        run(getChannelInput, input, async ({ id }) => {
            const [manifest, metadata] = await this.call(() =>
                Promise.all([nrkApi.channelManifest(id), nrkApi.channelMetadata(id)]),
            );
            return toPlayback(id, manifest, metadata);
        });

    // ── Internals ───────────────────────────────────────────────────

    /**
     * The program page has no text; the playback metadata does (one extra request).
     * Programs that are not published yet have no metadata, which gives null.
     * Rate limiting and network problems are not swallowed.
     */
    private getDescription = async (programId: string): Promise<string | null> => {
        try {
            const meta = await this.call(() => nrkApi.metadata(programId));
            return meta.preplay.description;
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

type ParsedManifest = Awaited<ReturnType<typeof nrkApi.manifest>>;
type ParsedMetadata = Awaited<ReturnType<typeof nrkApi.metadata>>;

/**
 * getPlayback and getLivePlayback both resolve to a manifest/metadata pair (a program's or a
 * channel's - the shapes are the same) and turn it into what a player needs, or why it cannot
 * play right now.
 */
const toPlayback = (id: string, manifest: ParsedManifest, metadata: ParsedMetadata): Result<Playback> => {
    const notPlayable = (message: string): Result<Playback> => fail({ code: "not_playable", message });
    const { playable } = manifest;
    if (manifest.playability !== "playable" || !playable) {
        return notPlayable(manifest.nonPlayable?.endUserMessage ?? "Not available for playback.");
    }
    const hls = playable.assets.find((asset) => asset.format === "HLS");
    if (!hls) return notPlayable("NRK offers no HLS stream for this program.");
    if (hls.encrypted === true) {
        return notPlayable("The stream is DRM-protected and cannot be played by a plain HLS player.");
    }
    const { preplay, availability } = metadata;
    return checked(playbackValidator, {
        id,
        title: preplay.titles.title,
        subtitle: preplay.titles.subtitle === "" ? null : preplay.titles.subtitle,
        streamUrl: hls.url,
        mimeType: hls.mimeType,
        mediaType: manifest.sourceMedium === "audio" ? "audio" : "video",
        durationSeconds: playable.duration === null ? null : parseIsoDuration(playable.duration),
        aspectRatio: metadata.displayAspectRatio,
        posterUrl: nearestImageUrl(preplay.poster.images, 960),
        subtitles: (playable.subtitles ?? []).flatMap((track) =>
            track.webVtt
                ? [{ language: track.language, label: track.label, url: track.webVtt, defaultOn: track.defaultOn ?? false }]
                : [],
        ),
        availableTo: availability.onDemand?.to ?? availability.live?.transmissionInterval?.to ?? null,
    });
};

/** Dates are compared as calendar days (the date part NRK sends, Oslo time). */
const isAvailableOn = (
    e: { availability: { status: AvailabilityStatus }; usageRights: { from: { date: string | null }; to: { date: string | null } } },
    day: string,
): boolean => {
    if (e.availability.status === "notAvailableOnline") return false;
    const { from, to } = e.usageRights;
    if (from.date !== null && from.date.slice(0, 10) > day) return false;
    if (to.date !== null && to.date.slice(0, 10) < day) return false;
    return true;
};
