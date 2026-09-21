import {
    Episode,
    ListedContent,
    Manifest,
    Metadata,
    NrkLetterResponse,
    ProgramById,
    Recommendation,
    RecommendationResponse,
    SeasonsWithEpisodes,
    SeriesType,
    SeriesWithSeasons,
} from "./nrk-response";
import * as r from "./nrk-response";
import { nrkClientParsed, seriesType as seriesTypeValidator } from "./nrk-client-parsed";
import { flattenContributors, parseFirstAired, seriesIdFromHref } from "./nrk-format";
import * as v from "./validate";

/**
 * Every public method runs its result through the validator for its declared type before
 * returning it, so a caller never receives a value that contradicts the signature.
 */
const checked = <T>(method: string, validator: v.Validator<T>, value: T): T =>
    v.parse(validator, value, `Invalid result from NRK.${method}`);

class NrkClient {
    /**
     * Will throw
     * @param letter a letter between a-å
     */
    letter = async (letter: string): Promise<NrkLetterResponse> => {
        const parsed = await nrkClientParsed.letter(letter);
        const responseObject: NrkLetterResponse = {
            letter,
            programs: [],
            series: [],
        };
        parsed.forEach((item) => {
            const images = item.image.webImages.sort(
                (a, b) => a.pixelWidth - b.pixelWidth,
            );
            const firstImage = images[0];
            if (!firstImage) {
                throw new Error("Missing image for content: " + item.id);
            }
            const contentItem: ListedContent = {
                id: item.id,
                description: item.description ? item.description : "No description",
                hasOnDemandRights: item.hasOndemandRights,
                imageUrl: firstImage.imageUrl,
                isGeoBlocked: item.isGeoBlocked,
                title: item.title,
                type: item.type,
            };
            if (item.type === "programme") {
                responseObject.programs.push(contentItem);
            } else if (item.type === "series") {
                responseObject.series.push(contentItem);
            } else {
                console.error("UNKNOWN CONTENT TYPE: " + item.type);
            }
        });

        return checked("letter", r.nrkLetterResponse, responseObject);
    };

    getManifest = async (prfId: string): Promise<Manifest> => {
        const parsed = await nrkClientParsed.getManifest(prfId);
        const playable = parsed.playable;
        if (!playable) {
            throw new Error("Missing playable key in manifest. ");
        }
        const hls = playable.assets.find((item) => item.format === "HLS");
        if (!hls) {
            throw new Error("Missing HLS ENDPOINT in manifest.");
        }

        const manifest: Manifest = {
            format: hls.format,
            playUrl: hls.url,
            prfId,
            // rawJSON: JSON.stringify(json),
        };

        return checked("getManifest", r.manifest, manifest);
    };
    getMetadata = async (prfId: string): Promise<Metadata> => {
        const parsed = await nrkClientParsed.getMetadata(prfId);
        const availabilityOnDemand = parsed.availability.onDemand;
        if (!availabilityOnDemand) {
            throw new Error("Missing availability on this program: " + prfId);
        }
        const metaData: Metadata = {
            aspectRatio: parsed.displayAspectRatio,
            images: parsed.preplay.poster.images.map((img) => ({
                url: img.url,
                width: img.pixelWidth,
            })),
            availableNow: availabilityOnDemand.hasRightsNow,
            availableTo: availabilityOnDemand.to,
            description: parsed.preplay.description,
            playable: parsed.playability === "playable",
            prfId,
            // rawJSON: JSON.stringify(json),
            streamingMode: parsed.streamingMode,
            subTitle: parsed.preplay.titles.subtitle,
            title: parsed.preplay.titles.title,
        };
        return checked("getMetadata", r.metadata, metaData);
    };

    getSeasons = async (seriesId: string) => {
        const data = await nrkClientParsed.getSeasons(seriesId);
        const inner =
            data.seriesType === "news"
                ? data.news
                : data.seriesType === "standard"
                  ? data.standard
                  : data.sequential;
        const images = inner.image;
        const title = inner.titles.title;
        const category = inner.category ?? null;
        const pickImage = (array: Array<{ url: string; width: number }>) => {
            const first = array[0];
            if (!first) {
                throw Error("Missing image at index 0");
            }
            if (first.width !== 300) {
                console.log(first);
                throw new Error("Width of image is not 300 px");
            }
            const url = first.url;
            return { url };
        };
        const smallImage = pickImage(images);
        const seriesWithSeasons: SeriesWithSeasons = {
            imageUrl300: smallImage.url,
            title,
            seriesId,
            seriesType: data.seriesType,
            category,
            seasons: data._links.seasons,
        };
        return checked("getSeasons", r.seriesWithSeasons, seriesWithSeasons);
    };

