import * as v from "./validate";
import { fetchJson } from "./nrk-client-raw";
import { AVAILABILITY_STATUSES, SEASON_TYPES } from "./types";

// The endpoints of psapi.nrk.no that the client uses. Each one fetches an answer and checks
// its shape, so the rest of the code can rely on the fields below. Only the fields the client
// reads are listed; anything else NRK sends is ignored.

const BASE = "https://psapi.nrk.no";

/**
 * Ids come from callers (for an NrkClient: from an agent), so every value that becomes a
 * path segment is encoded. Otherwise "x/../live" or "x?y" would change which endpoint is called.
 */
const segment = encodeURIComponent;

// ── Shared pieces ───────────────────────────────────────────────────

const titles = v.object({ title: v.string, subtitle: v.optional(v.nullable(v.string)) });

// NRK writes a picture list in three shapes; all three are normalized here to { url, width },
// so nothing downstream needs to know which endpoint a picture came from.
// the program page and the episodes list: { url, width }, an empty list is fine (no picture)
const image = v.array(v.object({ url: v.nonEmptyString("ImageUrl can not be empty"), width: v.number }));
// the recommendations: { uri, width }
const recommendationImages = v.map(v.array(v.object({ uri: v.string, width: v.number })), (list) =>
    list.map((item) => ({ url: item.uri, width: item.width })),
);
// letters and search: { imageUrl, pixelWidth }
const webImages = (limits: { min?: number } = {}) =>
    v.map(v.array(v.object({ imageUrl: v.string, pixelWidth: v.number }), limits), (list) =>
        list.map((item) => ({ url: item.imageUrl, width: item.pixelWidth })),
    );
// the playback metadata poster and the live channel list: { url, pixelWidth }
const posterImages = v.map(v.array(v.object({ url: v.string, pixelWidth: v.number })), (list) =>
    list.map((item) => ({ url: item.url, width: item.pixelWidth })),
);

const availability = v.object({ status: v.oneOf(...AVAILABILITY_STATUSES) });
const transmissions = v.nullish(v.object({ first: v.nullish(v.object({ displayValue: v.string })) }));
const usageRights = v.object({
    from: v.object({ date: v.nullable(v.string) }),
    to: v.object({ date: v.nullable(v.string) }),
});

// ── One parser per answer ───────────────────────────────────────────

const letterParser = v.array(
    v.object({
        id: v.nonEmptyString("Id can not be empty string."),
        title: v.string,
        image: v.object({ webImages: webImages({ min: 1 }) }),
        type: v.oneOf("programme", "series"),
        isGeoBlocked: v.boolean,
        description: v.nullable(v.string),
        hasOndemandRights: v.boolean,
    }),
);

const seriesBody = v.object({
    image,
    titles,
    category: v.nullish(v.object({ id: v.string, name: v.string })),
});
const seriesLinks = v.object({ seasons: v.array(v.object({ name: v.string, title: v.string })) });
const seriesParser = v.union(
    v.object({ seriesType: v.literal("news"), news: seriesBody, _links: seriesLinks }),
    v.object({ seriesType: v.literal("standard"), standard: seriesBody, _links: seriesLinks }),
    v.object({ seriesType: v.literal("sequential"), sequential: seriesBody, _links: seriesLinks }),
);

const episode = v.object({
    prfId: v.nonEmptyString(),
    image,
    titles,
    durationInSeconds: v.positiveNumber("Duration in seconds has to be positive"),
    availability,
    usageRights,
    productionYear: v.nullish(v.number),
    sequenceNumber: v.nullish(v.number),
    contributors: v.nullish(v.array(v.object({ name: v.string, role: v.string }))),
    transmissions,
    firstTransmissionDateDisplayValue: v.nullish(v.string),
});
const seasonParser = v.object({
    seasonType: v.oneOf(...SEASON_TYPES),
    _embedded: v.object({
        instalments: v.optional(v.array(episode)),
        episodes: v.optional(v.array(episode)),
    }),
});

