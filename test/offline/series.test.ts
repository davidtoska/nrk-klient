import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NRK } from "../../src/client";
import { NrkHttpError } from "../../src/nrk-client-raw";
import { FetchStub, installFetchStub } from "../support/fetch-stub";
import { curated, first, isHttpUrl, recordedJson, urls } from "../support/helpers";

const TYPES = ["standard", "sequential", "news"] as const;

describe("series", () => {
    let stub: FetchStub;
    beforeEach(() => {
        stub = installFetchStub();
    });
    afterEach(() => stub.restore());

    for (const type of TYPES) {
        describe(`${type} series`, () => {
            const id = () => curated(`${type}Series`);

            it("getSeriesType reports the type", async () => {
                assert.equal(await NRK.getSeriesType(id()), type);
            });

            it("getSeasons maps title, image and seasons", async () => {
                const raw = recordedJson(urls.series(id()));

                const series = await NRK.getSeasons(id());

                assert.equal(series.seriesId, id());
                assert.equal(series.seriesType, type);
                assert.equal(series.title, raw[type].titles.title);
                assert.ok(isHttpUrl(series.imageUrl300));
                assert.deepEqual(series.seasons, raw._links.seasons);
                assert.ok(series.seasons.length > 0, "series should have seasons");
                for (const season of series.seasons) {
                    assert.ok(season.name.length > 0);
                    assert.ok(season.title.length > 0);
                }
            });

            it("getAllEpisodes returns every episode of the recorded seasons", async () => {
                const series = await NRK.getSeasons(id());
                for (const season of series.seasons.slice(0, 2)) {
                    const raw = recordedJson(urls.season(id(), season.name));
                    const rawList = raw._embedded.episodes ?? raw._embedded.instalments ?? [];

                    const result = await NRK.getAllEpisodes(id(), season.name);

                    assert.equal(result.seriesId, id());
                    assert.equal(result.seasonName, season.name);
                    assert.equal(result.seriesType, type);
                    assert.equal(result.seasonType, raw.seasonType);
                    assert.equal(result.episodes.length, rawList.length);
                    result.episodes.forEach((episode, i) => {
                        const r = rawList[i];
                        assert.equal(episode.episodeId, r.id);
                        assert.equal(episode.prfId, r.prfId);
                        assert.equal(episode.title, r.titles.title);
                        assert.equal(episode.subtitle, r.titles.subtitle ?? null);
                        assert.equal(episode.seriesId, id());
                        assert.equal(episode.seasonName, season.name);
                        assert.equal(episode.durationInSeconds, r.durationInSeconds);
                        assert.equal(episode.availabilityStatus, r.availability.status);
                    });
                }
            });

            it("episodes carry valid numbers, images and no NaN", async () => {
                const series = await NRK.getSeasons(id());
                const season = first(series.seasons, "seasons");
                const { episodes } = await NRK.getAllEpisodes(id(), season.name);

                for (const e of episodes) {
                    assert.ok(e.prfId.length > 0);
                    assert.ok(e.title.length > 0);
                    assert.ok(e.durationInSeconds > 0);
                    assert.ok(e.images.length > 0);
                    assert.ok(e.images.every((img) => isHttpUrl(img.url) && img.width > 0));
                    for (const n of [e.productionYear, e.episodeNumber]) {
                        assert.ok(
                            n === null || Number.isInteger(n),
                            `expected integer or null, got ${n}`,
                        );
                    }
                }
            });
        });
    }

    it("sequential series expose episode numbers (sequenceNumber)", async () => {
        const series = await NRK.getSeasons(curated("sequentialSeries"));
        let numbered = 0;
        for (const season of series.seasons.slice(0, 2)) {
            const { episodes } = await NRK.getAllEpisodes(curated("sequentialSeries"), season.name);
            numbered += episodes.filter((e) => e.episodeNumber !== null).length;
        }
        assert.ok(numbered > 0, "expected at least one numbered episode");
    });

    it("getSeasons rejects with NrkHttpError 404 for an unknown series", async () => {
        await assert.rejects(NRK.getSeasons(curated("missingSeries")), (e: unknown) => {
            assert.ok(e instanceof NrkHttpError);
            assert.equal(e.status, 404);
            return true;
        });
    });
});
