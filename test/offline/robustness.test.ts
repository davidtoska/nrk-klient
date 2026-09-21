import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient as AiClient, NrkLike } from "../../src/nrk-client";
import { NRK } from "../../src/client";
import { REQUEST_TIMEOUT_MS, parseRetryAfter } from "../../src/nrk-client-raw";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { curated, recordedJson, urls } from "../support/helpers";

/** Behaviour that matters when the client runs unattended for a long time. */

describe("requests", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("carry a timeout and identify the client", async () => {
        stub = installFetchStub();
        await NRK.getSeriesType(curated("standardSeries"));

        const init = stub.inits[0];
        assert.ok(init, "fetch was called with options");
        assert.ok(init.signal instanceof AbortSignal, "an AbortSignal (timeout) is attached");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("accept"), "application/json");
        assert.match(headers.get("user-agent") ?? "", /^narko-klient\/\S+ \(\+https:\/\/github\.com\//);
        assert.ok(REQUEST_TIMEOUT_MS >= 10_000 && REQUEST_TIMEOUT_MS <= 60_000);
    });

    it("read Retry-After as seconds or as an HTTP date", () => {
        const now = Date.parse("2026-09-21T10:00:00Z");
        assert.equal(parseRetryAfter("600"), 600);
        assert.equal(parseRetryAfter("0"), null);
        assert.equal(parseRetryAfter("-5"), null);
        assert.equal(parseRetryAfter(null), null);
        assert.equal(parseRetryAfter(""), null);
        assert.equal(parseRetryAfter("soon"), null);
        assert.equal(parseRetryAfter("Mon, 21 Sep 2026 10:05:00 GMT", now), 300);
        assert.equal(parseRetryAfter("Mon, 21 Sep 2026 09:00:00 GMT", now), null, "a date in the past");
    });

    it("getAllLetters asks for one letter at a time", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        stub = installFetchMock(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 2));
            inFlight--;
            return new Response("[]", { status: 200 });
        });
        await NRK.getAllLetters();
        assert.equal(stub.requested.length, 29);
        assert.equal(maxInFlight, 1, "requests must not overlap");
    });
});

describe("AiClient error classification", () => {
    const failingWith = (thrown: unknown) =>
        new AiClient({
            nrk: { getSeasons: async () => { throw thrown; } } as unknown as NrkLike,
            minIntervalMs: 0,
        });
    const codeOf = async (thrown: unknown) => {
        const result = await failingWith(thrown).getSeries({ seriesId: "x" });
        assert.ok(!result.ok);
        return result.error.code;
    };

    it("treats fetch failures and timeouts as network errors", async () => {
        assert.equal(await codeOf(new TypeError("fetch failed", { cause: new Error("ECONNRESET") })), "network");
        assert.equal(await codeOf(new TypeError("fetch failed")), "network");
        assert.equal(await codeOf(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "network");
        assert.equal(await codeOf(new DOMException("aborted", "AbortError")), "network");
    });

    it("does not hide a programming error as a network error", async () => {
        assert.equal(await codeOf(new TypeError("Cannot read properties of undefined (reading 'x')")), "unknown");
        assert.equal(await codeOf(new RangeError("bad")), "unknown");
        assert.equal(await codeOf("a string"), "unknown");
    });
});

describe("NRK copes with what its spec allows", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());
    const serve = (json: unknown) => installFetchMock(() => new Response(JSON.stringify(json), { status: 200 }));

    it("getMetadata: live content has no on-demand window", async () => {
        const meta = structuredClone(recordedJson(urls.metadata(curated("availableProgram"))));
        meta.streamingMode = "live";
        meta.displayAspectRatio = null;
        meta.availability.onDemand = null;
        meta.availability.live = {
            type: "transmission",
            isOngoing: true,
            transmissionInterval: { from: "2026-09-21T18:00:00+02:00", to: "2026-09-21T19:00:00+02:00" },
        };
        stub = serve(meta);

        const result = await NRK.getMetadata("LIVE00000001");

        assert.equal(result.streamingMode, "live");
        assert.equal(result.aspectRatio, null);
        assert.equal(result.availableNow, true);
        assert.equal(result.availableTo, "2026-09-21T19:00:00+02:00");
    });

    it("getMetadata: neither window present means not available", async () => {
        const meta = structuredClone(recordedJson(urls.metadata(curated("availableProgram"))));
        meta.availability.onDemand = null;
        meta.availability.live = null;
        stub = serve(meta);
        const result = await NRK.getMetadata("X");
        assert.equal(result.availableNow, false);
        assert.equal(result.availableTo, null);
    });

    it("getManifest: picks HLS among other asset formats, and fails clearly without HLS", async () => {
        const manifest = structuredClone(recordedJson(urls.manifest(curated("availableProgram"))));
        const hls = manifest.playable.assets.find((a: { format: string }) => a.format === "HLS");
        manifest.playable.assets = [
            { url: "https://x/y.mp4", format: "MP4", mimeType: "video/mp4", encrypted: false },
            { url: "https://x/y.mpd", format: "Dash", mimeType: "application/dash+xml" },
            hls,
        ];
        stub = serve(manifest);
        const result = await NRK.getManifest("X");
        assert.equal(result.format, "HLS");
        assert.equal(result.playUrl, hls.url);

        stub.restore();
        manifest.playable.assets = manifest.playable.assets.slice(0, 2);
        stub = serve(manifest);
        await assert.rejects(NRK.getManifest("X"), /Missing HLS/);
    });

    it("getSeasons: takes the image nearest 300 px whatever the order, or null when there is none", async () => {
        const series = structuredClone(recordedJson(urls.series(curated("standardSeries"))));
        const inner = series[series.seriesType];
        inner.image = [
            { url: "https://gfx.nrk.no/w1200", width: 1200 },
            { url: "https://gfx.nrk.no/w320", width: 320 },
            { url: "https://gfx.nrk.no/w600", width: 600 },
        ];
        stub = serve(series);
        assert.equal((await NRK.getSeasons("s")).imageUrl300, "https://gfx.nrk.no/w320");

        stub.restore();
        inner.image = [];
        stub = serve(series);
        assert.equal((await NRK.getSeasons("s")).imageUrl300, null);
    });

    it("letter: an item without description gets an empty string", async () => {
        const raw = structuredClone(recordedJson(urls.letter("w")));
        raw[0].description = null;
        stub = serve(raw);
        const result = await NRK.letter("w");
        const item = [...result.programs, ...result.series].find((i) => i.id === raw[0].id);
        assert.equal(item?.description, "");
    });

    it("getRecommendation: options are optional", async () => {
        stub = installFetchStub();
        const result = await NRK.getRecommendation(curated("availableProgram"));
        assert.ok(result.programs.length + result.series.length > 0);
        const url = new URL(stub.requested[0] ?? "");
        assert.equal(url.searchParams.get("maxNumber"), "25");
        assert.equal(url.searchParams.get("contentGroup"), "adults");
    });
});
