import * as fs from "node:fs";
import * as path from "node:path";

/** test/fixtures — resolved from dist/test/support at runtime. */
export const FIXTURES_DIR = path.resolve(__dirname, "../../../test/fixtures");
export const RAW_DIR = path.join(FIXTURES_DIR, "raw");

export interface RecordedResponse {
    readonly status: number;
    /** Parsed body when the response was JSON. */
    readonly json?: unknown;
    /** Raw body when the response was not JSON. */
    readonly text?: string;
}

/** A stable, filesystem-safe file name for a request URL. */
export function fileNameForUrl(url: string): string {
    const withoutHost = url.replace(/^https?:\/\/[^/]+\//, "");
    const safe = withoutHost
        .replace(/[/?&=]/g, "__")
        .replace(/[^a-zA-Z0-9._-]/g, (c) => "~" + c.charCodeAt(0).toString(16));
    return safe + ".json";
}

export function readRecorded(url: string): RecordedResponse | null {
    const file = path.join(RAW_DIR, fileNameForUrl(url));
    if (!fs.existsSync(file)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(file, "utf8")) as RecordedResponse;
}

export function writeRecorded(url: string, response: RecordedResponse): void {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(
        path.join(RAW_DIR, fileNameForUrl(url)),
        JSON.stringify(response),
    );
}

export interface IdEntry {
    readonly id: string;
    readonly title: string;
}
export interface FilmEntry extends IdEntry {
    readonly durationInSeconds: number;
}
export interface SeriesEntry extends IdEntry {
    readonly seriesType: "standard" | "sequential" | "news";
}
export interface IdsFile {
    readonly generatedAt: string;
    readonly programs: {
        readonly available: ReadonlyArray<IdEntry>;
        readonly films: ReadonlyArray<FilmEntry>;
        readonly geoblocked: ReadonlyArray<IdEntry>;
        readonly unavailable: ReadonlyArray<IdEntry>;
    };
    readonly series: {
        readonly standard: ReadonlyArray<SeriesEntry>;
        readonly sequential: ReadonlyArray<SeriesEntry>;
        readonly news: ReadonlyArray<SeriesEntry>;
    };
    /** Picks used by the offline tests, by role. */
    readonly curated: Readonly<Record<string, string>>;
}

export function readIds(): IdsFile {
    return JSON.parse(
        fs.readFileSync(path.join(FIXTURES_DIR, "ids.json"), "utf8"),
    ) as IdsFile;
}
