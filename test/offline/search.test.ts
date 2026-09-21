import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient } from "../../src/nrk-client";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { BASE, recordedJson } from "../support/helpers";

/**
 * search: free-text search in NRK TV. The recorded answers are NRK's real ones
 * (20 hits each): series, programs and single episodes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const searchUrl = (query: string, limit = 20) => {
    const url = new URL(`${BASE}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResultsPerPage", String(limit));
    return url.toString();
};
const rawHits = (query: string): any[] => recordedJson(searchUrl(query)).hits;

const QUERIES = ["norsk historie", "Ivar Aasen", "fotball", "krigen"];
const newClient = () => new NrkClient({ minIntervalMs: 0 });

describe("search against recorded answers", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    for (const query of QUERIES) {
        it(`"${query}": gives NRK's hits in NRK's order, field by field`, async () => {
            stub = installFetchStub();
            const result = await newClient().search({ query });
            assert.ok(result.ok, !result.ok ? result.error.message : "");

            const kinds: Record<string, string> = { serie: "series", program: "program", episode: "episode" };
            const expected = rawHits(query).filter((h) => h.type in kinds && h.hit.hideInSearchResults !== true);
            assert.ok(expected.length >= 10, "the recording should have hits");
            assert.equal(result.data.items.length, expected.length);

            expected.forEach((raw, i) => {
                const item = result.data.items[i];
                assert.ok(item);
                const hit = raw.hit;
                assert.equal(item.id, hit.id);
                assert.equal(item.type, kinds[raw.type]);
                assert.equal(item.title, hit.title);
                assert.equal(item.description, hit.description ?? "");
                assert.equal(item.availableNow, hit.usageRights?.hasRightsNow ?? hit.hasRights);
                assert.equal(item.geoBlocked, hit.usageRights?.isGeoBlocked ?? false);
                if (raw.type === "episode") {
                    assert.equal(item.seriesId, hit.seriesId);
                    assert.equal(item.seriesTitle, hit.seriesTitle);
                    assert.ok(item.seriesId, "an episode names its series");
                } else {
                    assert.equal(item.seriesId, null);
                    assert.equal(item.seriesTitle, null);
                }
            });
            assert.deepEqual(stub.requested, [searchUrl(query)]);
        });
    }

    it("finds the series called 'Norsk historie' when asked for norsk historie", async () => {
        stub = installFetchStub();
        const result = await newClient().search({ query: "norsk historie" });
        assert.ok(result.ok);
        const series = result.data.items.find((i) => i.id === "norsk-historie");
        assert.ok(series);
        assert.equal(series.type, "series");
        assert.equal(series.title, "Norsk historie");
    });

    it("gives programs and single episodes with the ids getPlayback takes", async () => {
        stub = installFetchStub();
        const result = await newClient().search({ query: "krigen" });
        assert.ok(result.ok);
        const kinds = new Set(result.data.items.map((i) => i.type));
        assert.deepEqual([...kinds].sort(), ["episode", "program", "series"]);
        for (const item of result.data.items.filter((i) => i.type !== "series")) {
            assert.match(item.id, /^[A-Z]{4}\d{8}$/, item.title);
        }
    });

    it("gives an empty list, not an error, when nothing matches", async () => {
        stub = installFetchStub();
        const result = await newClient().search({ query: "qzxwvyk" });
        assert.ok(result.ok);
        assert.deepEqual(result.data.items, []);
    });
});

describe("search requests", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());
    const empty = () => new Response(JSON.stringify({ metaData: {}, hits: [], suggests: [], success: true }), { status: 200 });

    it("sends the query and the limit as parameters of /search and nothing else", async () => {
        stub = installFetchMock(empty);
        await newClient().search({ query: "norsk historie", limit: 50 });
        const url = new URL(stub.requested[0] ?? "");
        assert.equal(url.origin + url.pathname, `${BASE}/search`);
        assert.deepEqual([...url.searchParams.keys()], ["q", "maxResultsPerPage"]);
        assert.equal(url.searchParams.get("q"), "norsk historie");
        assert.equal(url.searchParams.get("maxResultsPerPage"), "50");
    });

    it("uses 20 as the default limit", async () => {
        stub = installFetchMock(empty);
        await newClient().search({ query: "x" });
        assert.equal(new URL(stub.requested[0] ?? "").searchParams.get("maxResultsPerPage"), "20");
    });

    it("cannot be used to change the endpoint or add parameters", async () => {
        stub = installFetchMock(empty);
        const nasty = "æøå & medium=2 #frag ?x=1 /../live \n%";
        const result = await newClient().search({ query: nasty });
        assert.ok(result.ok);
        const url = new URL(stub.requested[0] ?? "");
        assert.equal(url.pathname, "/search");
        assert.equal(url.hash, "");
        assert.equal(url.searchParams.get("q"), nasty);
        assert.equal(url.searchParams.get("medium"), null);
        assert.equal(stub.requested.length, 1);
    });

    it("rejects bad input without asking NRK", async () => {
        stub = installFetchMock(empty);
        const bad: unknown[] = [
            {},
            { query: "" },
            { query: "   " },
            { query: "\n\t" },
            { query: "x".repeat(201) },
            { query: 5 },
            { query: null },
            { query: "x", limit: 0 },
            { query: "x", limit: 101 },
            { query: "x", limit: 2.5 },
            { query: "x", limit: "5" },
            null,
        ];
        for (const input of bad) {
            // @ts-expect-error deliberately wrong
            const result = await newClient().search(input);
            assert.ok(!result.ok, JSON.stringify(input));
            assert.equal(result.error.code, "invalid_input", JSON.stringify(input));
        }
        assert.deepEqual(stub.requested, []);
    });

    it("accepts the edges: one character, 200 characters, limit 1 and 100", async () => {
        stub = installFetchMock(empty);
        for (const input of [{ query: "x" }, { query: "x".repeat(200) }, { query: "x", limit: 1 }, { query: "x", limit: 100 }]) {
            const result = await newClient().search(input);
            assert.ok(result.ok, JSON.stringify(input).slice(0, 40));
        }
    });
});

describe("search with altered answers", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    const hit = (extra: object = {}) => ({
        type: "program",
        hit: { id: "ABCD12345678", title: "T", description: "D", hasRights: true, ...extra },
    });
    const serve = (hits: unknown[]) => {
        stub = installFetchMock(() => new Response(JSON.stringify({ metaData: {}, hits, suggests: [], success: true }), { status: 200 }));
    };

    it("skips hit kinds it does not know and hits NRK hides", async () => {
        serve([
            { type: "person", hit: { name: "Somebody" } },
            { type: "kategori", hit: 5 },
            hit({ id: "SHOWN0000001" }),
            hit({ id: "HIDDEN000002", hideInSearchResults: true }),
        ]);
        const result = await newClient().search({ query: "x" });
        assert.ok(result.ok);
        assert.deepEqual(result.data.items.map((i) => i.id), ["SHOWN0000001"]);
    });

    it("reads a series hit that has no usage rights, and a missing description as empty", async () => {
        serve([{ type: "serie", hit: { id: "en-serie", title: "En serie", description: null, hasRights: false } }]);
        const result = await newClient().search({ query: "x" });
        assert.ok(result.ok);
        assert.deepEqual(result.data.items, [
            { id: "en-serie", type: "series", title: "En serie", description: "", availableNow: false, geoBlocked: false, seriesId: null, seriesTitle: null },
        ]);
    });

    it("takes availability and geoblocking from usageRights when NRK gives them", async () => {
        serve([hit({ hasRights: true, usageRights: { isGeoBlocked: true, hasRightsNow: false } })]);
        const result = await newClient().search({ query: "x" });
        assert.ok(result.ok);
        assert.equal(result.data.items[0]?.availableNow, false);
        assert.equal(result.data.items[0]?.geoBlocked, true);
    });

    it("says invalid_response for a known hit without an id, and for a body that is not a search answer", async () => {
        serve([hit({ id: "" })]);
        const noId = await newClient().search({ query: "x" });
        assert.ok(!noId.ok);
        assert.equal(noId.error.code, "invalid_response");
        stub?.restore();

        stub = installFetchMock(() => new Response('{"nope":true}', { status: 200 }));
        const wrong = await newClient().search({ query: "x" });
        assert.ok(!wrong.ok);
        assert.equal(wrong.error.code, "invalid_response");
    });

    it("maps 429, 404 and a network failure to error results", async () => {
        stub = installFetchMock(() => new Response("slow down", { status: 429, headers: { "retry-after": "600" } }));
        const limited = await newClient().search({ query: "x" });
        assert.ok(!limited.ok);
        assert.equal(limited.error.code, "rate_limited");
        assert.equal(limited.error.retryAfterSeconds, 600);
        stub.restore();

        stub = installFetchMock(() => new Response("gone", { status: 404 }));
        const gone = await newClient().search({ query: "x" });
        assert.ok(!gone.ok);
        assert.equal(gone.error.code, "not_found");
        stub.restore();

        stub = installFetchMock(() => {
            throw new TypeError("fetch failed");
        });
        const down = await newClient().search({ query: "x" });
        assert.ok(!down.ok);
        assert.equal(down.error.code, "network");
    });
});
