/**
 * Public API of the package. Everything not exported here is internal and can change freely.
 *
 * The only runtime export is NrkClient. The rest are the types it accepts and returns, and
 * they disappear at runtime.
 */
export { NrkClient } from "./nrk-client";

export type {
    AvailabilityStatus,
    Catalog,
    CatalogItem,
    Contributor,
    Episode,
    SeasonEpisodes,
    NrkError,
    NrkErrorCode,
    Program,
    Playback,
    ProgramsResult,
    Result,
    Season,
    Series,
    SubtitleTrack,
    GetEpisodesInput,
    GetProgramsInput,
    GetSeriesInput,
    ListCatalogInput,
} from "./types";
