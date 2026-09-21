import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient } from "../../src/nrk-client";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { curated, first, recordedJson, urls } from "../support/helpers";

// ── A fake NRK with known content, served as NRK's own letter lists ──

interface Listed {
    id: string;
    type: "programme" | "series";
    title: string;
    description: string;
    hasOndemandRights: boolean;
    isGeoBlocked: boolean;
}

const listed = (
    id: string,
    type: "programme" | "series",
    title: string,
    description: string,
    flags: { onDemand?: boolean; geo?: boolean } = {},
): Listed => {
    return {
        id,
        type,
        title,
        description,
        hasOndemandRights: flags.onDemand ?? true,
        isGeoBlocked: flags.geo ?? false,
    };
};

/** What the fake NRK lists under each letter. "b" repeats P1 to test de-duplication. */
const BY_LETTER: Record<string, Listed[]> = {
    a: [
        listed("P1", "programme", "Fotball-VM", "Kampen om pokalen."),
        listed("S1", "series", "Skiskyting", "Vinter i Holmenkollen.", { onDemand: false }),
        listed("P3", "programme", "Fotball utenfor Norge", "Sendes bare i Norge.", { geo: true }),
        listed("P4", "programme", "Ordløs", ""),
        listed("P5", "programme", "Lang beskrivelse", "x".repeat(500)),
    ],
    b: [
        listed("P1", "programme", "Fotball-VM", "Kampen om pokalen."),
        listed("P6", "programme", "Bok", "Om en bok."),
    ],
};

const asNrkLetter = (item: Listed) => ({
    ...item,
    sortLetter: item.title.slice(0, 1),
    image: { webImages: [{ imageUrl: "https://gfx.nrk.no/x", pixelWidth: 300 }] },
});

const letterOf = (url: string): string => decodeURIComponent(url.split("/letters/")[1]?.split("/")[0] ?? "");

/** Installs a fetch that answers with `answer(letter)` for a letter list. `calls` collects the letters asked for. */
const serveLetters = (
    answer: (letter: string) => Response | Listed[],
    calls: string[] = [],
): FetchStub =>
    installFetchMock((url) => {
        const letter = letterOf(url);
        calls.push(letter);
        const reply = answer(letter);
        return reply instanceof Response ? reply : new Response(JSON.stringify(reply.map(asNrkLetter)), { status: 200 });
    });

const knownLetters = (letter: string) => BY_LETTER[letter] ?? [];

const newClient = () => new NrkClient({ letters: "ab", minIntervalMs: 0 });

const unwrap = <T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T => {
    assert.ok(result.ok, "expected ok result, got " + JSON.stringify(result));
    return result.data;
};

