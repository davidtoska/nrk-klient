import * as v from "./validate";

// What the NRK client returns. Each type is followed by its validator: a function typed
// `Validator<TheType>`, so the compiler makes it agree with the interface. The client
// runs every result through it before returning, so a caller never gets a value that
// does not match the declared type. The validators carry the internal tag and are stripped
// from the published declarations.

export type AvailabilityStatus = "coming" | "available" | "expires" | "expired" | "notAvailableOnline";
/** @internal */
export const AVAILABILITY_STATUSES = v.allOf<AvailabilityStatus>({
    coming: true,
    available: true,
    expires: true,
    expired: true,
    notAvailableOnline: true,
});

export type SeriesType = "sequential" | "news" | "standard";
/** @internal */
export const SERIES_TYPES = v.allOf<SeriesType>({ sequential: true, news: true, standard: true });

export type SeasonType = "latest" | "extramaterial" | "season";
/** @internal */
export const SEASON_TYPES = v.allOf<SeasonType>({ latest: true, extramaterial: true, season: true });

/** @internal */
export const isoDate = v.stringOf({ pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: "expected YYYY-MM-DD" });

export interface WebImage {
    url: string;
    width: number;
}
/** @internal */
export const webImage: v.Validator<WebImage> = v.object({ url: v.string, width: v.number });

export interface Recommendation {
    readonly id: string;
    readonly type: "program" | "series";
    readonly duration: string;
    readonly name: string;
    readonly brand: string;
    readonly image: WebImage | null;
    readonly title: string;
    readonly subtitle: string | null;
    readonly images: ReadonlyArray<WebImage>;
}
/** @internal */
export const recommendation: v.Validator<Recommendation> = v.object({
    id: v.string,
    type: v.oneOf("program", "series"),
    duration: v.string,
    name: v.string,
    brand: v.string,
    image: v.nullable(webImage),
    title: v.string,
    subtitle: v.nullable(v.string),
    images: v.array(webImage),
});

export interface ListedContent {
    readonly id: string;
    readonly type: "programme" | "series";
    readonly title: string;
    readonly imageUrl: string;
    readonly hasOnDemandRights: boolean;
    readonly isGeoBlocked: boolean;
    readonly description: string;
}
/** @internal */
export const listedContent: v.Validator<ListedContent> = v.object({
    id: v.nonEmptyString(),
    type: v.oneOf("programme", "series"),
    title: v.string,
    imageUrl: v.string,
    hasOnDemandRights: v.boolean,
    isGeoBlocked: v.boolean,
    description: v.string,
});

export interface Contributor {
    readonly name: string;
    /** As NRK labels it: "Medvirkende", "Programleder", "Artister/Utøvere", ... */
    readonly role: string;
}
/** @internal */
export const contributor: v.Validator<Contributor> = v.object({ name: v.string, role: v.string });

export interface ProgramById {
    readonly id: string;
    readonly title: string;
    readonly subtitle: string | null;
    readonly availabilityStatus: AvailabilityStatus;
    readonly availableFromDate: string | null;
    readonly availableFromDisplayValue: string;
    readonly availableToDate: string | null;
    readonly availableToDisplayValue: string;

    readonly images: ReadonlyArray<WebImage>;
    readonly durationInSeconds: number;
    readonly durationDisplayValue: string;
    readonly category: string;
    readonly productionYear: number | null;
    /** When NRK first broadcast it (YYYY-MM-DD), if known. */
    readonly firstAired: string | null;
    readonly contributors: ReadonlyArray<Contributor>;
    /** Set when the program is an episode of a series. */
    readonly seriesId: string | null;
}
/** @internal */
export const programById: v.Validator<ProgramById> = v.object({
    id: v.nonEmptyString(),
    title: v.string,
    subtitle: v.nullable(v.string),
    availabilityStatus: v.oneOf(...AVAILABILITY_STATUSES),
    availableFromDate: v.nullable(v.string),
    availableFromDisplayValue: v.string,
    availableToDate: v.nullable(v.string),
    availableToDisplayValue: v.string,
    images: v.array(webImage),
    durationInSeconds: v.number,
    durationDisplayValue: v.string,
    category: v.string,
    productionYear: v.nullable(v.number),
    firstAired: v.nullable(isoDate),
    contributors: v.array(contributor),
    seriesId: v.nullable(v.nonEmptyString()),
});

export interface Season {
    /**
     * The season name is used as an ID.
     */
    readonly name: string;
    readonly title: string;
    readonly href: string;
}
/** @internal */
export const season: v.Validator<Season> = v.object({ name: v.string, title: v.string, href: v.string });

