export interface WebImage {
    url: string;
    width: number;
}
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

export interface ListedContent {
    readonly id: string;
    readonly type: "programme" | "series";
    readonly title: string;
    readonly imageUrl: string;
    readonly hasOnDemandRights: boolean;
    readonly isGeoBlocked: boolean;
    readonly description: string;
}

type AvailabilityStatus =
    | "coming"
    | "available"
    | "expires"
    | "expired"
    | "notAvailableOnline";

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
}

export type SeriesType = "sequential" | "news" | "standard";
export type SeasonType = "latest" | "extramaterial" | "season";
export interface Season {
    /**
     * The season name is used as an ID.
     */
    readonly name: string;
    readonly title: string;
    readonly href: string;
}

export interface SeriesWithSeasons {
    readonly seriesId: string;
    readonly imageUrl300: string;
    readonly title: string;
    readonly seriesType: SeriesType;
    readonly seasons: ReadonlyArray<Season>;
}
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
}
export interface SeasonsWithEpisodes {
    readonly seriesId: string;
    readonly seasonName: string;
    readonly seriesType: SeriesType;
    readonly seasonType: SeasonType;
    readonly episodes: ReadonlyArray<Episode>;
}

export interface NrkLetterResponse {
    letter: string;
    readonly programs: Array<ListedContent>;
    readonly series: Array<ListedContent>;
}

export interface RecommendationResponse {
    programs: Array<Recommendation>;
    series: Array<Recommendation>;
}

// const metaDataParser
export interface Manifest {
    // readonly rawJSON: string;
    readonly prfId: string;
    readonly playUrl: string;
    readonly format: "HLS" | "MP4";
}

export interface Metadata {
    // readonly rawJSON: string;
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