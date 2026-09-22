import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { NrkClient } from "../../src/nrk-client";
import { parseIsoDuration } from "../../src/nrk-format";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { FIXTURES_DIR } from "../support/fixtures";
import { BASE, isHttpUrl, recordedJson } from "../support/helpers";

/**
 * getChannels, getSchedule and getLivePlayback against recorded answers for the channels in
 * test/fixtures/live-ids.json: two national channels, one district variant, and a channel NRK
 * does not have.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const live: { channelIds: string[]; scheduleDate: string } = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "live-ids.json"), "utf8"),
);

const channelsUrl = `${BASE}/tv/live`;
const scheduleUrl = (channelIds: string[], date?: string) => {
    const url = new URL(`${BASE}/tv/epg/${channelIds.join(",")}`);
    if (date) url.searchParams.set("date", date);
    return url.toString();
};
const channelManifestUrl = (id: string) => `${BASE}/playback/manifest/channel/${id}`;
const channelMetadataUrl = (id: string) => `${BASE}/playback/metadata/channel/${id}`;

const rawChannels = (): any[] => recordedJson(channelsUrl);
/** The address nearest `target` px among a list of { url, width|pixelWidth }. */
const closest = (images: any[], key: "width" | "pixelWidth", target = 300): string | null => {
    let best: any = null;
    for (const image of images) {
        if (best === null || Math.abs(image[key] - target) < Math.abs(best[key] - target)) best = image;
    }
    return best?.url ?? null;
};

const newClient = () => new NrkClient({ minIntervalMs: 0 });

describe("getChannels against recorded answers", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("maps every recorded channel field by field", async () => {
        stub = installFetchStub();
        const raw = rawChannels();

        const result = await newClient().getChannels();

        assert.ok(result.ok, !result.ok ? result.error.message : "");
        assert.equal(result.data.length, raw.length);
        raw.forEach((c, i) => {
            const channel = result.data[i];
            assert.ok(channel, `channel #${i}`);
            assert.equal(channel.id, c.id);
            assert.equal(channel.title, c._embedded.playback.title);
            assert.equal(channel.description, c._embedded.playback.description ?? "");
            assert.equal(channel.geoBlocked, c._embedded.playback.isGeoBlocked);
            assert.equal(channel.parentChannelId, c.districtChannel?.parent ?? null);
            const images = c._embedded.playback.posters[0]?.image.items ?? [];
            assert.equal(channel.imageUrl, closest(images, "pixelWidth"));
        });
    });

    it("tells national channels from district variants by parentChannelId", async () => {
        stub = installFetchStub();
        const result = await newClient().getChannels();
        assert.ok(result.ok);

        const nrk1 = result.data.find((c) => c.id === "nrk1");
        assert.ok(nrk1);
        assert.equal(nrk1.parentChannelId, null);

        const district = result.data.find((c) => c.id === "nrk1_ostlandet");
        assert.ok(district);
        assert.equal(district.parentChannelId, "nrk1");
    });

    it("gives every channel a usable picture", async () => {
        stub = installFetchStub();
        const result = await newClient().getChannels();
        assert.ok(result.ok);
        for (const channel of result.data) {
            assert.ok(channel.imageUrl !== null && isHttpUrl(channel.imageUrl), channel.id);
        }
    });
});

