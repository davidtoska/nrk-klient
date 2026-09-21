import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiClient, NrkLike } from "../../src/ai-client";
import { NRK } from "../../src/client";
import * as r from "../../src/nrk-response";
import { NrkValidationError, safeParse } from "../../src/validate";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { curated, recordedJson, urls } from "../support/helpers";

/**
 * Both clients check what they return against the declared type. These tests feed the
 * AiClient a fake NRK that produces values contradicting the types, and check that the
 * caller gets an error instead of a wrong value.
 */

const validProgram = {
    id: "ABCD12345678",
    title: "Title",
    subtitle: null,
    availabilityStatus: "available",
    availableFromDate: null,
    availableFromDisplayValue: "",
    availableToDate: null,
    availableToDisplayValue: "",
    images: [],
    durationInSeconds: 1800,
    durationDisplayValue: "30 min",
    category: "natur",
    productionYear: 2000,
    firstAired: "2000-01-31",
    contributors: [],
    seriesId: null,
};

const validEpisode = {
    episodeId: "e1",
    prfId: "ABCD12345678",
    seriesId: "s",
    seasonName: "1",
    title: "Ep",
    subtitle: null,
    availabilityStatus: "available",
    availableFromDate: null,
    availableFromDisplayValue: "",
    availableToDate: null,
    availableToDisplayValue: "",
    images: [],
    durationInSeconds: 600,
    duration: "PT10M",
    detailsDisplayValue: "",
    episodeNumber: 1,
    productionYear: null,
    firstAired: null,
    contributors: [],
};

const clientWith = (fake: object) => new AiClient({ nrk: fake as unknown as NrkLike, minIntervalMs: 0 });

const programFake = (override: object = {}) => ({
    getProgramById: async () => ({ ...validProgram, ...override }),
    getMetadata: async () => ({ description: "A description" }),
});

const rejected = async (result: Promise<{ ok: boolean; error?: { code: string; message: string } }>) => {
    const r = await result;
    assert.ok(!r.ok, "expected an error result");
    assert.equal(r.error?.code, "invalid_response");
    return r.error?.message ?? "";
};

describe("AiClient checks its results against their declared type", () => {
    it("passes a value that matches (baseline)", async () => {
        const result = await clientWith(programFake()).getProgram("ABCD12345678");
        assert.ok(result.ok);
        assert.equal(result.data.durationMinutes, 30);
    });

    it("rejects a number that is not a number", async () => {
        const message = await rejected(
            clientWith(programFake({ durationInSeconds: NaN })).getProgram("ABCD12345678"),
        );
        assert.match(message, /durationSeconds/);
        assert.match(message, /^Result does not match its type/);
    });

    it("rejects a status outside the declared set", async () => {
        const message = await rejected(
            clientWith(programFake({ availabilityStatus: "bogus" })).getProgram("ABCD12345678"),
        );
        assert.match(message, /status/);
    });

    it("rejects a first-aired date that is not YYYY-MM-DD", async () => {
        const message = await rejected(
            clientWith(programFake({ firstAired: "yesterday" })).getProgram("ABCD12345678"),
        );
        assert.match(message, /firstAired/);
    });

    it("reports the problem per program in getPrograms and still returns the good ones", async () => {
        const fake = {
            getProgramById: async (id: string) => ({
                ...validProgram,
                id,
                durationInSeconds: id === "BBBB00000002" ? Infinity : 60,
            }),
            getMetadata: async () => ({ description: "d" }),
        };
        const result = await clientWith(fake).getPrograms({ programIds: ["AAAA00000001", "BBBB00000002"] });
        assert.ok(result.ok);
        assert.deepEqual(result.data.programs.map((p) => p.id), ["AAAA00000001"]);
        assert.equal(result.data.failed.length, 1);
        assert.equal(result.data.failed[0]?.id, "BBBB00000002");
        assert.equal(result.data.failed[0]?.error.code, "invalid_response");
    });

    it("rejects an episode without an id", async () => {
        const fake = {
            getAllEpisodes: async () => ({
                seriesId: "s",
                seasonName: "1",
                seriesType: "standard",
                seasonType: "season",
                episodes: [validEpisode, { ...validEpisode, prfId: "" }],
            }),
        };
        const message = await rejected(clientWith(fake).getEpisodes({ seriesId: "s", seasonName: "1" }));
        assert.match(message, /episodes\.1\.id/);
    });

    it("rejects a series type outside the declared set", async () => {
        const fake = {
            getSeasons: async () => ({
                seriesId: "s",
                imageUrl300: "https://x/y",
                title: "T",
                seriesType: "weird",
                category: null,
                seasons: [],
            }),
        };
        const message = await rejected(clientWith(fake).getSeries({ seriesId: "s" }));
        assert.match(message, /seriesType/);
    });

    it("rejects a catalog item without an id", async () => {
        const fake = {
            letter: async (letter: string) => ({
                letter,
                programs: [
                    {
                        id: "",
                        type: "programme",
                        title: "T",
                        imageUrl: "u",
                        hasOnDemandRights: true,
                        isGeoBlocked: false,
                        description: "d",
                    },
                ],
                series: [],
            }),
        };
        const client = new AiClient({ nrk: fake as unknown as NrkLike, letters: "a", minIntervalMs: 0 });
        const message = await rejected(client.listCatalog({}));
        assert.match(message, /items\.0\.id/);
    });

    it("does not change a value that is valid", async () => {
        const result = await clientWith(programFake({ contributors: [{ name: "Kari", role: "Programleder" }] })).getProgram(
            "ABCD12345678",
        );
        assert.ok(result.ok);
        assert.deepEqual(result.data.contributors, [{ name: "Kari", role: "Programleder" }]);
        assert.equal(result.data.description, "A description");
    });
});

