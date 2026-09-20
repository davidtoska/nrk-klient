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

class NrkClientRaw {
    constructor() {}

    /**
     * Will throw
     * @param letter a letter between a-å
     */
    letter(letter: string): Promise<unknown> {
        const url = [BASE, MEDIUM, TV, LETTERS, letter, INDEXELEMENTS].join("/");
        return this.fetchData(url);
    }

    getManifest(prfId: string): Promise<unknown> {
        const url = [BASE, PLAYBACK, MANIFEST, PROGRAM, prfId].join("/");
        return this.fetchData(url);
    }

    getMetadata(prfId: string): Promise<unknown> {
        const url = [BASE, PLAYBACK, METADATA, PROGRAM, prfId].join("/");
        return this.fetchData(url);
    }

    getSeasons(seriesId: string): Promise<unknown> {
        const url = [BASE, TV, CATALOG, SERIES, seriesId].join("/");
        return this.fetchData(url);
    }

    getAllEpisodes(seriesId: string, seasonName: string): Promise<unknown> {
        const url = [BASE, TV, CATALOG, SERIES, seriesId, SEASONS, seasonName].join(
            "/",
        );
        return this.fetchData(url);
    }
    getSeriesType(seriesId: string): Promise<unknown> {
        const url = [BASE, TV, CATALOG, SERIES, seriesId, "type"].join("/");
        return this.fetchData(url);
    }

    getLiveChannels(): Promise<unknown> {
        const url = [BASE, TV, LIVE].join("/");
        return this.fetchData(url);
    }
    getRecommendation(
        contentId: string,
        options: {
            count?: 5 | 10 | 15 | 20 | 25;
            contentGroup?: "adults" | "children";
            age?: number;
        },
    ) {
        const rootUrl = [BASE, TV, RECOMMENDATIONS, contentId].join("/");
        const url = new URL(rootUrl);
        const count = options?.count ?? 10;
        const contentGroup = options?.contentGroup ?? "adults";
        const age = options?.age ?? false;
        if (typeof age === "number") {
            url.searchParams.set("age", String(age));
        }
        url.searchParams.set("maxNumber", String(count));
        url.searchParams.set("contentGroup", contentGroup);
        return this.fetchData(url.toString());
    }

    getProgramById(id: string) {
        const url = [BASE, TV, CATALOG, PROGRAMS, id].join("/");
        return this.fetchData(url);
    }

    getManifestForChannel(channelName: string) {
        const url = [BASE, PLAYBACK, MANIFEST, CHANNEL, channelName].join("/");
        return this.fetchData(url);
    }

    private async fetchData(url: string): Promise<unknown> {
        const rawResponse = await fetch(url);
        const text = await rawResponse.text();
        let body: unknown = text;
        try {
            body = JSON.parse(text);
        } catch {
            // keep the text as body
        }
        if (!rawResponse.ok) {
            const retryAfter = Number(rawResponse.headers.get("retry-after"));
            throw new NrkHttpError(
                rawResponse.status,
                url,
                body,
                Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
            );
        }
        return body;
    }
}

export const nrkClientRaw = new NrkClientRaw();