const recommendationBody = { id: v.string, image: v.object({ webImages: recommendationImages }), titles };
const recommendationsParser = v.object({
    _embedded: v.object({
        recommendations: v.array(
            v.union(
                v.object({ type: v.literal("program"), program: v.object(recommendationBody) }),
                v.object({ type: v.literal("series"), series: v.object(recommendationBody) }),
            ),
        ),
    }),
});

const manifestParser = v.object({
    playability: v.oneOf("playable", "nonPlayable"),
    sourceMedium: v.optional(v.string),
    // why NRK will not play it (expired, not yet published, ...), with a text for the end user
    nonPlayable: v.nullish(v.object({ endUserMessage: v.nullable(v.string) })),
    playable: v.nullable(
        v.object({
            // null for a live channel (it has no fixed length)
            duration: v.nullable(v.nonEmptyString("Duration-string can not be empty.")),
            assets: v.array(
                v.object({
                    url: v.string,
                    // NRK lists HLS, MP4, MP3 and Dash; accept any so one unknown asset cannot
                    // make the whole manifest unreadable
                    format: v.string,
                    mimeType: v.string,
                    encrypted: v.optional(v.boolean),
                }),
                { min: 1 },
            ),
            subtitles: v.optional(
                v.array(
                    v.object({
                        language: v.string,
                        label: v.string,
                        defaultOn: v.optional(v.boolean),
                        webVtt: v.nullish(v.string),
                    }),
                ),
            ),
        }),
    ),
});

const metadataParser = v.object({
    displayAspectRatio: v.nullable(v.oneOf("16:9", "4:3")),
    preplay: v.object({
        titles: v.object({ title: v.string, subtitle: v.string }),
        description: v.string,
        poster: v.object({ images: posterImages }),
    }),
    // the end of the on-demand window, or of a live transmission
    availability: v.object({
        onDemand: v.nullable(v.object({ to: v.nullable(v.string) })),
        live: v.nullish(v.object({ transmissionInterval: v.nullish(v.object({ to: v.nullable(v.string) })) })),
    }),
});

const programParser = v.object({
    programInformation: v.object({ image, titles, availability }),
    _links: v.object({ seriesPage: v.optional(v.object({ href: v.nonEmptyString() })) }),
    contributors: v.nullish(v.array(v.object({ role: v.string, name: v.array(v.string) }))),
    moreInformation: v.object({
        category: v.object({ id: v.string }),
        transmissions,
        duration: v.object({ seconds: v.number }),
        productionYear: v.nullable(v.number),
        usageRights,
    }),
});

const channelParser = v.object({
    id: v.nonEmptyString(),
    // a district channel is a regional opt-out of a national one (e.g. NRK1 Østlandet of NRK1)
    districtChannel: v.nullish(v.object({ parent: v.nonEmptyString() })),
    _embedded: v.object({
        playback: v.object({
            title: v.string,
            description: v.nullable(v.string),
            isGeoBlocked: v.boolean,
            posters: v.array(v.object({ image: v.object({ items: posterImages }) })),
        }),
    }),
});

// One entry per scheduled slot; a slot NRK has nothing to show for ("no-transmission",
// "unspecified-content") has none of the optional fields below.
const scheduleEntry = v.object({
    itemType: v.string,
    programId: v.optional(v.nonEmptyString()),
    seriesId: v.optional(v.nonEmptyString()),
    title: v.optional(v.string),
    description: v.optional(v.string),
    category: v.optional(v.object({ id: v.string })),
    duration: v.optional(v.object({ iso8601: v.string })),
    liveTransmission: v.optional(v.boolean),
    // "ondemand" once it can be streamed; also "live", or absent
    availableAs: v.optional(v.string),
    start: v.object({ planned: v.string }),
    end: v.object({ planned: v.string }),
    posterImages: v.optional(image),
});
const scheduleParser = v.array(
    v.object({
        channelId: v.nonEmptyString(),
        title: v.string,
        transmissionGroups: v.array(v.object({ entries: v.array(scheduleEntry) })),
    }),
);

