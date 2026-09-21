import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient } from "../../src/nrk-client";
import { FetchStub, installFetchMock } from "../support/fetch-stub";

/**
 * Ids can come from an agent, so they must never change which endpoint is called.
 * Every value that ends up in a path is encoded; the tests check the URLs that are requested.
 */

const HOSTILE = "x/../../../live?debug=1#frag";

describe("path segments are encoded", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    const client = new NrkClient({ minIntervalMs: 0 });

    /** Every URL a call requests; NRK answers 404, which is all these tests need. */
    const requestedUrls = async (call: () => Promise<unknown>): Promise<URL[]> => {
        stub?.restore();
        stub = installFetchMock(() => new Response("{}", { status: 404 }));
        await call();
        assert.ok(stub.requested.length >= 1, "a request was made");
        return stub.requested.map((u) => new URL(u));
    };

    const calls: Array<[string, () => Promise<unknown>, string[]]> = [
        ["getSeries", () => client.getSeries({ id: HOSTILE }), ["/tv/catalog/series/"]],
        ["getEpisodes (series)", () => client.getEpisodes({ seriesId: HOSTILE, seasonName: "2020" }), ["/tv/catalog/series/"]],
        ["getEpisodes (season)", () => client.getEpisodes({ seriesId: "s", seasonName: HOSTILE }), ["/tv/catalog/series/s/seasons/"]],
        ["getProgram", () => client.getProgram({ id: HOSTILE }), ["/tv/catalog/programs/"]],
        [
            "getPlayback",
            () => client.getPlayback({ id: HOSTILE }),
            ["/playback/manifest/program/", "/playback/metadata/program/"],
        ],
        ["getRecommendations", () => client.getRecommendations({ basedOn: [HOSTILE] }), ["/tv/recommendations/"]],
    ];

    for (const [name, call, prefixes] of calls) {
        it(`${name}: a hostile id stays one path segment on the same host`, async () => {
            for (const url of await requestedUrls(call)) {
                assert.equal(url.host, "psapi.nrk.no");
                assert.equal(url.hash, "", "no fragment");
                assert.ok(
                    prefixes.some((prefix) => url.pathname.startsWith(prefix)),
                    `${url.pathname} should start with one of ${prefixes.join(", ")}`,
                );
                assert.ok(!url.pathname.split("/").includes(".."), "no path traversal");
                assert.ok(!url.pathname.includes("/live"), "the id must not reach another endpoint");
                if (name === "getRecommendations") {
                    assert.deepEqual([...url.searchParams.keys()].sort(), ["contentGroup", "maxNumber"]);
                } else {
                    assert.equal(url.search, "", "no injected query string");
                }
            }
        });
    }

    it("leaves ordinary ids unchanged", async () => {
        const [url] = await requestedUrls(() => client.getEpisodes({ seriesId: "distriktsnyheter-oestfold", seasonName: "2019" }));
        assert.equal(url?.pathname, "/tv/catalog/series/distriktsnyheter-oestfold/seasons/2019");
    });

    it("encodes non-ASCII letters", async () => {
        const [url] = await requestedUrls(() => client.listCatalog({ letters: "æ" }));
        assert.equal(url?.pathname, "/medium/tv/letters/%C3%A6/indexelements");
    });

    it("does not let a letter list reach another endpoint: only letters are accepted", async () => {
        stub = installFetchMock(() => new Response("{}", { status: 404 }));
        for (const bad of ["a/../live", "a?x=1", "a#b", "../"]) {
            const result = await client.listCatalog({ letters: bad });
            assert.ok(!result.ok, bad);
            assert.equal(result.error.code, "invalid_input", bad);
        }
        assert.deepEqual(stub.requested, [], "nothing was requested");
    });
});