export interface SeriesWithSeasons {
    readonly seriesId: string;
    readonly imageUrl300: string;
    readonly title: string;
    readonly seriesType: SeriesType;
    /** NRK's own classification of the series, e.g. { id: "dokumentar", name: "Dokumentar" }. */
    readonly category: { readonly id: string; readonly name: string } | null;
    readonly seasons: ReadonlyArray<Season>;
}
/** @internal */
export const seriesWithSeasons: v.Validator<SeriesWithSeasons> = v.object({
    seriesId: v.nonEmptyString(),
    imageUrl300: v.nonEmptyString(),
    title: v.string,
    seriesType: v.oneOf(...SERIES_TYPES),
    category: v.nullable(v.object({ id: v.string, name: v.string })),
    seasons: v.array(season),
});

export interface Episode {
    readonly episodeId: string;
    readonly prfId: string;
    readonly seriesId: string;
    readonly seasonName: string;
    readonly title: string;
    readonly subtitle: string | null;
    readonly availabilityStatus: AvailabilityStatus;
    readonly availableFromDate: string | null;
    readonly availableFromDisplayValue: string;
    readonly availableToDate: string | null;
    readonly availableToDisplayValue: string;
    readonly images: ReadonlyArray<WebImage>;
    readonly durationInSeconds: number;
    readonly duration: string;
    readonly detailsDisplayValue: string;
    readonly episodeNumber: number | null;
    readonly productionYear: number | null;
    /** When NRK first broadcast it (YYYY-MM-DD), if known. */
    readonly firstAired: string | null;
    readonly contributors: ReadonlyArray<Contributor>;
}
/** @internal */
export const episode: v.Validator<Episode> = v.object({
    episodeId: v.nonEmptyString(),
    prfId: v.nonEmptyString(),
    seriesId: v.nonEmptyString(),
    seasonName: v.string,
    title: v.string,
    subtitle: v.nullable(v.string),
    availabilityStatus: v.oneOf(...AVAILABILITY_STATUSES),
    availableFromDate: v.nullable(v.string),
    availableFromDisplayValue: v.string,
    availableToDate: v.nullable(v.string),
    availableToDisplayValue: v.string,
    images: v.array(webImage),
    durationInSeconds: v.number,
    duration: v.string,
    detailsDisplayValue: v.string,
    episodeNumber: v.nullable(v.number),
    productionYear: v.nullable(v.number),
    firstAired: v.nullable(isoDate),
    contributors: v.array(contributor),
});

export interface SeasonsWithEpisodes {
    readonly seriesId: string;
    readonly seasonName: string;
    readonly seriesType: SeriesType;
    readonly seasonType: SeasonType;
    readonly episodes: ReadonlyArray<Episode>;
}
/** @internal */
export const seasonsWithEpisodes: v.Validator<SeasonsWithEpisodes> = v.object({
    seriesId: v.nonEmptyString(),
    seasonName: v.string,
    seriesType: v.oneOf(...SERIES_TYPES),
    seasonType: v.oneOf(...SEASON_TYPES),
    episodes: v.array(episode),
});

export interface NrkLetterResponse {
    letter: string;
    readonly programs: Array<ListedContent>;
    readonly series: Array<ListedContent>;
}
/** @internal */
export const nrkLetterResponse: v.Validator<NrkLetterResponse> = v.object({
    letter: v.string,
    programs: v.array(listedContent),
    series: v.array(listedContent),
});

export interface RecommendationResponse {
    programs: Array<Recommendation>;
    series: Array<Recommendation>;
}
/** @internal */
export const recommendationResponse: v.Validator<RecommendationResponse> = v.object({
    programs: v.array(recommendation),
    series: v.array(recommendation),
});

export interface Manifest {
    readonly prfId: string;
    readonly playUrl: string;
    readonly format: "HLS" | "MP4";
}
/** @internal */
export const manifest: v.Validator<Manifest> = v.object({
    prfId: v.nonEmptyString(),
    playUrl: v.nonEmptyString(),
    format: v.oneOf("HLS", "MP4"),
});

export interface Metadata {
    readonly playable: boolean;
    readonly prfId: string;
    readonly aspectRatio: "16:9" | "4:3";
    readonly streamingMode: "live" | "onDemand";
    readonly title: string;
    readonly subTitle: string;
    readonly description: string;
    readonly availableTo: string | null;
    readonly availableNow: boolean;
    readonly images: ReadonlyArray<{ url: string; width: number }>;
}
/** @internal */
export const metadata: v.Validator<Metadata> = v.object({
    playable: v.boolean,
    prfId: v.nonEmptyString(),
    aspectRatio: v.oneOf("16:9", "4:3"),
    streamingMode: v.oneOf("live", "onDemand"),
    title: v.string,
    subTitle: v.string,
    description: v.string,
    availableTo: v.nullable(v.string),
    availableNow: v.boolean,
    images: v.array(webImage),
});
