import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient } from "../../src/nrk-client";
import { FetchStub, installFetchMock } from "../support/fetch-stub";
import { curated, recordedJson, urls } from "../support/helpers";

/**
 * The client checks what NRK sends and what it returns. These tests change NRK's recorded
 * answers so that they contradict what the client expects, and check that the caller gets an
 * error result instead of a wrong value.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const newClient = () => new NrkClient({ minIntervalMs: 0 });

describe("the client checks NRK's answers and its own results", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    const id = curated("availableProgram");

    /** Serves the recorded program page and metadata, the page changed by `change`. */
    const serveProgram = (change: (page: any) => void = () => undefined) => {
        const page = structuredClone(recordedJson(urls.programPage(id)));
        change(page);
        const metadata = recordedJson(urls.metadata(id));
        stub = installFetchMock(
            (url) => new Response(JSON.stringify(url.includes("/playback/metadata/") ? metadata : page), { status: 200 }),
        );
    };

    const rejected = async (result: Promise<{ ok: boolean; error?: { code: string; message: string } }>) => {
        const r = await result;
        assert.ok(!r.ok, "expected an error result");
        assert.equal(r.error?.code, "invalid_response");
        return r.error?.message ?? "";
    };

    it("passes an answer that matches (baseline)", async () => {
        serveProgram();
        const result = await newClient().getProgram({ id });
        assert.ok(result.ok);
        assert.equal(result.data.durationMinutes, Math.round(result.data.durationSeconds / 60));
    });

    it("rejects a duration that is not a number", async () => {
        serveProgram((page) => {
            page.moreInformation.duration.seconds = "long";
        });
        const message = await rejected(newClient().getProgram({ id }));
        assert.match(message, /seconds/);
    });

    it("rejects a status outside the declared set", async () => {
        serveProgram((page) => {
            page.programInformation.availability.status = "bogus";
        });
        const message = await rejected(newClient().getProgram({ id }));
        assert.match(message, /status/);
    });

    it("reports the problem per program in getPrograms and still returns the good ones", async () => {
        const good = recordedJson(urls.programPage(id));
        const bad = structuredClone(good);
        bad.moreInformation.duration.seconds = "long";
        const metadata = recordedJson(urls.metadata(id));
        stub = installFetchMock((url) => {
            if (url.includes("/playback/metadata/")) return new Response(JSON.stringify(metadata), { status: 200 });
            return new Response(JSON.stringify(url.endsWith("/BBBB00000002") ? bad : good), { status: 200 });
        });

        const result = await newClient().getPrograms({ ids: ["AAAA00000001", "BBBB00000002"] });

        assert.ok(result.ok);
        assert.deepEqual(result.data.programs.map((p) => p.id), ["AAAA00000001"]);
        assert.equal(result.data.failed.length, 1);
        assert.equal(result.data.failed[0]?.id, "BBBB00000002");
        assert.equal(result.data.failed[0]?.error.code, "invalid_response");
    });

    it("rejects an episode without an id", async () => {
        const seriesId = curated("standardSeries");
        const series = recordedJson(urls.series(seriesId));
        const seasonName = series._links.seasons[0].name;
        const season = structuredClone(recordedJson(urls.season(seriesId, seasonName)));
        const list = season._embedded.episodes ?? season._embedded.instalments;
        list.push({ ...list[0], prfId: "" });
        stub = installFetchMock(() => new Response(JSON.stringify(season), { status: 200 }));

        const message = await rejected(newClient().getEpisodes({ seriesId, seasonName }));

        assert.match(message, new RegExp(`\\.${list.length - 1}\\.prfId`));
    });

    it("rejects a series type outside the declared set", async () => {
        const series = structuredClone(recordedJson(urls.series(curated("standardSeries"))));
        series.seriesType = "weird";
        stub = installFetchMock(() => new Response(JSON.stringify(series), { status: 200 }));

        await rejected(newClient().getSeries({ id: "s" }));
    });

    it("reports a letter with an item that has no id as failed, with an invalid_response error", async () => {
        const letter = structuredClone(recordedJson(urls.letter("w")));
        letter[0].id = "";
        stub = installFetchMock(() => new Response(JSON.stringify(letter), { status: 200 }));

        const result = await new NrkClient({ letters: "w", minIntervalMs: 0 }).listCatalog();

        assert.ok(result.ok, "a bad letter is reported in failed, not as a failed call");
        assert.deepEqual(result.data.items, []);
        assert.equal(result.data.failed.length, 1);
        assert.equal(result.data.failed[0]?.letter, "w");
        assert.equal(result.data.failed[0]?.error.code, "invalid_response");
        assert.match(result.data.failed[0]?.error.message ?? "", /0\.id: Id can not be empty/);
    });

    it("does not change an answer that is valid: credited people and description come through", async () => {
        const withPeople = curated("programWithContributors");
        const page = recordedJson(urls.programPage(withPeople));
        const metadata = recordedJson(urls.metadata(withPeople));
        stub = installFetchMock(
            (url) => new Response(JSON.stringify(url.includes("/playback/metadata/") ? metadata : page), { status: 200 }),
        );

        const result = await newClient().getProgram({ id: withPeople });

        assert.ok(result.ok);
        const expected = page.contributors.flatMap((g: { role: string; name: string[] }) =>
            g.name.map((name) => ({ name, role: g.role })),
        );
        assert.deepEqual(result.data.contributors, expected.slice(0, 15));
        assert.equal(result.data.description, metadata.preplay.description);
    });
});
