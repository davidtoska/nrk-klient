/**
 * Public API of the package. Everything not exported here is internal and can change freely.
 *
 * The only runtime export is NrkClient. The rest are the types it accepts and returns, and
 * they disappear at runtime.
 */
export { NrkClient } from "./ai-client";

export type {
    AiAvailabilityStatus,
    AiCatalog,
    AiCatalogItem,
    AiContributor,
    AiEpisode,
    AiEpisodes,
    AiError,
    AiErrorCode,
    AiProgram,
    AiPlayback,
    AiProgramsResult,
    AiResult,
    AiSeason,
    AiSeries,
    AiSubtitleTrack,
    GetEpisodesInput,
    GetProgramsInput,
    GetSeriesInput,
    ListCatalogInput,
} from "./ai-types";
