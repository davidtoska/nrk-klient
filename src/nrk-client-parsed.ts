import * as v from "./validate";
import { nrkClientRaw, RecommendationOptions } from "./nrk-client-raw";
import { AVAILABILITY_STATUSES, SEASON_TYPES, SERIES_TYPES } from "./nrk-response";

export const productionYear = v.nullish(v.number);
export const duration = v.nonEmptyString("Duration-string can not be empty.");
export const durationInSeconds = v.positiveNumber("Duration in seconds has to be positive");

// Atoms
export const seriesType = v.oneOf(...SERIES_TYPES);

export const seasonType = v.oneOf(...SEASON_TYPES);

const titles = v.object({
    title: v.string,
    subtitle: v.optional(v.nullable(v.string)),
});

const webImages = v.map(
    v.array(v.object({ uri: v.string, width: v.number }), {
        min: 1,
        message: "Image-array should not be empty",
    }),
    (list) => list.map((item) => ({ url: item.uri, width: item.width })),
);

const UpstreamSystemInfoParser = v.object({
    payload: v.object({
        id: v.string,
        name: v.nonEmptyString(),
        brand: v.nonEmptyString(),
    }),
});

const image = v.array(
    v.object({
        url: v.nonEmptyString("ImageUrl can not be empty"),
        width: v.number,
    }),
);
const availability = v.object({
    status: v.oneOf(...AVAILABILITY_STATUSES),
});

const transmissions = v.nullish(v.object({ first: v.nullish(v.object({ displayValue: v.string })) }));
const details = v.object({ displayValue: v.nonEmptyString() });
const category = v.object({ id: v.string });

const usageRights = v.object({
    from: v.object({
        date: v.nullable(v.string),
        displayValue: v.string,
    }),
    to: v.object({ date: v.nullable(v.string), displayValue: v.string }),
});
export const SeriesTypeResponse = v.object({ seriesType });

const NrkLetterItem = v.object({
    id: v.nonEmptyString("Id can not be empty string."),
    title: v.string,
    sortLetter: v.nonEmptyString(),
    image: v.object({
        webImages: v.array(v.object({ imageUrl: v.string, pixelWidth: v.number }), { min: 1 }),
    }),
    type: v.oneOf("programme", "series"),
    isGeoBlocked: v.boolean,
    description: v.nullable(v.string),
    hasOndemandRights: v.boolean,
});

const seriesCategory = v.nullish(v.object({ id: v.string, name: v.string }));

const _links = v.object({
    seasons: v.array(v.object({ href: v.string, name: v.string, title: v.string })),
});
const GetSeriesWithSeasonsParser = v.union(
    v.object({
        seriesType: v.literal("news"),
        news: v.object({ image, titles, category: seriesCategory }),
        _links,
    }),
    v.object({
        seriesType: v.literal("standard"),
        standard: v.object({ image, titles, category: seriesCategory }),
        _links,
    }),
    v.object({
        seriesType: v.literal("sequential"),
        sequential: v.object({ image, titles, category: seriesCategory }),
        _links,
    }),
);
const href = v.nonEmptyString();
export const channelName = v.nonEmptyString("Channel name can not be empty");

const SeriesRecommendationParser = v.object({
    type: v.literal("series"),
    upstreamSystemInfo: UpstreamSystemInfoParser,
    series: v.object({
        id: v.string,
        image: v.object({ webImages }),
        titles,
    }),
});

const ProgramRecommendationParser = v.object({
    type: v.literal("program"),
    upstreamSystemInfo: UpstreamSystemInfoParser,
    program: v.object({
        duration: v.string,
        id: v.string,
        image: v.object({ webImages }),
        titles,
    }),
});
const RecommendationSchema = v.object({
    _embedded: v.object({
        recommendations: v.array(v.union(ProgramRecommendationParser, SeriesRecommendationParser)),
    }),
});

const EmbeddedOrInstalledEpisode = v.object({
    id: v.nonEmptyString(),
    prfId: v.nonEmptyString(),
    image,
    titles,
    details,
    duration,
    durationInSeconds,
    availability,
    usageRights,
    productionYear,
    sequenceNumber: v.nullish(v.number),
    contributors: v.nullish(v.array(v.object({ name: v.string, role: v.string }))),
    transmissions,
    firstTransmissionDateDisplayValue: v.nullish(v.string),
});
const GetEpisodesParser = v.object({
    seriesType,
    seasonType,
    _embedded: v.object({
        instalments: v.optional(v.array(EmbeddedOrInstalledEpisode)),
        episodes: v.optional(v.array(EmbeddedOrInstalledEpisode)),
    }),
});

