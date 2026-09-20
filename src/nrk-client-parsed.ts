import * as z from "zod";
import { nrkClientRaw } from "./nrk-client-raw";

export const productionYear = z.number().nullish();
export const duration = z.string().min(1, "Duration-string can not be empty.");
export const durationInSeconds = z
    .number()
    .positive("Duration in seconds has to be positive");

// Zod - ATOMS
export const seriesType = z.union([
    z.literal("sequential"),
    z.literal("news"),
    z.literal("standard"),
]);

export const seasonType = z.union([
    z.literal("latest"),
    z.literal("extramaterial"),
    z.literal("season"),
]);

const titles = z.object({
    title: z.string(),
    subtitle: z.string().nullable().optional(),
});

const webImages = z
    .array(z.object({ uri: z.string(), width: z.number() }))
    .nonempty("Image-array should not be empty")
    .transform((list) =>
        list.map((item) => ({ url: item.uri, width: item.width })),
    );

const UpstreamSystemInfoParser = z.object({
    payload: z.object({
        id: z.string(),
        name: z.string().min(1),
        brand: z.string().nonempty(),
    }),
});

const image = z.array(
    z.object({
        url: z.string().nonempty("ImageUrl can not be empty"),
        width: z.number(),
    }),
);
const availability = z.object({
    status: z.union([
        z.literal("coming"),
        z.literal("available"),
        z.literal("notAvailableOnline"),
        z.literal("expires"),
        z.literal("expired"),
    ]),
});

const transmissions = z
    .object({ first: z.object({ displayValue: z.string() }).nullish() })
    .nullish();
const details = z.object({ displayValue: z.string().nonempty() });
const category = z.object({ id: z.string() });

const usageRights = z.object({
    from: z.object({
        date: z.string().nullable(),
        displayValue: z.string(),
    }),
    to: z.object({ date: z.string().nullable(), displayValue: z.string() }),
});
export const SeriesTypeResponse = z.object({ seriesType });

const NrkLetterItem = z.object({
    id: z.string().nonempty("Id can not be empty string."),
    title: z.string(),
    sortLetter: z.string().min(1),
    image: z.object({
        webImages: z
            .array(z.object({ imageUrl: z.string(), pixelWidth: z.number() }))
            .nonempty(),
    }),
    type: z.union([z.literal("programme"), z.literal("series")]),
    isGeoBlocked: z.boolean(),
    description: z.string().nullable(),
    hasOndemandRights: z.boolean(),
});

const seriesCategory = z.object({ id: z.string(), name: z.string() }).nullish();

const _links = z.object({
    seasons: z.array(
        z.object({ href: z.string(), name: z.string(), title: z.string() }),
    ),
});
const GetSeriesWithSeasonsParser = z.union([
    z.object({
        seriesType: z.literal("news"),
        news: z.object({ image, titles, category: seriesCategory }),
        _links,
    }),
    z.object({
        seriesType: z.literal("standard"),
        standard: z.object({ image, titles, category: seriesCategory }),
        _links,
    }),
    z.object({
        seriesType: z.literal("sequential"),
        sequential: z.object({ image, titles, category: seriesCategory }),
        _links,
    }),
]);
const href = z.string().nonempty().brand("HREF");
export const channelName = z
    .string()
    .nonempty("Channel name can not be empty")
    .brand("NRK_CHANNEL_NAME.");

const SeriesRecommendationParser = z.object({
    type: z.literal("series"),
    upstreamSystemInfo: UpstreamSystemInfoParser,
    series: z.object({
        id: z.string(),
        image: z.object({ webImages }),
        titles,
    }),
});

const ProgramRecommendationParser = z.object({
    type: z.literal("program"),
    upstreamSystemInfo: UpstreamSystemInfoParser,
    program: z.object({
        duration: z.string(),
        id: z.string(),
        image: z.object({ webImages }),
        titles,
    }),
});
const RecommendationSchema = z.object({
    _embedded: z.object({
        recommendations: z.array(
            z.union([ProgramRecommendationParser, SeriesRecommendationParser]),
        ),
    }),
});

const EmbeddedOrInstalledEpisode = z.object({
    id: z.string().min(1),
    prfId: z.string().min(1),
    image,
    titles,
    details,
    duration,
    durationInSeconds,
    availability,
    usageRights,
    productionYear,
    sequenceNumber: z.number().nullish(),
    contributors: z.array(z.object({ name: z.string(), role: z.string() })).nullish(),
    transmissions,
    firstTransmissionDateDisplayValue: z.string().nullish(),
});
const GetEpisodesParser = z.object({
    seriesType,
    seasonType,
    _embedded: z.object({
        instalments: z.array(EmbeddedOrInstalledEpisode).optional(),
        episodes: z.array(EmbeddedOrInstalledEpisode).optional(),
    }),
});