describe("NrkClient.listCatalog", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("lists programs and series with only the documented fields", async () => {
        stub = serveLetters(knownLetters);
        const catalog = unwrap(await newClient().listCatalog({ letters: "a" }));
        assert.deepEqual(catalog.items.map((i) => i.id), ["P1", "P3", "P4", "P5", "S1"]);
        assert.deepEqual(Object.keys(first(catalog.items)).sort(), [
            "availableNow",
            "description",
            "geoBlocked",
            "id",
            "imageUrl",
            "title",
            "type",
        ]);
        const byId = Object.fromEntries(catalog.items.map((i) => [i.id, i]));
        assert.deepEqual(byId["P1"], {
            id: "P1",
            type: "program",
            title: "Fotball-VM",
            description: "Kampen om pokalen.",
            availableNow: true,
            geoBlocked: false,
            imageUrl: "https://gfx.nrk.no/x",
        });
        assert.equal(byId["S1"]?.type, "series");
        assert.equal(byId["S1"]?.availableNow, false);
        assert.equal(byId["P3"]?.geoBlocked, true);
        assert.deepEqual(catalog.failed, []);
    });

    it("returns everything, unfiltered and with full descriptions", async () => {
        stub = serveLetters(knownLetters);
        const catalog = unwrap(await newClient().listCatalog({ letters: "a" }));
        assert.equal(catalog.items.length, 5, "streamable, geoblocked and unavailable items are all listed");
        assert.equal(catalog.items.find((i) => i.id === "P5")?.description, "x".repeat(500));
    });

    it("keeps an empty description empty", async () => {
        stub = serveLetters(knownLetters);
        const catalog = unwrap(await newClient().listCatalog({ letters: "a" }));
        assert.equal(catalog.items.find((i) => i.id === "P4")?.description, "");
    });

    it("lists an item once even when it appears under several letters", async () => {
        stub = serveLetters(knownLetters);
        const catalog = unwrap(await newClient().listCatalog({ letters: "ab" }));
        assert.deepEqual(catalog.items.map((i) => i.id).sort(), ["P1", "P3", "P4", "P5", "P6", "S1"]);
    });

    it("uses the whole alphabet by default and only the given letters when asked", async () => {
        const all: string[] = [];
        stub = serveLetters(knownLetters, all);
        unwrap(await new NrkClient({ minIntervalMs: 0 }).listCatalog());
        assert.deepEqual(all.sort(), "abcdefghijklmnopqrstuvwxyzæøå".split("").sort());
        stub.restore();

        const some: string[] = [];
        stub = serveLetters(knownLetters, some);
        unwrap(await newClient().listCatalog({ letters: "b" }));
        assert.deepEqual(some, ["b"]);
    });

    it("ignores case and repeated letters", async () => {
        const calls: string[] = [];
        stub = serveLetters(knownLetters, calls);
        unwrap(await newClient().listCatalog({ letters: "AAb" }));
        assert.deepEqual(calls, ["a", "b"]);
    });

    it("stores nothing: every call goes to NRK", async () => {
        const calls: string[] = [];
        stub = serveLetters(knownLetters, calls);
        const client = newClient();
        await client.listCatalog({ letters: "ab" });
        await client.listCatalog({ letters: "ab" });
        assert.deepEqual(calls, ["a", "b", "a", "b"]);
    });

    it("returns the letters that worked and reports the ones that did not", async () => {
        stub = serveLetters((letter) =>
            letter === "a" ? new Response("{}", { status: 404 }) : [listed("P6", "programme", "Bok", "Om en bok.")],
        );

        const catalog = unwrap(await newClient().listCatalog({ letters: "ab" }));

        assert.deepEqual(catalog.items.map((i) => i.id), ["P6"]);
        assert.equal(catalog.failed.length, 1);
        assert.equal(catalog.failed[0]?.letter, "a");
        assert.equal(catalog.failed[0]?.error.code, "not_found");
    });

    it("stops asking NRK once it is rate limited", async () => {
        const calls: string[] = [];
        stub = serveLetters(
            (letter) =>
                letter === "b"
                    ? new Response("{}", { status: 429, headers: { "retry-after": "600" } })
                    : [listed("P6", "programme", "Bok", "Om en bok.")],
            calls,
        );

        const catalog = unwrap(await newClient().listCatalog({ letters: "abc" }));

        assert.deepEqual(calls, ["a", "b"], "c must not be requested after the 429");
        assert.deepEqual(catalog.items.map((i) => i.id), ["P6"]);
        assert.equal(catalog.failed.length, 1);
        assert.equal(catalog.failed[0]?.letter, "b");
        assert.equal(catalog.failed[0]?.error.code, "rate_limited");
        assert.equal(catalog.failed[0]?.error.retryAfterSeconds, 600);
    });

    it("rejects bad input with invalid_input instead of throwing", async () => {
        const client = newClient();
        for (const bad of [{ letters: "" }, { letters: "a1" }, { letters: "a b" }, { letters: "x".repeat(30) }, { letters: 5 }]) {
            const result = await client.listCatalog(bad as never);
            assert.ok(!result.ok, JSON.stringify(bad));
            assert.equal(result.error.code, "invalid_input");
        }
    });
});

