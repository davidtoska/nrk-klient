import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NRK } from "../../src/client";
import { NrkHttpError } from "../../src/nrk-client-raw";
import { FetchStub, installFetchMock } from "../support/fetch-stub";

describe("HTTP error handling", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("turns a 404 JSON body into NrkHttpError instead of a validation error", async () => {
        stub = installFetchMock(
            () =>
                new Response(JSON.stringify({ message: "not found", statusCode: 404 }), {
                    status: 404,
                }),
        );
        await assert.rejects(NRK.getSeriesType("x"), (e: unknown) => {
            assert.ok(e instanceof NrkHttpError);
            assert.equal(e.name, "NrkHttpError");
            assert.equal(e.status, 404);
            assert.deepEqual(e.body, { message: "not found", statusCode: 404 });
            assert.equal(e.retryAfterSeconds, null);
            return true;
        });
    });

    it("exposes Retry-After on 429 so callers can back off", async () => {
        stub = installFetchMock(
            () =>
                new Response('{"reference_id":"0.abc"}', {
                    status: 429,
                    headers: { "retry-after": "600" },
                }),
        );
        await assert.rejects(NRK.getSeriesType("x"), (e: unknown) => {
            assert.ok(e instanceof NrkHttpError);
            assert.equal(e.status, 429);
            assert.equal(e.retryAfterSeconds, 600);
            return true;
        });
    });

    it("keeps a non-JSON error body as text", async () => {
        stub = installFetchMock(() => new Response("Bad gateway", { status: 502 }));
        await assert.rejects(NRK.getSeriesType("x"), (e: unknown) => {
            assert.ok(e instanceof NrkHttpError);
            assert.equal(e.status, 502);
            assert.equal(e.body, "Bad gateway");
            return true;
        });
    });

    it("propagates network failures unchanged", async () => {
        stub = installFetchMock(() => {
            throw new TypeError("fetch failed");
        });
        await assert.rejects(NRK.getSeriesType("x"), /fetch failed/);
    });

    it("still throws a validation error when a 200 body has the wrong shape", async () => {
        stub = installFetchMock(() => new Response('{"unexpected":true}', { status: 200 }));
        await assert.rejects(NRK.getSeriesType("x"), (e: unknown) => {
            assert.ok(!(e instanceof NrkHttpError));
            assert.ok(e instanceof Error);
            return true;
        });
    });
});
