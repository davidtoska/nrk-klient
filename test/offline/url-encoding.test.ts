import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient, NrkLike } from "../../src/nrk-client";
import { NRK } from "../../src/client";
import { FetchStub, installFetchMock } from "../support/fetch-stub";

/**
 * Ids can come from an agent, so they must never change which endpoint is called.
 * Every value that ends up in a path is encoded; the tests check the URL that is requested.
 */

const HOSTILE = "x/../../../live?debug=1#frag";

describe("path segments are encoded", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    const requestedUrl = async (call: () => Promise<unknown>): Promise<URL> => {
        stub = installFetchMock(() => new Response("{}", { status: 404 }));
        await call().catch(() => undefined);
        assert.equal(stub.requested.length, 1);
        return new URL(stub.requested[0] ?? "");
    };

    const calls: Array<[string, () => Promise<unknown>, string]> = [
        ["letter", () => NRK.letter(HOSTILE), "/medium/tv/letters/"],
        ["getManifest", () => NRK.getManifest(HOSTILE), "/playback/manifest/program/"],
        ["getMetadata", () => NRK.getMetadata(HOSTILE), "/playback/metadata/program/"],
        ["getSeasons", () => NRK.getSeasons(HOSTILE), "/tv/catalog/series/"],
        ["getSeriesType", () => NRK.getSeriesType(HOSTILE), "/tv/catalog/series/"],
        ["getAllEpisodes (series)", () => NRK.getAllEpisodes(HOSTILE, "2020"), "/tv/catalog/series/"],
        ["getAllEpisodes (season)", () => NRK.getAllEpisodes("s", HOSTILE), "/tv/catalog/series/s/seasons/"],
        ["getProgramById", () => NRK.getProgramById(HOSTILE), "/tv/catalog/programs/"],
        ["getRecommendation", () => NRK.getRecommendation(HOSTILE, {}), "/tv/recommendations/"],
    ];

    for (const [name, call, prefix] of calls) {
        it(`${name}: a hostile id stays one path segment on the same host`, async () => {
            const url = await requestedUrl(call);
            assert.equal(url.host, "psapi.nrk.no");
            assert.equal(url.hash, "", "no fragment");
            assert.ok(url.pathname.startsWith(prefix), `${url.pathname} should start with ${prefix}`);
            assert.ok(!url.pathname.split("/").includes(".."), "no path traversal");
            assert.ok(!url.pathname.includes("/live"), "the id must not reach another endpoint");
            if (name !== "getRecommendation") {
                assert.equal(url.search, "", "no injected query string");
            } else {
                assert.deepEqual([...url.searchParams.keys()].sort(), ["contentGroup", "maxNumber"]);
            }
        });
    }

    it("leaves ordinary ids unchanged", async () => {
        const url = await requestedUrl(() => NRK.getAllEpisodes("distriktsnyheter-oestfold", "2019"));
        assert.equal(url.pathname, "/tv/catalog/series/distriktsnyheter-oestfold/seasons/2019");
    });

    it("encodes non-ASCII letters", async () => {
        const url = await requestedUrl(() => NRK.letter("æ"));
        assert.equal(url.pathname, "/medium/tv/letters/%C3%A6/indexelements");
    });

    it("holds for ids that reach the client through NrkClient", async () => {
        const client = new NrkClient({ nrk: NRK as NrkLike, minIntervalMs: 0 });
        stub = installFetchMock(() => new Response("{}", { status: 404 }));

        await client.getEpisodes({ seriesId: HOSTILE, seasonName: HOSTILE });
        await client.getSeries({ seriesId: HOSTILE });
        await client.getProgram(HOSTILE);

        assert.ok(stub.requested.length >= 3);
        for (const requested of stub.requested) {
            const url = new URL(requested);
            assert.equal(url.host, "psapi.nrk.no");
            assert.equal(url.search, "");
            assert.equal(url.hash, "");
            assert.ok(!url.pathname.includes("/live"), url.pathname);
            assert.ok(!url.pathname.split("/").includes(".."), url.pathname);
        }
    });
});
