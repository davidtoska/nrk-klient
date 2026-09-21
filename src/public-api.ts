/**
 * Public API of the package. Everything not exported here is internal and can change freely.
 *
 * The only runtime export is NrkClient. The rest are the types its methods return, and they
 * disappear at runtime. What the methods accept is documented on the methods themselves.
 */
export { NrkClient } from "./nrk-client";

export type {
    AvailabilityStatus,
    Catalog,
    ContentItem,
    Contributor,
    Episode,
    Episodes,
    NrkError,
    NrkErrorCode,
    Program,
    Playback,
    Programs,
    RecommendedItem,
    Recommendations,
    Result,
    SearchResults,
    Season,
    Series,
    SubtitleTrack,
} from "./types";
