import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { NrkClient } from "../../src/nrk-client";
import { parseIsoDuration } from "../../src/nrk-format";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { FIXTURES_DIR } from "../support/fixtures";
import { isHttpUrl, recordedJson, urls } from "../support/helpers";

/**
 * getPlayback gives a player what it needs. These tests run it against the recorded manifest
 * and playback metadata of 20 prfIds (test/fixtures/playback-ids.json) and compare every field
 * with what is in NRK's answer.
 */

const playbackIds: string[] = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "playback-ids.json"), "utf8"),
).ids;

/* eslint-disable @typescript-eslint/no-explicit-any */
const rawManifest = (id: string): any => recordedJson(urls.manifest(id));
const rawMetadata = (id: string): any => recordedJson(urls.metadata(id));

const newClient = () => new NrkClient({ minIntervalMs: 0 });

describe("getPlayback against 20 recorded programs", () => {
    let stub: FetchStub;
    beforeEach(() => {
        stub = installFetchStub();
    });
    afterEach(() => stub.restore());

    it("has 20 different ids, with subtitles, without, and some NRK will not stream", () => {
        assert.equal(playbackIds.length, 20);
        assert.equal(new Set(playbackIds).size, 20);
        const playable = playbackIds.filter((id) => rawManifest(id).playability === "playable");
        const withSubtitles = playable.filter((id) => rawManifest(id).playable.subtitles.length > 0);
        assert.equal(playable.length, 16);
        assert.ok(withSubtitles.length >= 10, "programs with subtitles: " + withSubtitles.length);
        assert.ok(playable.length - withSubtitles.length >= 5);
    });

    for (const id of playbackIds) {
        it(`${id}: gives exactly what NRK's answer says`, async () => {
            const manifest = rawManifest(id);
            const metadata = rawMetadata(id);
            const result = await newClient().getPlayback(id);

            if (manifest.playability !== "playable") {
                assert.ok(!result.ok, "a program NRK will not stream must not give a stream");
                assert.equal(result.error.code, "not_playable");
                assert.equal(result.error.message, manifest.nonPlayable.endUserMessage);
                assert.ok(result.error.message.length > 0);
                return;
            }

            assert.ok(result.ok, !result.ok ? result.error.message : "");
            const p = result.data;
            const hls = manifest.playable.assets.find((a: { format: string }) => a.format === "HLS");

            // what to play
            assert.equal(p.id, id);
            assert.equal(p.streamUrl, hls.url);
            assert.ok(isHttpUrl(p.streamUrl));
            assert.equal(p.mimeType, hls.mimeType);
            assert.equal(p.mediaType, manifest.sourceMedium);

            // how to show it
            assert.equal(p.title, metadata.preplay.titles.title);
            assert.ok(p.title.length > 0);
            assert.equal(p.subtitle, metadata.preplay.titles.subtitle === "" ? null : metadata.preplay.titles.subtitle);
            assert.equal(p.aspectRatio, manifest.displayAspectRatio);
            assert.equal(p.availableTo, metadata.availability.onDemand.to);

            // duration: the seconds of "PT#H#M#S", rounded
            const [, h = "0", m = "0", s = "0"] =
                /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(manifest.playable.duration) ?? [];
            assert.equal(p.durationSeconds, Math.round(Number(h) * 3600 + Number(m) * 60 + Number(s)));
            assert.ok(p.durationSeconds !== null && p.durationSeconds > 0);

            // a poster that NRK really listed, the one closest to 960 px
            const listed: Array<{ url: string; pixelWidth: number }> = metadata.preplay.poster.images;
            if (listed.length === 0) {
                assert.equal(p.posterUrl, null);
            } else {
                const best = Math.min(...listed.map((i) => Math.abs(i.pixelWidth - 960)));
                const closest = listed.filter((i) => Math.abs(i.pixelWidth - 960) === best).map((i) => i.url);
                assert.ok(p.posterUrl !== null && closest.includes(p.posterUrl), "poster " + p.posterUrl);
            }

            // subtitles: every track with a file, in NRK's order
            const tracks = (manifest.playable.subtitles as Array<any>).filter((t) => t.webVtt);
            assert.deepEqual(
                p.subtitles,
                tracks.map((t) => ({
                    language: t.language,
                    label: t.label,
                    url: t.webVtt,
                    defaultOn: t.defaultOn,
                })),
            );
            for (const track of p.subtitles) {
                assert.ok(isHttpUrl(track.url) && track.url.endsWith(".vtt"), track.url);
            }
        });
    }

    it("uses two requests: the manifest and the playback metadata", async () => {
        const id = playbackIds[0] ?? "";
        await newClient().getPlayback(id);
        assert.deepEqual([...stub.requested].sort(), [urls.manifest(id), urls.metadata(id)].sort());
    });

    it("tells why a program cannot be played, in NRK's words", async () => {
        const expired = await newClient().getPlayback("KMNO10015526");
        assert.ok(!expired.ok);
        assert.equal(expired.error.message, "Ikke tilgjengelig lenger");

        const notYet = await newClient().getPlayback("KMNO10056526");
        assert.ok(!notYet.ok);
        assert.equal(notYet.error.code, "not_playable");
        assert.match(notYet.error.message, /^Kommer /);
    });

    it("reads subtitles and a duration with decimals correctly (MUHH01002725)", async () => {
        const result = await newClient().getPlayback("MUHH01002725");
        assert.ok(result.ok);
        assert.equal(result.data.durationSeconds, 27); // PT27.44S
        assert.equal(result.data.subtitles.length, 1);
        assert.equal(result.data.subtitles[0]?.language, "nb");
        assert.equal(result.data.subtitles[0]?.defaultOn, true);
    });

    it("says not_found for an id NRK does not have, and invalid_input for nonsense", async () => {
        stub.restore();
        stub = installFetchMock(() => new Response('{"message":"nope"}', { status: 404 }));
        const missing = await newClient().getPlayback("DOESNOTEXIST");
        assert.ok(!missing.ok);
        assert.equal(missing.error.code, "not_found");

        const before = stub.requested.length;
        for (const bad of ["", "   ".repeat(30) + "x".repeat(60)]) {
            const result = await newClient().getPlayback(bad);
            assert.ok(!result.ok);
            assert.equal(result.error.code, "invalid_input");
        }
        // @ts-expect-error the id must be a string
        const notString = await newClient().getPlayback(42);
        assert.ok(!notString.ok);
        assert.equal(notString.error.code, "invalid_input");
        assert.equal(stub.requested.length, before, "bad input must not reach NRK");
    });
});

