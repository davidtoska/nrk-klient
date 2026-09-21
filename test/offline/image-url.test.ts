import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient } from "../../src/nrk-client";
import { nearestImageUrl } from "../../src/nrk-format";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { BASE, curated, isHttpUrl, recordedJson, urls } from "../support/helpers";

/**
 * imageUrl: a small picture (about 300 px wide) on every item that a list or a card shows.
 * Expected values are worked out here from NRK's recorded answers, not from the code.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sized = { url: string; width: number };
/** The address whose width is closest to 300; the first one wins a tie. */
const closest = (images: Sized[], target = 300): string | null => {
    let best: Sized | null = null;
    for (const image of images) {
        if (best === null || Math.abs(image.width - target) < Math.abs(best.width - target)) best = image;
    }
    return best?.url ?? null;
};

const newClient = () => new NrkClient({ minIntervalMs: 0 });

describe("nearestImageUrl", () => {
    const set = [
        { url: "w1920", width: 1920 },
        { url: "w300", width: 300 },
        { url: "w600", width: 600 },
        { url: "w960", width: 960 },
    ];

    it("picks the closest width whatever the order", () => {
        assert.equal(nearestImageUrl(set), "w300");
        assert.equal(nearestImageUrl([...set].reverse()), "w300");
        assert.equal(nearestImageUrl(set, 960), "w960");
        assert.equal(nearestImageUrl(set, 700), "w600");
        assert.equal(nearestImageUrl(set, 5000), "w1920");
        assert.equal(nearestImageUrl([{ url: "only", width: 1280 }]), "only");
    });

    it("gives null when there are no images, and the first of two equally close", () => {
        assert.equal(nearestImageUrl([]), null);
        assert.equal(nearestImageUrl([{ url: "a", width: 200 }, { url: "b", width: 400 }]), "a");
    });
});

describe("imageUrl against recorded answers", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("getProgram: the program page's picture closest to 300 px", async () => {
        stub = installFetchStub();
        for (const role of ["availableProgram", "programWithContributors", "filmProgram"]) {
            const id = curated(role);
            const raw: Sized[] = recordedJson(urls.programPage(id)).programInformation.image;
            const result = await newClient().getProgram({ id });
            assert.ok(result.ok, role);
            assert.equal(result.data.imageUrl, closest(raw), role);
            assert.ok(result.data.imageUrl !== null && isHttpUrl(result.data.imageUrl), role);
        }
    });

    it("getSeries: the series' picture closest to 300 px, for every kind of series", async () => {
        stub = installFetchStub();
        for (const type of ["standard", "sequential", "news"] as const) {
            const id = curated(`${type}Series`);
            const raw: Sized[] = recordedJson(urls.series(id))[type].image;
            const result = await newClient().getSeries({ id });
            assert.ok(result.ok, type);
            assert.equal(result.data.imageUrl, closest(raw), type);
        }
    });

    it("getEpisodes: every episode has the picture closest to 300 px", async () => {
        stub = installFetchStub();
        for (const type of ["standard", "sequential", "news"] as const) {
            const seriesId = curated(`${type}Series`);
            const series = await newClient().getSeries({ id: seriesId });
            assert.ok(series.ok);
            const seasonName = series.data.seasons[0]?.name ?? "";
            const raw = recordedJson(urls.season(seriesId, seasonName));
            const rawList: any[] = raw._embedded.episodes ?? raw._embedded.instalments;
            const result = await newClient().getEpisodes({ seriesId, seasonName });
            assert.ok(result.ok, type);
            assert.equal(result.data.episodes.length, rawList.length);
            result.data.episodes.forEach((episode, i) => {
                assert.equal(episode.imageUrl, closest(rawList[i].image), `${type} #${i}`);
            });
        }
    });

    it("getRecommendations: every item has the picture closest to 300 px", async () => {
        stub = installFetchStub();
        const id = "FFIL63000263";
        const raw: any[] = recordedJson(`${BASE}/tv/recommendations/${id}?maxNumber=10&contentGroup=adults`)._embedded
            .recommendations;
        const expected = new Map<string, string | null>(
            raw.map((r) => {
                const body = r.type === "program" ? r.program : r.series;
                const images: Sized[] = body.image.webImages.map((w: any) => ({ url: w.uri, width: w.width }));
                return [body.id, closest(images)];
            }),
        );
        const result = await newClient().getRecommendations({ basedOn: [id] });
        assert.ok(result.ok);
        assert.ok(result.data.items.length > 0);
        for (const item of result.data.items) {
            assert.equal(item.imageUrl, expected.get(item.id), item.id);
        }
    });

    for (const query of ["norsk historie", "Ivar Aasen", "fotball", "krigen"]) {
        it(`search "${query}": every hit has the picture closest to 300 px`, async () => {
            stub = installFetchStub();
            const url = new URL(`${BASE}/search`);
            url.searchParams.set("q", query);
            url.searchParams.set("maxResultsPerPage", "20");
            const raw: any[] = recordedJson(url.toString()).hits;
            const expected = new Map<string, string | null>(
                raw.map((h) => [
                    h.hit.id,
                    closest((h.hit.image?.webImages ?? []).map((w: any) => ({ url: w.imageUrl, width: w.pixelWidth }))),
                ]),
            );
            const result = await newClient().search({ query });
            assert.ok(result.ok);
            for (const item of result.data.items) {
                assert.equal(item.imageUrl, expected.get(item.id), item.id);
            }
            assert.ok(result.data.items.some((i) => i.imageUrl !== null && isHttpUrl(i.imageUrl)));
        });
    }

    it("listCatalog: the smallest picture NRK lists for each item", async () => {
        stub = installFetchStub();
        const raw: any[] = recordedJson(urls.letter("w"));
        const result = await new NrkClient({ letters: "w", minIntervalMs: 0 }).listCatalog();
        assert.ok(result.ok);
        assert.equal(result.data.items.length, raw.length);
        for (const item of result.data.items) {
            const listed = raw.find((r) => r.id === item.id);
            const smallest = [...listed.image.webImages].sort((a: any, b: any) => a.pixelWidth - b.pixelWidth)[0];
            assert.equal(item.imageUrl, smallest.imageUrl, item.id);
        }
    });
});

