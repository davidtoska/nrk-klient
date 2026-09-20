import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NRK } from "../../src/client";
import { NrkHttpError } from "../../src/nrk-client-raw";
import { FetchStub, installFetchStub } from "../support/fetch-stub";
import { curated, isHttpUrl, recordedJson, urls } from "../support/helpers";

describe("NRK.getManifest", () => {
    let stub: FetchStub;
    beforeEach(() => {
        stub = installFetchStub();
    });
    afterEach(() => stub.restore());

    it("returns the HLS url of a playable program", async () => {
        const id = curated("availableProgram");
        const raw = recordedJson(urls.manifest(id));

        const manifest = await NRK.getManifest(id);

        assert.equal(manifest.prfId, id);
        assert.equal(manifest.format, "HLS");
        assert.ok(isHttpUrl(manifest.playUrl));
        const hls = raw.playable.assets.find((a: { format: string }) => a.format === "HLS");
        assert.equal(manifest.playUrl, hls.url);
    });

    it("returns a manifest for a film and a geoblocked program", async () => {
        for (const role of ["filmProgram", "geoblockedProgram"]) {
            const manifest = await NRK.getManifest(curated(role));
            assert.equal(manifest.format, "HLS", role);
            assert.ok(isHttpUrl(manifest.playUrl), role);
        }
    });

    it("throws 'Missing playable' for an expired program (200 with nonPlayable)", async () => {
        await assert.rejects(
            NRK.getManifest(curated("expiredProgram")),
            /Missing playable key/,
        );
    });

    it("throws NrkHttpError 404 for a program that is not yet published", async () => {
        await assert.rejects(NRK.getManifest(curated("comingProgram")), (e: unknown) => {
            assert.ok(e instanceof NrkHttpError);
            assert.equal(e.status, 404);
            return true;
        });
    });
});

describe("NRK.getMetadata", () => {
    let stub: FetchStub;
    beforeEach(() => {
        stub = installFetchStub();
    });
    afterEach(() => stub.restore());

    it("maps playback metadata for a playable program", async () => {
        const id = curated("availableProgram");
        const raw = recordedJson(urls.metadata(id));

        const meta = await NRK.getMetadata(id);

        assert.equal(meta.prfId, id);
        assert.equal(meta.title, raw.preplay.titles.title);
        assert.equal(meta.subTitle, raw.preplay.titles.subtitle);
        assert.equal(meta.streamingMode, "onDemand");
        assert.equal(meta.playable, true);
        assert.equal(meta.availableNow, raw.availability.onDemand.hasRightsNow);
        assert.equal(meta.availableTo, raw.availability.onDemand.to);
        assert.ok(["16:9", "4:3"].includes(meta.aspectRatio));
        assert.ok(meta.images.length > 0);
        for (const image of meta.images) {
            assert.ok(isHttpUrl(image.url));
            assert.ok(image.width > 0);
        }
    });

    it("works for film-length and geoblocked programs", async () => {
        for (const role of ["filmProgram", "geoblockedProgram", "noSubtitleProgram"]) {
            const meta = await NRK.getMetadata(curated(role));
            assert.ok(meta.title.length > 0, role);
            assert.equal(meta.playable, true, role);
        }
    });

    it("reports an expired program as not playable and not available", async () => {
        const meta = await NRK.getMetadata(curated("expiredProgram"));
        assert.equal(meta.playable, false);
        assert.equal(meta.availableNow, false);
    });

    it("throws NrkHttpError 404 for a program that is not yet published", async () => {
        await assert.rejects(NRK.getMetadata(curated("comingProgram")), (e: unknown) => {
            assert.ok(e instanceof NrkHttpError);
            assert.equal(e.status, 404);
            return true;
        });
    });
});

describe("NRK.prfIdGetAll", () => {
    let stub: FetchStub;
    beforeEach(() => {
        stub = installFetchStub();
    });
    afterEach(() => stub.restore());

    it("combines manifest, metadata and program page for one id", async () => {
        const id = curated("availableProgram");
        const all = await NRK.prfIdGetAll(id);
        assert.equal(all.manifest.prfId, id);
        assert.equal(all.metadata.prfId, id);
        assert.equal(all.programById.id, id);
        assert.equal(all.metadata.title, all.programById.title);
    });
});