const manifestParser = z.object({
    playability: z.union([z.literal("playable"), z.literal("nonPlayable")]),
    playable: z
        .object({
            duration,
            assets: z
                .array(
                    z.object({
                        url: z.string(),
                        format: z.union([z.literal("HLS"), z.literal("MP4")]),
                        mimeType: z.literal("application/vnd.apple.mpegurl"),
                    }),
                )
                .nonempty(),
        })
        .nullable(),
});

const metaDataParser = z.object({
    playability: z.union([z.literal("playable"), z.literal("nonPlayable")]),

    streamingMode: z.union([z.literal("live"), z.literal("onDemand")]),
    displayAspectRatio: z.union([z.literal("16:9"), z.literal("4:3")]),
    preplay: z.object({
        titles: z.object({ title: z.string(), subtitle: z.string() }),
        description: z.string(),
        poster: z.object({
            images: z.array(z.object({ url: z.string(), pixelWidth: z.number() })),
        }),
        indexPoints: z.array(
            z.object({
                startPoint: z.string().describe("ISO8601-duration"),
                title: z.string(),
            }),
        ),
    }),
    duration: z.string(),
    availability: z.object({
        onDemand: z
            .object({
                from: z.string().nullable(),
                hasRightsNow: z.boolean(),
                to: z.string().nullable(),
            })
            .nullable(),
    }),
});
class NrkClientParsed {
    letter = async (letter: string) => {
        const result = await nrkClientRaw.letter(letter);
        return z.array(NrkLetterItem).parse(result);
    };

    getManifest = async (prfId: string) => {
        const json = await nrkClientRaw.getManifest(prfId);
        return manifestParser.parse(json);
    };
    getMetadata = async (prfId: string) => {
        const json = await nrkClientRaw.getMetadata(prfId);
        return metaDataParser.parse(json);
    };

    getSeasons = async (seriesId: string) => {
        const json = await nrkClientRaw.getSeasons(seriesId);
        return GetSeriesWithSeasonsParser.parse(json);
    };

    getAllEpisodes = async (seriesId: string, seasonName: string) => {
        const json = await nrkClientRaw.getAllEpisodes(seriesId, seasonName);
        return GetEpisodesParser.parse(json);
    };
    getSeriesType = async (seriesId: string) => {
        const data = await nrkClientRaw.getSeriesType(seriesId);
        const parsedResult = SeriesTypeResponse.parse(data);
        return parsedResult.seriesType;
    };
    getRecommendation = async (
        contentId: string,
        options: {
            count?: 5 | 10 | 15 | 20 | 25;
            contentGroup?: "adults" | "children";
            age?: number;
        },
    ) => {
        const count = options?.count ?? 25;
        const contentGroup = options?.contentGroup ?? "adults";

        const body = await nrkClientRaw.getRecommendation(contentId, {
            contentGroup,
            count,
            ...(options?.age !== undefined && { age: options.age }),
        });
        return RecommendationSchema.parse(body);
    };

    getProgramById = async (id: string) => {
        const json = await nrkClientRaw.getProgramById(id);
        const schema = z.object({
            programInformation: z.object({
                image,
                titles,
                availability,
            }),
            _links: z.object({
                seriesPage: z
                    .object({ name: z.string(), title: z.string(), href })
                    .optional(),
                season: z
                    .object({ name: z.string().min(1), title: z.string(), href })
                    .optional(),
            }),
            contributors: z
                .array(z.object({ role: z.string(), name: z.array(z.string()) }))
                .nullish(),
            moreInformation: z.object({
                category,
                transmissions,
                duration: z.object({
                    seconds: z.number(),
                    displayValue: z.string(),
                }),
                releaseDateOnDemand: z.string().nullable(),
                productionYear: z.number().nullable(),
                usageRights,
            }),
        });
        return schema.parse(json);
    };
    getLiveChannels = async () => {
        const json = await nrkClientRaw.getLiveChannels();
        const schema = z.array(
            z.object({
                id: channelName,
                _embedded: z.object({
                    playback: z.object({
                        title: z.string(),
                        posters: z.array(
                            z.object({
                                image: z.object({
                                    ratio: z.union([
                                        z.literal("16:9"),
                                        z.literal("1:1"),
                                        z.literal("2:3"),
                                    ]),
                                    items: z.array(
                                        z.object({
                                            url: z.string().url(),
                                            pixelWidth: z.number().positive(),
                                        }),
                                    ),
                                }),
                            }),
                        ),
                    }),
                }),
            }),
        );

        return schema.parse(json);
    };
}
export const nrkClientParsed = new NrkClientParsed();