    getAllEpisodes = async (
        seriesId: string,
        seasonName: string,
    ): Promise<SeasonsWithEpisodes> => {
        const parsed = await nrkClientParsed.getAllEpisodes(seriesId, seasonName);
        const toEpisode = (
            e: NonNullable<typeof parsed._embedded.episodes>[number],
        ): Episode => ({
            episodeId: e.id,
            prfId: e.prfId,
            detailsDisplayValue: e.details.displayValue,
            availabilityStatus: e.availability.status,
            availableFromDate: e.usageRights.from.date,
            availableFromDisplayValue: e.usageRights.from.displayValue,
            availableToDate: e.usageRights.to.date,
            availableToDisplayValue: e.usageRights.to.displayValue,
            duration: e.duration,
            durationInSeconds: e.durationInSeconds,
            images: e.image,
            productionYear: e.productionYear ?? null,
            firstAired: parseFirstAired(
                e.transmissions?.first?.displayValue,
                e.firstTransmissionDateDisplayValue,
            ),
            contributors: (e.contributors ?? []).map((p) => ({
                name: p.name,
                role: p.role,
            })),
            episodeNumber: e.sequenceNumber ?? null,
            subtitle: e.titles.subtitle ?? null,
            title: e.titles.title,
            seriesId,
            seasonName,
        });
        const episodes: Episode[] = [
            ...(parsed._embedded.episodes ?? []).map(toEpisode),
            ...(parsed._embedded.instalments ?? []).map(toEpisode),
        ];

        const returnValue: SeasonsWithEpisodes = {
            seriesId,
            seasonName,
            seasonType: parsed.seasonType,
            seriesType: parsed.seriesType,
            episodes,
        };

        return checked("getAllEpisodes", r.seasonsWithEpisodes, returnValue);
    };
    getSeriesType = async (seriesId: string): Promise<SeriesType> => {
        const seriesType = await nrkClientParsed.getSeriesType(seriesId);

        return checked("getSeriesType", seriesTypeValidator, seriesType);
    };
    getRecommendation = async (
        contentId: string,
        options: {
            count?: 5 | 10 | 15 | 20 | 25;
            contentGroup?: "adults" | "children";
            age?: number;
        },
    ) => {
        const parerResult = await nrkClientParsed.getRecommendation(
            contentId,
            options,
        );
        const result: RecommendationResponse = {
            programs: [],
            series: [],
        };
        const list = parerResult._embedded.recommendations;
        list.forEach((item) => {
            const brand = item.upstreamSystemInfo.payload.brand;
            const name = item.upstreamSystemInfo.payload.name;
            if (item.type === "program") {
                const imagesSorted = item.program.image.webImages.sort(
                    (a, b) => a.width - b.width,
                );
                const subtitle = item.program.titles.subtitle
                    ? item.program.titles.subtitle
                    : "";
                const image = imagesSorted[0] ?? null;
                const mapped: Recommendation = {
                    type: item.type,
                    id: item.program.id,
                    brand,
                    duration: item.program.duration,
                    name,
                    image,
                    images: imagesSorted,
                    title: item.program.titles.title,
                    subtitle,
                };
                result.programs.push(mapped);
            }
            if (item.type === "series") {
                const imagesSorted = item.series.image.webImages.sort(
                    (a, b) => a.width - b.width,
                );
                const image = imagesSorted[0] ?? null;
                const subtitle = item.series.titles.subtitle
                    ? item.series.titles.subtitle
                    : "";
                const mappedSeries: Recommendation = {
                    type: item.type,
                    id: item.series.id,
                    duration: "",
                    brand,
                    name,
                    image,
                    images: imagesSorted,
                    title: item.series.titles.title,
                    subtitle,
                };
                result.series.push(mappedSeries);
            }
        });

        return checked("getRecommendation", r.recommendationResponse, result);
    };

    /**
     * Will throw
     */
    getAllLetters = async (): Promise<NrkLetterResponse> => {
        const legalLetters = "abcdefghijklmnopqrstuvwxyzæøå";
        const all = legalLetters.split("").map(this.letter);
        const resolvedAll = await Promise.all(all);
        const flattend = resolvedAll.flat(1);
        const allLetterResponsees: NrkLetterResponse = {
            letter: "",
            programs: [],
            series: [],
        };

        flattend.forEach((letterResult) => {
            allLetterResponsees.letter =
                allLetterResponsees.letter + letterResult.letter;
            allLetterResponsees.programs.push(...letterResult.programs);
            allLetterResponsees.series.push(...letterResult.series);
        });
        return checked("getAllLetters", r.nrkLetterResponse, allLetterResponsees);
    };

    prfIdGetAll = async (prfId: string) => {
        const programByIdPromise = this.getProgramById(prfId);
        const manifestPromise = this.getManifest(prfId);
        const metadataPromise = this.getMetadata(prfId);
        const all = await Promise.all([
            manifestPromise,
            metadataPromise,
            programByIdPromise,
        ]);
        const [manifest, metadata, programById] = all;
        return { manifest, metadata, programById };
    };

    getProgramById = async (id: string) => {
        const parsed = await nrkClientParsed.getProgramById(id);

        // FLATTEND
        const subtitle = parsed.programInformation.titles.subtitle;
        const imageList = parsed.programInformation.image;
        const durationDisplayValue = parsed.moreInformation.duration.displayValue;
        const durationInSeconds = parsed.moreInformation.duration.seconds;
        const category = parsed.moreInformation.category.id;
        const productionYear = parsed.moreInformation.productionYear;
        const availableFromDate = parsed.moreInformation.usageRights.from.date;
        const availableFromDisplayValue =
            parsed.moreInformation.usageRights.from.displayValue;
        const availableToDate = parsed.moreInformation.usageRights.to.date;
        const availableToDisplayValue =
            parsed.moreInformation.usageRights.to.displayValue;
        const availabilityStatus = parsed.programInformation.availability.status;

        const returnType: ProgramById = {
            id,
            availabilityStatus,
            title: parsed.programInformation.titles.title,
            subtitle: subtitle ? subtitle : "",
            images: imageList,
            durationDisplayValue,
            durationInSeconds,
            category,
            productionYear,
            firstAired: parseFirstAired(
                parsed.moreInformation.transmissions?.first?.displayValue,
            ),
            contributors: flattenContributors(parsed.contributors),
            seriesId: seriesIdFromHref(parsed._links.seriesPage?.href),
            availableFromDate,
            availableFromDisplayValue,
            availableToDate,
            availableToDisplayValue,
        };
        return checked("getProgramById", r.programById, returnType);
    };
}

export const NRK = new NrkClient();