describe("NRK checks its results against their declared type", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("throws NrkValidationError, labelled as a bad result, when a value contradicts the type", async () => {
        const page = recordedJson(urls.programPage(curated("availableProgram")));
        stub = installFetchMock(() => new Response(JSON.stringify(page), { status: 200 }));

        // NRK's page is fine, but an empty id cannot be a ProgramById.id
        await assert.rejects(NRK.getProgramById(""), (e: unknown) => {
            assert.ok(e instanceof NrkValidationError);
            assert.match(e.message, /^Invalid result from NRK\.getProgramById - id: must not be empty/);
            return true;
        });
    });

    it("keeps the response label for shape problems in NRK's own data", async () => {
        stub = installFetchMock(() => new Response('{"nope":true}', { status: 200 }));
        await assert.rejects(NRK.getSeriesType("x"), (e: unknown) => {
            assert.ok(e instanceof NrkValidationError);
            assert.match(e.message, /^Unexpected response shape/);
            return true;
        });
    });

    it("returns values that pass their own validators, for every recorded program and series", async () => {
        stub = installFetchStub();
        for (const role of ["availableProgram", "programWithContributors", "filmProgram", "expiredProgram", "comingProgram"]) {
            const program = await NRK.getProgramById(curated(role));
            assert.ok(safeParse(r.programById, program).success, role);
        }
        for (const type of ["standard", "sequential", "news"]) {
            const series = await NRK.getSeasons(curated(`${type}Series`));
            assert.ok(safeParse(r.seriesWithSeasons, series).success, type);
            const season = series.seasons[0];
            assert.ok(season);
            const episodes = await NRK.getAllEpisodes(curated(`${type}Series`), season.name);
            assert.ok(safeParse(r.seasonsWithEpisodes, episodes).success, type);
        }
    });
});

describe("the validators reject values that contradict their type", () => {
    const program = validProgram as unknown;

    it("programById", () => {
        assert.ok(safeParse(r.programById, program).success);
        const problems = (bad: object) => {
            const result = safeParse(r.programById, { ...validProgram, ...bad });
            return result.success ? [] : result.issues.map((i) => i.path.join("."));
        };
        assert.deepEqual(problems({ availabilityStatus: "gone" }), ["availabilityStatus"]);
        assert.deepEqual(problems({ id: "" }), ["id"]);
        assert.deepEqual(problems({ productionYear: "2000" }), ["productionYear"]);
        assert.deepEqual(problems({ firstAired: "2000-1-1" }), ["firstAired"]);
        assert.deepEqual(problems({ contributors: [{ name: "x" }] }), ["contributors.0.role"]);
        assert.deepEqual(problems({ images: [{ url: "u" }] }), ["images.0.width"]);
        assert.equal(safeParse(r.programById, { ...validProgram, subtitle: undefined }).success, false);
    });

    it("manifest and metadata", () => {
        assert.ok(safeParse(r.manifest, { prfId: "P", playUrl: "https://x/y.m3u8", format: "HLS" }).success);
        assert.ok(!safeParse(r.manifest, { prfId: "P", playUrl: "https://x/y.m3u8", format: "DASH" }).success);
        assert.ok(!safeParse(r.manifest, { prfId: "P", playUrl: "", format: "HLS" }).success);
        assert.ok(!safeParse(r.metadata, { prfId: "P" }).success);
    });
});
