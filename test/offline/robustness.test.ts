import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient } from "../../src/nrk-client";
import { REQUEST_TIMEOUT_MS, parseRetryAfter } from "../../src/nrk-client-raw";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { curated, recordedJson, urls } from "../support/helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Behaviour that matters when the client runs unattended for a long time. */

const newClient = () => new NrkClient({ minIntervalMs: 0 });

describe("requests", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("carry a timeout and identify the client", async () => {
        stub = installFetchStub();
        await newClient().getSeries({ id: curated("standardSeries") });

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

    it("the whole catalog asks for one letter at a time", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        stub = installFetchMock(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 2));
            inFlight--;
            return new Response("[]", { status: 200 });
        });
        const result = await newClient().listCatalog();
        assert.ok(result.ok);
        assert.equal(stub.requested.length, 29);
        assert.equal(maxInFlight, 1, "requests must not overlap");
    });
});

describe("NrkClient error classification", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    const codeOf = async (thrown: unknown) => {
        stub?.restore();
        stub = installFetchMock(() => {
            throw thrown;
        });
        const result = await newClient().getSeries({ id: "x" });
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

describe("NrkClient copes with what NRK's spec allows", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());
    const serve = (json: unknown) => installFetchMock(() => new Response(JSON.stringify(json), { status: 200 }));
    const id = curated("availableProgram");

    /** The recorded manifest, with the recorded metadata changed by `change`. */
    const playbackWith = (change: (metadata: any) => void) => {
        const metadata = structuredClone(recordedJson(urls.metadata(id)));
        change(metadata);
        const manifest = recordedJson(urls.manifest(id));
        return installFetchMock(
            (url) => new Response(JSON.stringify(url.includes("/manifest/") ? manifest : metadata), { status: 200 }),
        );
    };

    it("getPlayback: live content ends with its transmission and has no on-demand window", async () => {
        stub = playbackWith((meta) => {
            meta.streamingMode = "live";
            meta.displayAspectRatio = null;
            meta.availability.onDemand = null;
            meta.availability.live = {
                type: "transmission",
                isOngoing: true,
                transmissionInterval: { from: "2026-09-21T18:00:00+02:00", to: "2026-09-21T19:00:00+02:00" },
            };
        });
        const result = await newClient().getPlayback({ id });
        assert.ok(result.ok, !result.ok ? result.error.message : "");
        assert.equal(result.data.aspectRatio, null);
        assert.equal(result.data.availableTo, "2026-09-21T19:00:00+02:00");
    });

    it("getPlayback: neither window present means no end date", async () => {
        stub = playbackWith((meta) => {
            meta.availability.onDemand = null;
            meta.availability.live = null;
        });
        const result = await newClient().getPlayback({ id });
        assert.ok(result.ok, !result.ok ? result.error.message : "");
        assert.equal(result.data.availableTo, null);
    });

    it("getSeries: takes the image nearest 300 px whatever the order, or null when there is none", async () => {
        const series = structuredClone(recordedJson(urls.series(curated("standardSeries"))));
        const inner = series[series.seriesType];
        inner.image = [
            { url: "https://gfx.nrk.no/w1200", width: 1200 },
            { url: "https://gfx.nrk.no/w320", width: 320 },
            { url: "https://gfx.nrk.no/w600", width: 600 },
        ];
        stub = serve(series);
        const near = await newClient().getSeries({ id: "s" });
        assert.ok(near.ok);
        assert.equal(near.data.imageUrl, "https://gfx.nrk.no/w320");

        stub.restore();
        inner.image = [];
        stub = serve(series);
        const none = await newClient().getSeries({ id: "s" });
        assert.ok(none.ok);
        assert.equal(none.data.imageUrl, null);
    });

    it("listCatalog: an item without description gets an empty string", async () => {
        const raw = structuredClone(recordedJson(urls.letter("w")));
        raw[0].description = null;
        stub = serve(raw);
        const result = await new NrkClient({ letters: "w", minIntervalMs: 0 }).listCatalog();
        assert.ok(result.ok);
        const item = result.data.items.find((i) => i.id === raw[0].id);
        assert.equal(item?.description, "");
    });
});