describe("getSchedule against recorded answers", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    /** What getSchedule should produce for one raw EPG entry. */
    const expectedItem = (channelId: string, channelTitle: string, e: any) => ({
        id: e.programId,
        channelId,
        channelTitle,
        title: e.title,
        seriesId: e.seriesId ?? null,
        description: e.description ?? "",
        category: e.category?.id ?? "",
        durationSeconds: e.duration ? parseIsoDuration(e.duration.iso8601) : 0,
        start: e.start.planned,
        end: e.end.planned,
        isLive: e.liveTransmission ?? false,
        availableNow: e.availableAs === "ondemand",
        imageUrl: closest(e.posterImages ?? [], "width"),
    });

    it("maps a single channel's guide field by field, with gap slots left out", async () => {
        stub = installFetchStub();
        const raw = recordedJson(scheduleUrl(["nrk1"], live.scheduleDate));
        const rawEntries: any[] = raw[0].transmissionGroups.flatMap((g: any) => g.entries);
        const expected = rawEntries.filter((e) => (e.itemType === "episode" || e.itemType === "program") && e.programId);

        const result = await newClient().getSchedule({ channelIds: ["nrk1"], date: live.scheduleDate });

        assert.ok(result.ok, !result.ok ? result.error.message : "");
        assert.equal(result.data.length, expected.length);
        assert.ok(expected.length > 20, "the recording should have a full day's guide");
        result.data.forEach((item, i) => {
            assert.deepEqual(item, expectedItem(raw[0].channelId, raw[0].title, expected[i]));
        });
    });

    it("no-transmission and unspecified-content slots do not reach the result", async () => {
        stub = installFetchStub();
        const raw = recordedJson(scheduleUrl(["nrk1"], live.scheduleDate));
        const rawEntries: any[] = raw[0].transmissionGroups.flatMap((g: any) => g.entries);
        const gaps = rawEntries.filter((e) => e.itemType !== "episode" && e.itemType !== "program");
        assert.ok(gaps.length > 0, "the recording should have at least one gap slot");

        const result = await newClient().getSchedule({ channelIds: ["nrk1"], date: live.scheduleDate });
        assert.ok(result.ok);
        for (const gap of gaps) {
            assert.ok(!result.data.some((item) => item.start === gap.start.planned && item.title === ""), gap.transmissionId);
        }
    });

    it("covers several channels in one call, each item tagged with its channel", async () => {
        stub = installFetchStub();
        const result = await newClient().getSchedule({ channelIds: live.channelIds, date: live.scheduleDate });
        assert.ok(result.ok, !result.ok ? result.error.message : "");

        const raw = recordedJson(scheduleUrl(live.channelIds, live.scheduleDate));
        const expectedCount = raw.reduce(
            (n: number, c: any) =>
                n +
                c.transmissionGroups
                    .flatMap((g: any) => g.entries)
                    .filter((e: any) => (e.itemType === "episode" || e.itemType === "program") && e.programId).length,
            0,
        );
        assert.equal(result.data.length, expectedCount);
        assert.deepEqual(
            [...new Set(result.data.map((i) => i.channelId))].sort(),
            [...live.channelIds].sort(),
        );
        assert.deepEqual(stub.requested, [scheduleUrl(live.channelIds, live.scheduleDate)]);
    });

    it("defaults to today when no date is given", async () => {
        stub = installFetchStub();
        const result = await newClient().getSchedule({ channelIds: live.channelIds });
        assert.ok(result.ok, !result.ok ? result.error.message : "");
        assert.deepEqual(stub.requested, [scheduleUrl(live.channelIds)]);
    });

    it("marks items already on demand, and only those", async () => {
        stub = installFetchStub();
        const result = await newClient().getSchedule({ channelIds: ["nrk1"], date: live.scheduleDate });
        assert.ok(result.ok);
        const raw = recordedJson(scheduleUrl(["nrk1"], live.scheduleDate));
        const rawById = new Map(raw[0].transmissionGroups.flatMap((g: any) => g.entries).map((e: any) => [e.programId, e]));
        assert.ok(result.data.some((i) => i.availableNow), "at least one item should be on demand already");
        assert.ok(result.data.some((i) => !i.availableNow), "at least one item should not be");
        for (const item of result.data) {
            assert.equal(item.availableNow, (rawById.get(item.id) as any).availableAs === "ondemand", item.id);
        }
    });

    it("returns not_found for a channel id NRK does not have", async () => {
        stub = installFetchStub();
        const result = await newClient().getSchedule({ channelIds: [...live.channelIds, "doesnotexist"], date: live.scheduleDate });
        assert.ok(!result.ok);
        assert.equal(result.error.code, "not_found");
    });

    it("rejects bad input without asking NRK", async () => {
        stub = installFetchMock(() => new Response("[]", { status: 200 }));
        for (const bad of [
            { channelIds: [] },
            { channelIds: Array(21).fill("nrk1") },
            { channelIds: [""] },
            { channelIds: ["nrk1"], date: "22-09-2026" },
            { channelIds: ["nrk1"], date: "not a date" },
        ]) {
            const result = await newClient().getSchedule(bad as never);
            assert.ok(!result.ok, JSON.stringify(bad));
            assert.equal(result.error.code, "invalid_input", JSON.stringify(bad));
        }
        assert.deepEqual(stub.requested, []);
    });
});

describe("getLivePlayback against recorded answers", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    for (const id of live.channelIds) {
        it(`${id}: NRK's real live stream is DRM-protected, so this is not_playable`, async () => {
            stub = installFetchStub();
            const raw = recordedJson(channelManifestUrl(id));
            assert.equal(raw.playable.assets[0].encrypted, true, "fixture must actually be encrypted for this test to mean anything");

            const result = await newClient().getLivePlayback({ id });

            assert.ok(!result.ok, id);
            assert.equal(result.error.code, "not_playable", id);
            assert.match(result.error.message, /DRM/, id);
        });
    }

    it("uses the channel manifest and metadata endpoints, not the program ones", async () => {
        stub = installFetchStub();
        await newClient().getLivePlayback({ id: "nrk1" });
        assert.deepEqual(
            [...stub.requested].sort(),
            [channelManifestUrl("nrk1"), channelMetadataUrl("nrk1")].sort(),
        );
    });

    it("returns not_found for a channel id NRK does not have", async () => {
        stub = installFetchStub();
        const result = await newClient().getLivePlayback({ id: "doesnotexist" });
        assert.ok(!result.ok);
        assert.equal(result.error.code, "not_found");
    });

    it("rejects bad input without asking NRK", async () => {
        stub = installFetchMock(() => new Response("{}", { status: 200 }));
        for (const bad of [{ id: "" }, {}]) {
            const result = await newClient().getLivePlayback(bad as never);
            assert.ok(!result.ok, JSON.stringify(bad));
            assert.equal(result.error.code, "invalid_input");
        }
        assert.deepEqual(stub.requested, []);
    });
});

describe("getLivePlayback if NRK ever serves a channel unencrypted", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("plays it, the same shape as getPlayback", async () => {
        const manifest = structuredClone(recordedJson(channelManifestUrl("nrk1")));
        manifest.playable.assets[0].encrypted = false;
        const metadata = recordedJson(channelMetadataUrl("nrk1"));
        stub = installFetchMock(
            (url) => new Response(JSON.stringify(url.includes("/manifest/") ? manifest : metadata), { status: 200 }),
        );

        const result = await newClient().getLivePlayback({ id: "nrk1" });

        assert.ok(result.ok, !result.ok ? result.error.message : "");
        assert.equal(result.data.id, "nrk1");
        assert.equal(result.data.streamUrl, manifest.playable.assets[0].url);
        assert.equal(result.data.mediaType, "video");
        assert.equal(result.data.durationSeconds, null, "a live channel has no fixed duration");
        assert.ok(isHttpUrl(result.data.streamUrl));
    });
});
