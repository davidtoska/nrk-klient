const BASE = "https://psapi.nrk.no";
const TV = "tv";
const LIVE = "live";
const CHANNEL = "channel";
const CATALOG = "catalog";
const SERIES = "series";
const SEASONS = "seasons";
const PROGRAM = "program";
const PROGRAMS = "programs";
const MANIFEST = "manifest";
const METADATA = "metadata";
const PLAYBACK = "playback";
const RECOMMENDATIONS = "recommendations";
const MEDIUM = "medium";
const LETTERS = "letters";
const INDEXELEMENTS = "indexelements";

/** A request that has not answered within this time fails with a TimeoutError. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Set by the package build; "dev" when running from source. */
declare const __NRK_KLIENT_VERSION__: string | undefined;
const VERSION = typeof __NRK_KLIENT_VERSION__ === "string" ? __NRK_KLIENT_VERSION__ : "dev";
const USER_AGENT = `narko-klient/${VERSION} (+https://github.com/davidtoska/nrk-klient)`;

/**
 * Thrown when psapi.nrk.no answers with a non-2xx status.
 * The body is kept as-is (parsed JSON when possible, otherwise text).
 * retryAfterSeconds is set from the Retry-After header (typically on 429).
 */
export class NrkHttpError extends Error {
    constructor(
        readonly status: number,
        readonly url: string,
        readonly body: unknown,
        readonly retryAfterSeconds: number | null = null,
    ) {
        super(`NRK API responded ${status} for ${url}`);
        this.name = "NrkHttpError";
    }
}

/** Retry-After is either a number of seconds or an HTTP date. */
export const parseRetryAfter = (header: string | null, now = Date.now()): number | null => {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return seconds > 0 ? seconds : null;
    }
    const at = Date.parse(header);
    if (Number.isNaN(at)) return null;
    const wait = Math.ceil((at - now) / 1000);
    return wait > 0 ? wait : null;
};

/**
 * Ids come from callers (for an AiClient: from an agent), so every value that becomes a
 * path segment is encoded. Otherwise "x/../live" or "x?y" would change which endpoint is called.
 */
const segment = encodeURIComponent;

export interface RecommendationOptions {
    count?: 5 | 10 | 15 | 20 | 25;
    contentGroup?: "adults" | "children";
    age?: number;
}

class NrkClientRaw {
    letter = (letter: string): Promise<unknown> => {
        const url = [BASE, MEDIUM, TV, LETTERS, segment(letter), INDEXELEMENTS].join("/");
        return this.fetchData(url);
    };

    getManifest = (prfId: string): Promise<unknown> => {
        const url = [BASE, PLAYBACK, MANIFEST, PROGRAM, segment(prfId)].join("/");
        return this.fetchData(url);
    };

    getMetadata = (prfId: string): Promise<unknown> => {
        const url = [BASE, PLAYBACK, METADATA, PROGRAM, segment(prfId)].join("/");
        return this.fetchData(url);
    };

    getSeasons = (seriesId: string): Promise<unknown> => {
        const url = [BASE, TV, CATALOG, SERIES, segment(seriesId)].join("/");
        return this.fetchData(url);
    };

    getAllEpisodes = (seriesId: string, seasonName: string): Promise<unknown> => {
        const url = [BASE, TV, CATALOG, SERIES, segment(seriesId), SEASONS, segment(seasonName)].join(
            "/",
        );
        return this.fetchData(url);
    };

    getSeriesType = (seriesId: string): Promise<unknown> => {
        const url = [BASE, TV, CATALOG, SERIES, segment(seriesId), "type"].join("/");
        return this.fetchData(url);
    };

    getLiveChannels = (): Promise<unknown> => {
        const url = [BASE, TV, LIVE].join("/");
        return this.fetchData(url);
    };

    getRecommendation = (contentId: string, options: RecommendationOptions = {}): Promise<unknown> => {
        const url = new URL([BASE, TV, RECOMMENDATIONS, segment(contentId)].join("/"));
        if (typeof options.age === "number") {
            url.searchParams.set("age", String(options.age));
        }
        url.searchParams.set("maxNumber", String(options.count ?? 10));
        url.searchParams.set("contentGroup", options.contentGroup ?? "adults");
        return this.fetchData(url.toString());
    };

    getProgramById = (id: string): Promise<unknown> => {
        const url = [BASE, TV, CATALOG, PROGRAMS, segment(id)].join("/");
        return this.fetchData(url);
    };

    getManifestForChannel = (channelName: string): Promise<unknown> => {
        const url = [BASE, PLAYBACK, MANIFEST, CHANNEL, segment(channelName)].join("/");
        return this.fetchData(url);
    };

    private fetchData = async (url: string): Promise<unknown> => {
        const rawResponse = await fetch(url, {
            headers: { accept: "application/json", "user-agent": USER_AGENT },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await rawResponse.text();
        let body: unknown = text;
        try {
            body = JSON.parse(text);
        } catch {
            // keep the text as body
        }
        if (!rawResponse.ok) {
            throw new NrkHttpError(
                rawResponse.status,
                url,
                body,
                parseRetryAfter(rawResponse.headers.get("retry-after")),
            );
        }
        return body;
    };
}

export const nrkClientRaw = new NrkClientRaw();