describe("NrkClient against recorded NRK responses", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());
    const client = (options: object = {}) => new NrkClient({ minIntervalMs: 0, ...options });

    it("lists the real letter lists", async () => {
        stub = installFetchStub();
        const letters = ["w", "x", "y", "æ"];
        const raw = letters.flatMap((l) => recordedJson(urls.letter(l)) as Array<{ id: string; type: string }>);
        const unique = new Set(raw.map((r) => `${r.type === "programme" ? "program" : "series"}:${r.id}`));

        const catalog = unwrap(await client().listCatalog({ letters: letters.join("") }));

        assert.deepEqual(catalog.failed, []);
        assert.equal(catalog.items.length, unique.size);
        assert.ok(catalog.items.length > 20);
        for (const item of catalog.items) {
            assert.ok(item.id.length > 0 && item.title.length > 0);
            assert.ok(["program", "series"].includes(item.type));
        }
        assert.equal(stub.requested.length, 4, "one request per letter");
    });

    describe("getSeries", () => {
        it("returns title, type and seasons for each series type", async () => {
            stub = installFetchStub();
            for (const type of ["standard", "sequential", "news"] as const) {
                const series = unwrap(await client().getSeries({ id: curated(`${type}Series`) }));
                assert.equal(series.seriesType, type);
                assert.ok(series.title.length > 0);
                assert.ok(series.seasons.length > 0);
                assert.deepEqual(Object.keys(first(series.seasons)).sort(), ["name", "title"]);
            }
        });

        it("includes NRK's own category for the series", async () => {
            stub = installFetchStub();
            for (const type of ["standard", "sequential", "news"] as const) {
                const id = curated(`${type}Series`);
                const raw = recordedJson(urls.series(id))[type].category;
                const series = unwrap(await client().getSeries({ id }));
                assert.deepEqual(series.category, { id: raw.id, name: raw.name });
            }
        });

        it("does not cache: asking twice makes two requests", async () => {
            stub = installFetchStub();
            const c = client();
            await c.getSeries({ id: curated("standardSeries") });
            await c.getSeries({ id: curated("standardSeries") });
            assert.equal(stub.requested.length, 2);
        });

        it("returns not_found for an unknown series", async () => {
            stub = installFetchStub();
            const result = await client().getSeries({ id: curated("missingSeries") });
            assert.ok(!result.ok);
            assert.equal(result.error.code, "not_found");
            assert.match(result.error.message, /404/);
        });
    });

    describe("getEpisodes", () => {
        const load = async (c: NrkClient, role = "standardSeries") => {
            const series = unwrap(await c.getSeries({ id: curated(role) }));
            return { seriesId: curated(role), season: first(series.seasons, "seasons").name };
        };

        it("maps every episode of the season to a compact Episode", async () => {
            stub = installFetchStub();
            const c = client();
            const { seriesId, season } = await load(c);
            const raw = recordedJson(urls.season(seriesId, season));
            const rawList = raw._embedded.episodes ?? raw._embedded.instalments;

            const result = unwrap(await c.getEpisodes({ seriesId, seasonName: season }));

            assert.equal(result.seriesId, seriesId);
            assert.equal(result.seasonName, season);
            assert.equal(result.seasonType, raw.seasonType);
            assert.equal(result.episodes.length, rawList.length);
            result.episodes.forEach((e, i) => {
                assert.equal(e.id, rawList[i].prfId);
                assert.equal(e.title, rawList[i].titles.title);
                assert.equal(e.durationSeconds, rawList[i].durationInSeconds);
                assert.equal(e.durationMinutes, Math.round(rawList[i].durationInSeconds / 60));
            });
            assert.deepEqual(Object.keys(first(result.episodes)).sort(), [
                "availableFrom",
                "availableTo",
                "contributors",
                "durationMinutes",
                "durationSeconds",
                "episodeNumber",
                "firstAired",
                "id",
                "imageUrl",
                "productionYear",
                "status",
                "subtitle",
                "title",
            ]);
        });

        it("has no paging: the season is one response, and the result has no paging fields", async () => {
            stub = installFetchStub();
            const c = client();
            const { seriesId, season } = await load(c, "sequentialSeries");
            const result = unwrap(await c.getEpisodes({ seriesId, seasonName: season }));
            assert.deepEqual(Object.keys(result).sort(), ["episodes", "seasonName", "seasonType", "seriesId"]);
            assert.ok(result.episodes.length >= 2, "fixture needs at least two episodes");
        });

        it("does not cache: asking twice makes two requests", async () => {
            stub = installFetchStub();
            const c = client();
            const args = { seriesId: curated("standardSeries"), seasonName: "" };
            const series = unwrap(await c.getSeries({ id: args.seriesId }));
            args.seasonName = first(series.seasons, "seasons").name;
            const before = stub.requested.length;
            await c.getEpisodes(args);
            await c.getEpisodes(args);
            assert.equal(stub.requested.length - before, 2);
        });

        it("filters on availableOn so only playable episodes remain", async () => {
            stub = installFetchStub();
            const c = client();
            const { seriesId, season } = await load(c);
            const all = unwrap(await c.getEpisodes({ seriesId, seasonName: season }));

            // a day that the window logic can be checked against for every episode
            const day = (first(all.episodes).availableFrom ?? "2026-01-01").slice(0, 10);
            const onDay = unwrap(await c.getEpisodes({ seriesId, seasonName: season, availableOn: day }));
            for (const e of onDay.episodes) {
                assert.notEqual(e.status, "notAvailableOnline");
                if (e.availableFrom) assert.ok(e.availableFrom.slice(0, 10) <= day);
                if (e.availableTo) assert.ok(e.availableTo.slice(0, 10) >= day);
            }
            const excluded = all.episodes.filter((e) => !onDay.episodes.some((o) => o.id === e.id));
            for (const e of excluded) {
                const outside =
                    e.status === "notAvailableOnline" ||
                    (e.availableFrom !== null && e.availableFrom.slice(0, 10) > day) ||
                    (e.availableTo !== null && e.availableTo.slice(0, 10) < day);
                assert.ok(outside, `${e.id} was excluded but is available on ${day}`);
            }

            const past = unwrap(await c.getEpisodes({ seriesId, seasonName: season, availableOn: "1990-01-01" }));
            assert.ok(past.episodes.every((e) => e.availableFrom === null));
            const future = unwrap(await c.getEpisodes({ seriesId, seasonName: season, availableOn: "2999-12-31" }));
            assert.ok(future.episodes.every((e) => e.availableTo === null));
        });

        it("rejects a malformed date, and the old paging arguments are gone", async () => {
            stub = installFetchStub();
            const result = await client().getEpisodes({
                seriesId: "x",
                seasonName: "y",
                availableOn: "1.1.2026",
            });
            assert.ok(!result.ok);
            assert.equal(result.error.code, "invalid_input");
            assert.equal(stub.requested.length, 0, "must not call NRK with invalid input");
        });
    });

    describe("episodes and personalization data", () => {
        it("returns credited people and first broadcast date on episodes", async () => {
            stub = installFetchStub();
            const page = unwrap(
                await client().getEpisodes({
                    seriesId: curated("contributorSeries"),
                    seasonName: curated("contributorSeason"),
                }),
            );
            const withPeople = page.episodes.filter((e) => e.contributors.length > 0);
            assert.ok(withPeople.length > 0);
            for (const person of withPeople.flatMap((e) => e.contributors)) {
                assert.deepEqual(Object.keys(person).sort(), ["name", "role"]);
            }
            assert.ok(page.episodes.some((e) => e.firstAired !== null));
        });

        it("caps credited people per episode at maxContributors", async () => {
            stub = installFetchStub();
            const seriesId = curated("contributorSeries");
            const seasonName = curated("contributorSeason");
            const uncapped = unwrap(
                await client({ maxContributors: 100 }).getEpisodes({ seriesId, seasonName }),
            );
            const capped = unwrap(
                await client({ maxContributors: 1 }).getEpisodes({ seriesId, seasonName }),
            );
            assert.ok(
                uncapped.episodes.some((e) => e.contributors.length > 1),
                "need an episode with 2+ people",
            );
            assert.ok(capped.episodes.every((e) => e.contributors.length <= 1));
        });
    });

    describe("getProgram / getPrograms", () => {
        it("maps a program page to a compact Program", async () => {
            stub = installFetchStub();
            const id = curated("availableProgram");
            const raw = recordedJson(urls.programPage(id));

            const p = unwrap(await client().getProgram({ id }));

            assert.equal(p.id, id);
            assert.equal(p.title, raw.programInformation.titles.title);
            assert.equal(p.category, raw.moreInformation.category.id);
            assert.equal(p.durationSeconds, raw.moreInformation.duration.seconds);
            assert.equal(p.durationMinutes, Math.round(p.durationSeconds / 60));
            assert.equal(p.status, raw.programInformation.availability.status);
            assert.equal(p.availableTo, raw.moreInformation.usageRights.to.date);
        });

        it("includes NRK's description of the program, taken from playback metadata", async () => {
            stub = installFetchStub();
            for (const role of ["availableProgram", "filmProgram", "geoblockedProgram", "expiredProgram"]) {
                const id = curated(role);
                const raw = recordedJson(urls.metadata(id));
                const p = unwrap(await client().getProgram({ id }));
                assert.equal(p.description, raw.preplay.description, role);
            }
        });

        it("reports description as null when the program has no metadata yet", async () => {
            stub = installFetchStub();
            const p = unwrap(await client().getProgram({ id: curated("comingProgram") }));
            assert.equal(p.status, "coming");
            assert.equal(p.description, null);
            assert.ok(p.title.length > 0, "the rest of the program is still returned");
        });

        it("keeps an empty description as \"\" (NRK has none) rather than null", async () => {
            stub = installFetchStub();
            const p = unwrap(await client().getProgram({ id: curated("noSubtitleProgram") }));
            assert.equal(p.description, recordedJson(urls.metadata(curated("noSubtitleProgram"))).preplay.description);
            assert.equal(typeof p.description, "string");
        });

        it("fails the program (not silently) when metadata is rate limited", async () => {
            const page = recordedJson(urls.programPage(curated("availableProgram")));
            stub = installFetchMock((url) =>
                url.includes("/playback/metadata/")
                    ? new Response("{}", { status: 429, headers: { "retry-after": "60" } })
                    : new Response(JSON.stringify(page), { status: 200 }),
            );
            const result = await client().getProgram({ id: curated("availableProgram") });
            assert.ok(!result.ok);
            assert.equal(result.error.code, "rate_limited");
            assert.equal(result.error.retryAfterSeconds, 60);
        });

        it("includes credited people, first broadcast date and series link", async () => {
            stub = installFetchStub();
            const id = curated("programWithContributors");
            const raw = recordedJson(urls.programPage(id));

            const p = unwrap(await client().getProgram({ id }));

            assert.ok(p.contributors.length >= 3);
            assert.deepEqual(Object.keys(first(p.contributors)).sort(), ["name", "role"]);
            const rawPeople = raw.contributors.flatMap((g: { name: string[] }) => g.name);
            assert.deepEqual(
                p.contributors.map((c) => c.name),
                rawPeople.slice(0, 15),
            );
            assert.ok(p.firstAired === null || /^\d{4}-\d{2}-\d{2}$/.test(p.firstAired));
            assert.equal(p.seriesId, null);
            assert.equal(typeof p.productionYear, "number");
        });

        it("drops a subtitle that only repeats the description", async () => {
            stub = installFetchStub();
            const id = curated("programWithContributors");
            const raw = recordedJson(urls.programPage(id));
            const rawSubtitle = raw.programInformation.titles.subtitle;

            const p = unwrap(await client().getProgram({ id }));

            assert.equal(rawSubtitle, p.description, "fixture should have subtitle == description");
            assert.equal(p.subtitle, null);
        });

        it("caps credited people at maxContributors", async () => {
            stub = installFetchStub();
            const id = curated("programWithContributors");
            const all = unwrap(await client({ maxContributors: 100 }).getProgram({ id }));
            assert.ok(all.contributors.length >= 3);

            const capped = unwrap(await client({ maxContributors: 2 }).getProgram({ id }));
            assert.equal(capped.contributors.length, 2);
            assert.deepEqual(capped.contributors, all.contributors.slice(0, 2));
        });

        it("does not cache: a program costs two requests every time (page and metadata)", async () => {
            stub = installFetchStub();
            const c = client();
            await c.getProgram({ id: curated("availableProgram") });
            await c.getProgram({ id: curated("availableProgram") });
            assert.equal(stub.requested.length, 4);
        });

        it("reports a missing subtitle as null", async () => {
            stub = installFetchStub();
            const p = unwrap(await client().getProgram({ id: curated("noSubtitleProgram") }));
            assert.equal(p.subtitle, null);
        });

        it("returns partial results when some ids fail", async () => {
            stub = installFetchStub();
            const result = unwrap(
                await client().getPrograms({
                    ids: [
                        curated("availableProgram"),
                        curated("missingProgram"),
                        curated("filmProgram"),
                    ],
                }),
            );
            assert.deepEqual(
                result.programs.map((p) => p.id),
                [curated("availableProgram"), curated("filmProgram")],
            );
            assert.equal(result.failed.length, 1);
            assert.equal(first(result.failed).id, curated("missingProgram"));
            assert.equal(first(result.failed).error.code, "not_found");
        });

        it("validates the id list", async () => {
            stub = installFetchStub();
            const c = client();
            for (const bad of [[], Array(21).fill("ABCD12345678"), [""]]) {
                const result = await c.getPrograms({ ids: bad });
                assert.ok(!result.ok);
                assert.equal(result.error.code, "invalid_input");
            }
            assert.equal(stub.requested.length, 0);
        });

        it("stops asking NRK after a 429", async () => {
            stub = installFetchMock(
                () => new Response("{}", { status: 429, headers: { "retry-after": "600" } }),
            );
            const result = unwrap(
                await client().getPrograms({ ids: ["AAAA00000001", "AAAA00000002", "AAAA00000003"] }),
            );
            assert.equal(stub.requested.length, 1);
            assert.equal(result.failed.length, 1);
            assert.equal(first(result.failed).error.code, "rate_limited");
            assert.equal(first(result.failed).error.retryAfterSeconds, 600);
        });
    });

    describe("error mapping", () => {
        const codeFor = async (response: () => Response | Promise<Response>) => {
            stub?.restore();
            stub = installFetchMock(response);
            const result = await client().getSeries({ id: "x" });
            assert.ok(!result.ok);
            return result.error;
        };

        it("maps HTTP statuses to error codes", async () => {
            assert.equal((await codeFor(() => new Response("{}", { status: 404 }))).code, "not_found");
            assert.equal((await codeFor(() => new Response("{}", { status: 410 }))).code, "not_found");
            assert.equal((await codeFor(() => new Response("{}", { status: 403 }))).code, "forbidden");
            assert.equal((await codeFor(() => new Response("{}", { status: 503 }))).code, "upstream_error");
            const limited = await codeFor(
                () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
            );
            assert.equal(limited.code, "rate_limited");
            assert.equal(limited.retryAfterSeconds, 30);
        });

        it("maps a network failure and an unexpected body", async () => {
            const network = await codeFor(() => {
                throw new TypeError("fetch failed");
            });
            assert.equal(network.code, "network");

            const shape = await codeFor(() => new Response('{"nope":1}', { status: 200 }));
            assert.equal(shape.code, "invalid_response");
            assert.ok(shape.message.length < 400, "message stays short for the model");
        });
    });

    it("spaces requests by minIntervalMs", async () => {
        stub = installFetchStub();
        const c = new NrkClient({ minIntervalMs: 40 });
        const started = Date.now();
        await c.getProgram({ id: curated("availableProgram") });
        await c.getProgram({ id: curated("filmProgram") });
        await c.getProgram({ id: curated("noSubtitleProgram") });
        assert.ok(Date.now() - started >= 70, "three requests need two gaps of ~40ms");
    });
});