const manifestParser = v.object({
    playability: v.oneOf("playable", "nonPlayable"),
    sourceMedium: v.optional(v.string),
    // why NRK will not play it (expired, not yet published, ...), with a text for the end user
    nonPlayable: v.nullish(
        v.object({
            messageType: v.string,
            endUserMessage: v.nullable(v.string),
        }),
    ),
    playable: v.nullable(
        v.object({
            duration,
            assets: v.array(
                v.object({
                    url: v.string,
                    // NRK's spec lists HLS, MP4, MP3 and Dash; accept anything so one unknown asset
                    // cannot make the whole manifest unreadable
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

const metaDataParser = v.object({
    playability: v.oneOf("playable", "nonPlayable"),

    streamingMode: v.oneOf("live", "onDemand"),
    displayAspectRatio: v.nullable(v.oneOf("16:9", "4:3")),
    preplay: v.object({
        titles: v.object({ title: v.string, subtitle: v.string }),
        description: v.string,
        poster: v.object({
            images: v.array(v.object({ url: v.string, pixelWidth: v.number })),
        }),
        indexPoints: v.array(
            v.object({
                startPoint: v.string, // ISO8601 duration
                title: v.string,
            }),
        ),
    }),
    duration: v.string,
    availability: v.object({
        onDemand: v.nullable(
            v.object({
                from: v.nullable(v.string),
                hasRightsNow: v.boolean,
                to: v.nullable(v.string),
            }),
        ),
        live: v.nullish(
            v.object({
                isOngoing: v.optional(v.boolean),
                transmissionInterval: v.optional(
                    v.object({ from: v.nullable(v.string), to: v.nullable(v.string) }),
                ),
            }),
        ),
    }),
});

const programPageParser = v.object({
    programInformation: v.object({
        image,
        titles,
        availability,
    }),
    _links: v.object({
        seriesPage: v.optional(v.object({ name: v.string, title: v.string, href })),
        season: v.optional(v.object({ name: v.nonEmptyString(), title: v.string, href })),
    }),
    contributors: v.nullish(v.array(v.object({ role: v.string, name: v.array(v.string) }))),
    moreInformation: v.object({
        category,
        transmissions,
        duration: v.object({
            seconds: v.number,
            displayValue: v.string,
        }),
        releaseDateOnDemand: v.nullable(v.string),
        productionYear: v.nullable(v.number),
        usageRights,
    }),
});

// NRK's search returns series ("serie"), programs ("program") and episodes ("episode"). A hit
// of any other kind is skipped, so a new kind cannot make the whole search unreadable.
const anything: v.Validator<unknown> = (input) => input;
const searchParser = v.object({
    hits: v.array(v.object({ type: v.string, hit: anything })),
});
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
});
const SEARCH_KINDS = { serie: "series", program: "program", episode: "episode" } as const;

const liveChannelsParser = v.array(
    v.object({
        id: channelName,
        _embedded: v.object({
            playback: v.object({
                title: v.string,
                posters: v.array(
                    v.object({
                        image: v.object({
                            ratio: v.oneOf("16:9", "1:1", "2:3"),
                            items: v.array(
                                v.object({
                                    url: v.url,
                                    pixelWidth: v.positiveNumber(),
                                }),
                            ),
                        }),
                    }),
                ),
            }),
        }),
    }),
);

class NrkClientParsed {
    letter = async (letter: string) => {
        const result = await nrkClientRaw.letter(letter);
        return v.parse(v.array(NrkLetterItem), result);
    };

    getManifest = async (prfId: string) => {
        const json = await nrkClientRaw.getManifest(prfId);
        return v.parse(manifestParser, json);
    };
    getMetadata = async (prfId: string) => {
        const json = await nrkClientRaw.getMetadata(prfId);
        return v.parse(metaDataParser, json);
    };

    getSeasons = async (seriesId: string) => {
        const json = await nrkClientRaw.getSeasons(seriesId);
        return v.parse(GetSeriesWithSeasonsParser, json);
    };

    getAllEpisodes = async (seriesId: string, seasonName: string) => {
        const json = await nrkClientRaw.getAllEpisodes(seriesId, seasonName);
        return v.parse(GetEpisodesParser, json);
    };
    getSeriesType = async (seriesId: string) => {
        const data = await nrkClientRaw.getSeriesType(seriesId);
        const parsedResult = v.parse(SeriesTypeResponse, data);
        return parsedResult.seriesType;
    };
    getRecommendation = async (contentId: string, options: RecommendationOptions = {}) => {
        const body = await nrkClientRaw.getRecommendation(contentId, {
            contentGroup: options.contentGroup ?? "adults",
            count: options.count ?? 25,
            ...(options.age !== undefined && { age: options.age }),
        });
        return v.parse(RecommendationSchema, body);
    };

    search = async (query: string, limit: number) => {
        const body = await nrkClientRaw.search(query, limit);
        const { hits } = v.parse(searchParser, body);
        return hits.flatMap((entry) => {
            const kind = SEARCH_KINDS[entry.type as keyof typeof SEARCH_KINDS];
            if (kind === undefined) return [];
            return [{ kind, hit: v.parse(searchHitParser, entry.hit, "Unexpected search hit") }];
        });
    };

    getProgramById = async (id: string) => {
        const json = await nrkClientRaw.getProgramById(id);
        return v.parse(programPageParser, json);
    };
    getLiveChannels = async () => {
        const json = await nrkClientRaw.getLiveChannels();
        return v.parse(liveChannelsParser, json);
    };
}
export const nrkClientParsed = new NrkClientParsed();
