import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient } from "../../src/nrk-client";
import { parseFirstAired } from "../../src/nrk-format";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { curated, isHttpUrl, recordedJson, urls } from "../support/helpers";

/**
 * How NrkClient turns NRK's recorded answers into its results: every field is compared with
 * what is in NRK's answer, for programs, series, episodes and letter lists.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const newClient = () => new NrkClient({ minIntervalMs: 0 });
const TYPES = ["standard", "sequential", "news"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const unwrap = <T>(result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }): T => {
    assert.ok(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
    return result.data;
};

describe("programs", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("maps the program page field by field", async () => {
        stub = installFetchStub();
        for (const role of ["availableProgram", "programWithContributors", "filmProgram", "geoblockedProgram", "noSubtitleProgram"]) {
            const id = curated(role);
            const raw = recordedJson(urls.programPage(id));

            const program = unwrap(await newClient().getProgram({ id }));

            assert.equal(program.id, id, role);
            assert.equal(program.title, raw.programInformation.titles.title, role);
            assert.equal(program.category, raw.moreInformation.category.id, role);
            assert.equal(program.durationSeconds, raw.moreInformation.duration.seconds, role);
            assert.equal(program.status, raw.programInformation.availability.status, role);
            assert.equal(program.availableFrom, raw.moreInformation.usageRights.from.date, role);
            assert.equal(program.availableTo, raw.moreInformation.usageRights.to.date, role);
            assert.equal(program.productionYear, raw.moreInformation.productionYear ?? null, role);
            assert.ok(program.productionYear === null || Number.isInteger(program.productionYear), role);
        }
    });

    it("reads the first broadcast date, the credited people and the series link", async () => {
        stub = installFetchStub();
        for (const role of ["availableProgram", "programWithContributors", "filmProgram"]) {
            const id = curated(role);
            const raw = recordedJson(urls.programPage(id));

            const program = unwrap(await newClient().getProgram({ id }));

            assert.equal(program.firstAired, parseFirstAired(raw.moreInformation.transmissions?.first?.displayValue), role);
            assert.ok(program.firstAired === null || ISO_DATE.test(program.firstAired), role);

            const expected = (raw.contributors ?? []).flatMap((g: { role: string; name: string[] }) =>
                g.name.map((name) => ({ name, role: g.role })),
            );
            assert.deepEqual(program.contributors, expected.slice(0, 15), role);

            const href: string | undefined = raw._links.seriesPage?.href;
            assert.equal(program.seriesId, href ? href.split("/").pop() : null, role);
        }
    });

    it("reads several credited people from a real program page", async () => {
        stub = installFetchStub();
        const program = unwrap(await newClient().getProgram({ id: curated("programWithContributors") }));
        assert.ok(program.contributors.length >= 3);
        for (const person of program.contributors) {
            assert.ok(person.name.length > 0);
            assert.ok(person.role.length > 0);
        }
    });

    it("reports expired and upcoming programs by their status", async () => {
        stub = installFetchStub();
        assert.equal(unwrap(await newClient().getProgram({ id: curated("expiredProgram") })).status, "expired");
        assert.equal(unwrap(await newClient().getProgram({ id: curated("comingProgram") })).status, "coming");
    });

    it("handles a film-length program", async () => {
        stub = installFetchStub();
        const program = unwrap(await newClient().getProgram({ id: curated("filmProgram") }));
        assert.ok(program.durationSeconds >= 75 * 60);
        assert.ok(program.category.length > 0);
    });

    it("still reads a page that has no _embedded section at all", async () => {
        const id = curated("availableProgram");
        const raw = structuredClone(recordedJson(urls.programPage(id)));
        delete raw._embedded;
        const metadata = recordedJson(urls.metadata(id));
        stub = installFetchMock(
            (url) => new Response(JSON.stringify(url.includes("/playback/metadata/") ? metadata : raw), { status: 200 }),
        );

        const program = unwrap(await newClient().getProgram({ id }));

        assert.equal(program.title, raw.programInformation.titles.title);
    });

    it("asks for an id NRK calls malformed and gets not_found", async () => {
        stub = installFetchStub();
        const result = await newClient().getProgram({ id: curated("missingProgram") });
        assert.ok(!result.ok);
        assert.equal(result.error.code, "not_found");
        assert.match(result.error.message, /programs\/DOESNOTEXIST/);
    });
});

describe("series and episodes", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    for (const type of TYPES) {
        describe(`${type} series`, () => {
            const id = () => curated(`${type}Series`);

            it("maps title, type, seasons and category", async () => {
                stub = installFetchStub();
                const raw = recordedJson(urls.series(id()));

                const series = unwrap(await newClient().getSeries({ id: id() }));

                assert.equal(series.id, id());
                assert.equal(series.seriesType, type);
                assert.equal(series.title, raw[type].titles.title);
                assert.deepEqual(series.seasons, raw._links.seasons.map((s: any) => ({ name: s.name, title: s.title })));
                assert.deepEqual(series.category, raw[type].category ?? null);
                assert.ok(series.seasons.length > 0, "series should have seasons");
                assert.ok(series.imageUrl !== null && isHttpUrl(series.imageUrl));
            });

            it("maps every episode of the recorded seasons field by field", async () => {
                stub = installFetchStub();
                const series = unwrap(await newClient().getSeries({ id: id() }));
                for (const season of series.seasons.slice(0, 2)) {
                    const raw = recordedJson(urls.season(id(), season.name));
                    const rawList: any[] = raw._embedded.episodes ?? raw._embedded.instalments ?? [];

                    const result = unwrap(await newClient().getEpisodes({ seriesId: id(), seasonName: season.name }));

                    assert.equal(result.seriesId, id());
                    assert.equal(result.seasonName, season.name);
                    assert.equal(result.seasonType, raw.seasonType);
                    assert.equal(result.episodes.length, rawList.length);
                    result.episodes.forEach((episode, i) => {
                        const r = rawList[i];
                        assert.equal(episode.id, r.prfId);
                        assert.equal(episode.title, r.titles.title);
                        assert.equal(episode.subtitle, r.titles.subtitle ?? null);
                        assert.equal(episode.durationSeconds, r.durationInSeconds);
                        assert.equal(episode.status, r.availability.status);
                        assert.equal(episode.availableFrom, r.usageRights.from.date);
                        assert.equal(episode.availableTo, r.usageRights.to.date);
                        assert.equal(episode.episodeNumber, r.sequenceNumber ?? null);
                        assert.equal(episode.productionYear, r.productionYear ?? null);
                        assert.equal(
                            episode.firstAired,
                            parseFirstAired(r.transmissions?.first?.displayValue, r.firstTransmissionDateDisplayValue),
                        );
                        assert.ok(episode.firstAired === null || ISO_DATE.test(episode.firstAired));
                        assert.deepEqual(
                            episode.contributors,
                            (r.contributors ?? []).slice(0, 15).map((c: { name: string; role: string }) => ({ name: c.name, role: c.role })),
                        );
                        assert.ok(episode.durationSeconds > 0);
                        assert.ok(episode.imageUrl !== null && isHttpUrl(episode.imageUrl));
                    });
                }
            });
        });
    }

    it("most episodes carry a first broadcast date", async () => {
        stub = installFetchStub();
        for (const type of TYPES) {
            const id = curated(`${type}Series`);
            const series = unwrap(await newClient().getSeries({ id }));
            for (const season of series.seasons.slice(0, 2)) {
                const { episodes } = unwrap(await newClient().getEpisodes({ seriesId: id, seasonName: season.name }));
                const dated = episodes.filter((e) => e.firstAired !== null).length;
                assert.ok(
                    dated / Math.max(1, episodes.length) > 0.5,
                    `${id}/${season.name}: only ${dated}/${episodes.length} have a first-aired date`,
                );
            }
        }
    });

    it("maps credited people on episodes of a series that has them", async () => {
        stub = installFetchStub();
        const seriesId = curated("contributorSeries");
        const seasonName = curated("contributorSeason");
        const raw = recordedJson(urls.season(seriesId, seasonName));
        const rawList: any[] = raw._embedded.episodes ?? raw._embedded.instalments ?? [];

        const { episodes } = unwrap(await newClient().getEpisodes({ seriesId, seasonName }));

        const withPeople = episodes.filter((e) => e.contributors.length > 0);
        assert.ok(withPeople.length > 0, "fixture should contain credited people");
        assert.equal(withPeople.length, rawList.filter((r) => (r.contributors ?? []).length > 0).length);
    });

    it("sequential series expose episode numbers", async () => {
        stub = installFetchStub();
        const id = curated("sequentialSeries");
        const series = unwrap(await newClient().getSeries({ id }));
        let numbered = 0;
        for (const season of series.seasons.slice(0, 2)) {
            const { episodes } = unwrap(await newClient().getEpisodes({ seriesId: id, seasonName: season.name }));
            numbered += episodes.filter((e) => e.episodeNumber !== null).length;
        }
        assert.ok(numbered > 0, "expected at least one numbered episode");
    });

    it("says not_found for an unknown series", async () => {
        stub = installFetchStub();
        const result = await newClient().getSeries({ id: curated("missingSeries") });
        assert.ok(!result.ok);
        assert.equal(result.error.code, "not_found");
    });
});

describe("letter lists", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    for (const letter of ["w", "y", "æ"]) {
        it(`splits letter "${letter}" into programs and series`, async () => {
            stub = installFetchStub();
            const raw: Array<{ id: string; type: string }> = recordedJson(urls.letter(letter));

            const catalog = unwrap(await new NrkClient({ letters: letter, minIntervalMs: 0 }).listCatalog());

            assert.equal(catalog.items.filter((i) => i.type === "program").length, raw.filter((r) => r.type === "programme").length);
            assert.equal(catalog.items.filter((i) => i.type === "series").length, raw.filter((r) => r.type === "series").length);
            assert.equal(catalog.items.length, raw.length);
        });
    }

    it("lists programs before series, each in NRK's order", async () => {
        stub = installFetchStub();
        const raw: Array<{ id: string; type: string }> = recordedJson(urls.letter("w"));
        const expected = [...raw.filter((r) => r.type === "programme"), ...raw.filter((r) => r.type === "series")].map((r) => r.id);

        const catalog = unwrap(await new NrkClient({ letters: "w", minIntervalMs: 0 }).listCatalog());

        assert.deepEqual(catalog.items.map((i) => i.id), expected);
    });

    it("maps every listed item to a well-formed ContentItem", async () => {
        stub = installFetchStub();
        const catalog = unwrap(await new NrkClient({ letters: "w", minIntervalMs: 0 }).listCatalog());

        for (const item of catalog.items) {
            assert.ok(item.id.length > 0);
            assert.ok(item.title.length > 0);
            assert.equal(typeof item.description, "string");
            assert.ok(item.imageUrl !== null && isHttpUrl(item.imageUrl));
            assert.equal(typeof item.availableNow, "boolean");
            assert.equal(typeof item.geoBlocked, "boolean");
        }
        const ids = catalog.items.map((i) => i.id);
        assert.equal(new Set(ids).size, ids.length, "ids should be unique");
    });

    it("handles a letter that only has series (x)", async () => {
        stub = installFetchStub();
        const catalog = unwrap(await new NrkClient({ letters: "x", minIntervalMs: 0 }).listCatalog());
        assert.equal(catalog.items.filter((i) => i.type === "program").length, 0);
        assert.ok(catalog.items.length > 0);
    });
});