// NRK's search returns series ("serie"), programs ("program") and episodes ("episode"). A hit
// of any other kind is skipped, so a new kind cannot make the whole search unreadable.
const anything: v.Validator<unknown> = (input) => input;
const searchParser = v.object({ hits: v.array(v.object({ type: v.string, hit: anything })) });
const searchHitParser = v.object({
    id: v.nonEmptyString(),
    title: v.string,
    description: v.nullish(v.string),
    hasRights: v.optional(v.boolean),
    // series hits have none of this
    usageRights: v.nullish(v.object({ isGeoBlocked: v.boolean, hasRightsNow: v.boolean })),
    seriesId: v.nullish(v.string),
    seriesTitle: v.nullish(v.string),
    hideInSearchResults: v.optional(v.boolean),
    image: v.nullish(v.object({ webImages: webImages() })),
});
const SEARCH_KINDS = { serie: "series", program: "program", episode: "episode" } as const;

// ── The endpoints ───────────────────────────────────────────────────

/** Throws NrkHttpError on a non-2xx answer and NrkValidationError on an unexpected shape. */
export const nrkApi = {
    letter: async (letter: string) =>
        v.parse(letterParser, await fetchJson(`${BASE}/medium/tv/letters/${segment(letter)}/indexelements`)),

    manifest: async (prfId: string) =>
        v.parse(manifestParser, await fetchJson(`${BASE}/playback/manifest/program/${segment(prfId)}`)),

    metadata: async (prfId: string) =>
        v.parse(metadataParser, await fetchJson(`${BASE}/playback/metadata/program/${segment(prfId)}`)),

    series: async (seriesId: string) =>
        v.parse(seriesParser, await fetchJson(`${BASE}/tv/catalog/series/${segment(seriesId)}`)),

    season: async (seriesId: string, seasonName: string) =>
        v.parse(
            seasonParser,
            await fetchJson(`${BASE}/tv/catalog/series/${segment(seriesId)}/seasons/${segment(seasonName)}`),
        ),

    program: async (id: string) =>
        v.parse(programParser, await fetchJson(`${BASE}/tv/catalog/programs/${segment(id)}`)),

    channelManifest: async (channelId: string) =>
        v.parse(manifestParser, await fetchJson(`${BASE}/playback/manifest/channel/${segment(channelId)}`)),

    channelMetadata: async (channelId: string) =>
        v.parse(metadataParser, await fetchJson(`${BASE}/playback/metadata/channel/${segment(channelId)}`)),

    /** NRK's live TV channels. */
    channels: async () => v.parse(v.array(channelParser), await fetchJson(`${BASE}/tv/live`)),

    /** The programme guide for one or more channels, for one day. Default date: today. */
    schedule: async (channelIds: readonly string[], date?: string) => {
        const url = new URL(`${BASE}/tv/epg/${channelIds.map(segment).join(",")}`);
        if (date) url.searchParams.set("date", date);
        return v.parse(scheduleParser, await fetchJson(url.toString()));
    },

    /** What NRK recommends for adults who liked `contentId` (a program or a series). */
    recommendations: async (contentId: string, count: 5 | 10 | 15 | 20 | 25) =>
        v.parse(
            recommendationsParser,
            await fetchJson(`${BASE}/tv/recommendations/${segment(contentId)}?maxNumber=${count}&contentGroup=adults`),
        ),

    /** Free-text search (an endpoint that is not in NRK's swagger files). TV only. */
    search: async (query: string, limit: number) => {
        const url = new URL(`${BASE}/search`);
        url.searchParams.set("q", query);
        url.searchParams.set("maxResultsPerPage", String(limit));
        const { hits } = v.parse(searchParser, await fetchJson(url.toString()));
        return hits.flatMap((entry) => {
            const kind = SEARCH_KINDS[entry.type as keyof typeof SEARCH_KINDS];
            if (kind === undefined) return [];
            return [{ kind, hit: v.parse(searchHitParser, entry.hit, "Unexpected search hit") }];
        });
    },
};
