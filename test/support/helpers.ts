import { readIds, readRecorded } from "./fixtures";

export const BASE = "https://psapi.nrk.no";

export const urls = {
    programPage: (id: string) => `${BASE}/tv/catalog/programs/${id}`,
    manifest: (id: string) => `${BASE}/playback/manifest/program/${id}`,
    metadata: (id: string) => `${BASE}/playback/metadata/program/${id}`,
    series: (id: string) => `${BASE}/tv/catalog/series/${id}`,
    season: (id: string, season: string) =>
        `${BASE}/tv/catalog/series/${id}/seasons/${season}`,
    letter: (letter: string) =>
        `${BASE}/medium/tv/letters/${letter}/indexelements`,
};

/** The recorded JSON body for a URL. Fails if it was not recorded as JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const recordedJson = (url: string): any => {
    const recorded = readRecorded(url);
    if (!recorded || recorded.json === undefined) {
        throw new Error(
            "No recorded JSON for " + url + " (run `npm run record`)",
        );
    }
    return recorded.json;
};

/** A hand-picked id used by the offline tests, by role. */
export const curated = (role: string): string => {
    const id = readIds().curated[role];
    if (!id) {
        throw new Error(
            `Fixture role "${role}" is missing from ids.json. ` +
                "Run `npm run record` to regenerate fixtures.",
        );
    }
    return id;
};

export const first = <T>(list: ReadonlyArray<T>, what = "list"): T => {
    const item = list[0];
    if (item === undefined) {
        throw new Error(`Expected ${what} to have at least one item`);
    }
    return item;
};

export const isHttpUrl = (s: string) => /^https?:\/\/\S+$/.test(s);