describe("getPlayback with altered answers", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    const id = "FFIL63000263";
    const serveChanged = (change: (manifest: any, metadata: any) => void) => {
        const manifest = structuredClone(rawManifest(id));
        const metadata = structuredClone(rawMetadata(id));
        change(manifest, metadata);
        stub = installFetchMock((url) =>
            new Response(JSON.stringify(url.includes("/manifest/") ? manifest : metadata), { status: 200 }),
        );
    };

    it("picks HLS among other formats and ignores subtitles without a file", async () => {
        serveChanged((manifest) => {
            const hls = manifest.playable.assets[0];
            manifest.playable.assets = [
                { url: "https://x/y.mp4", format: "MP4", mimeType: "video/mp4", encrypted: false },
                hls,
            ];
            manifest.playable.subtitles = [
                { type: "nor", language: "nb", label: "Uten fil", defaultOn: false, webVtt: null },
                { type: "nor", language: "en", label: "English", webVtt: "https://x/en.vtt" },
            ];
        });
        const result = await newClient().getPlayback(id);
        assert.ok(result.ok);
        assert.ok(result.data.streamUrl.includes("m3u8"));
        assert.deepEqual(result.data.subtitles, [
            { language: "en", label: "English", url: "https://x/en.vtt", defaultOn: false },
        ]);
    });

    it("refuses an encrypted stream and a manifest without HLS", async () => {
        serveChanged((manifest) => {
            manifest.playable.assets[0].encrypted = true;
        });
        const encrypted = await newClient().getPlayback(id);
        assert.ok(!encrypted.ok);
        assert.equal(encrypted.error.code, "not_playable");
        assert.match(encrypted.error.message, /DRM/);
        stub?.restore();

        serveChanged((manifest) => {
            manifest.playable.assets = [{ url: "https://x/y.mp4", format: "MP4", mimeType: "video/mp4" }];
        });
        const noHls = await newClient().getPlayback(id);
        assert.ok(!noHls.ok);
        assert.equal(noHls.error.code, "not_playable");
    });

    it("reports audio, no poster and an unknown duration as they are", async () => {
        serveChanged((manifest, metadata) => {
            manifest.sourceMedium = "audio";
            manifest.playable.duration = "soon";
            manifest.displayAspectRatio = null;
            metadata.displayAspectRatio = null;
            metadata.preplay.poster.images = [];
        });
        const result = await newClient().getPlayback(id);
        assert.ok(result.ok);
        assert.equal(result.data.mediaType, "audio");
        assert.equal(result.data.durationSeconds, null);
        assert.equal(result.data.posterUrl, null);
        assert.equal(result.data.aspectRatio, null);
    });

    it("does not hand out a stream address that is not a URL", async () => {
        serveChanged((manifest) => {
            manifest.playable.assets[0].url = "not a url";
        });
        const result = await newClient().getPlayback(id);
        assert.ok(!result.ok);
        assert.equal(result.error.code, "invalid_response");
    });

    it("maps a 429 to rate_limited with the wait time", async () => {
        stub = installFetchMock(
            () => new Response("slow down", { status: 429, headers: { "retry-after": "600" } }),
        );
        const result = await newClient().getPlayback(id);
        assert.ok(!result.ok);
        assert.equal(result.error.code, "rate_limited");
        assert.equal(result.error.retryAfterSeconds, 600);
    });
});

describe("parseIsoDuration", () => {
    it("reads the forms NRK uses", () => {
        assert.equal(parseIsoDuration("PT8M24S"), 504);
        assert.equal(parseIsoDuration("PT1H28M3.56S"), 5284);
        assert.equal(parseIsoDuration("PT16.04S"), 16);
        assert.equal(parseIsoDuration("PT1M"), 60);
        assert.equal(parseIsoDuration("PT2H"), 7200);
        assert.equal(parseIsoDuration("P1DT1H"), 90000);
        assert.equal(parseIsoDuration("PT0S"), 0);
    });

    it("gives null for anything else", () => {
        for (const bad of ["", "P", "PT", "soon", "8M24S", "PT-5S", "PT1.S", "1:02:03"]) {
            assert.equal(parseIsoDuration(bad), null, JSON.stringify(bad));
        }
    });
});
