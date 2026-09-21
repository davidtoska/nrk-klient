/**
 * Public API of the package. Everything not exported here is internal and can change freely.
 *
 * Runtime exports are deliberately few:
 *  - NRK          the client for psapi.nrk.no
 *  - AiClient     a client shaped for AI agents (compact results, keyword search, never throws)
 *  - NrkHttpError what NRK throws on a non-2xx response (AiClient never throws it)
 *
 * Everything else is a type and disappears at runtime.
 */
export { NRK } from "./client";
export { AiClient } from "./ai-client";
export { NrkHttpError } from "./nrk-client-raw";

// NRK client
export type {
    Contributor,
    Episode,
    ListedContent,
    Manifest,
    Metadata,
    NrkLetterResponse,
    ProgramById,
    Recommendation,
    RecommendationResponse,
    Season,
    SeasonsWithEpisodes,
    SeasonType,
    SeriesType,
    SeriesWithSeasons,
    WebImage,
} from "./nrk-response";

// AiClient
export type {
    AiAvailabilityStatus,
    AiCatalogItem,
    AiCatalogPage,
    AiContributor,
    AiEpisode,
    AiEpisodesPage,
    AiError,
    AiErrorCode,
    AiProgram,
    AiProgramsResult,
    AiResult,
    AiSeason,
    AiSeries,
    GetEpisodesInput,
    GetProgramsInput,
    GetSeriesInput,
    SearchCatalogInput,
} from "./ai-types";