describe("imageUrl with altered answers", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    const id = curated("availableProgram");
    const serveProgram = (change: (page: any) => void) => {
        const page = structuredClone(recordedJson(urls.programPage(id)));
        change(page);
        const metadata = recordedJson(urls.metadata(id));
        stub = installFetchMock((url) =>
            new Response(JSON.stringify(url.includes("/playback/metadata/") ? metadata : page), { status: 200 }),
        );
    };

    it("is null when NRK lists no picture", async () => {
        serveProgram((page) => {
            page.programInformation.image = [];
        });
        const result = await newClient().getProgram({ id });
        assert.ok(result.ok, !result.ok ? result.error.message : "");
        assert.equal(result.data.imageUrl, null);
    });

    it("does not hand out a picture address that is not a URL", async () => {
        serveProgram((page) => {
            page.programInformation.image = [{ url: "not a url", width: 300 }];
        });
        const result = await newClient().getProgram({ id });
        assert.ok(!result.ok);
        assert.equal(result.error.code, "invalid_response");
        assert.match(result.error.message, /imageUrl/);
    });

    it("a search hit without a picture gets null, and the rest of the hits are kept", async () => {
        stub = installFetchMock(
            () =>
                new Response(
                    JSON.stringify({
                        hits: [
                            { type: "serie", hit: { id: "uten-bilde", title: "Uten bilde", hasRights: true } },
                            {
                                type: "serie",
                                hit: {
                                    id: "med-bilde",
                                    title: "Med bilde",
                                    hasRights: true,
                                    image: { webImages: [{ imageUrl: "https://gfx.nrk.no/a", pixelWidth: 300 }] },
                                },
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        );
        const result = await newClient().search({ query: "x" });
        assert.ok(result.ok);
        assert.deepEqual(result.data.items.map((i) => [i.id, i.imageUrl]), [
            ["uten-bilde", null],
            ["med-bilde", "https://gfx.nrk.no/a"],
        ]);
    });
});
