import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NRK } from "../../src/client";
import { NrkHttpError } from "../../src/nrk-client-raw";
import { FetchStub, installFetchMock, installFetchStub } from "../support/fetch-stub";
import { parseFirstAired } from "../../src/nrk-format";
import { curated, isHttpUrl, recordedJson, urls } from "../support/helpers";

describe("NRK.getProgramById", () => {
    let stub: FetchStub;
    beforeEach(() => {
        stub = installFetchStub();
    });
    afterEach(() => stub.restore());

    it("maps the program page to ProgramById", async () => {
        const id = curated("availableProgram");
        const raw = recordedJson(urls.programPage(id));

        const program = await NRK.getProgramById(id);

        assert.equal(program.id, id);
        assert.equal(program.title, raw.programInformation.titles.title);
        assert.equal(program.subtitle, raw.programInformation.titles.subtitle ?? "");
        assert.deepEqual(program.images, raw.programInformation.image);
        assert.equal(program.durationInSeconds, raw.moreInformation.duration.seconds);
        assert.equal(
            program.durationDisplayValue,
            raw.moreInformation.duration.displayValue,
        );
        assert.equal(program.category, raw.moreInformation.category.id);
        assert.equal(program.availabilityStatus, raw.programInformation.availability.status);
        assert.equal(program.availableFromDate, raw.moreInformation.usageRights.from.date);
        assert.equal(program.availableToDate, raw.moreInformation.usageRights.to.date);
        assert.equal(
            program.availableToDisplayValue,
            raw.moreInformation.usageRights.to.displayValue,
        );
    });

    it("reads production year from moreInformation, not from Google Analytics", async () => {
        const id = curated("availableProgram");
        const raw = recordedJson(urls.programPage(id));

        const program = await NRK.getProgramById(id);

        assert.equal(program.productionYear, raw.moreInformation.productionYear ?? null);
        // NRK fills every ga.dimension* with "_", so it must never leak into the result.
        assert.ok(program.productionYear === null || Number.isInteger(program.productionYear));
    });

    it("maps first broadcast date, credited people and series link", async () => {
        for (const role of ["availableProgram", "programWithContributors", "filmProgram"]) {
            const id = curated(role);
            const raw = recordedJson(urls.programPage(id));
            const program = await NRK.getProgramById(id);

            assert.equal(
                program.firstAired,
                parseFirstAired(raw.moreInformation.transmissions?.first?.displayValue),
                role,
            );
            assert.ok(
                program.firstAired === null || /^\d{4}-\d{2}-\d{2}$/.test(program.firstAired),
                role,
            );

            const expected = (raw.contributors ?? []).flatMap(
                (g: { role: string; name: string[] }) =>
                    g.name.map((name) => ({ name, role: g.role })),
            );
            assert.deepEqual(program.contributors, expected, role);

            const href: string | undefined = raw._links.seriesPage?.href;
            assert.equal(program.seriesId, href ? href.split("/").pop() : null, role);
        }
    });

    it("reads several credited people from a real program page", async () => {
        const program = await NRK.getProgramById(curated("programWithContributors"));
        assert.ok(program.contributors.length >= 3);
        for (const person of program.contributors) {
            assert.ok(person.name.length > 0);
            assert.ok(person.role.length > 0);
        }
    });

    it("still parses when _embedded.ga is missing entirely", async () => {
        const id = curated("availableProgram");
        const raw = structuredClone(recordedJson(urls.programPage(id)));
        delete raw._embedded;
        stub.restore();
        stub = installFetchMock(() => new Response(JSON.stringify(raw), { status: 200 }));

        const program = await NRK.getProgramById(id);
        assert.equal(program.title, raw.programInformation.titles.title);
    });

    it("returns an empty subtitle when the program has none", async () => {
        const program = await NRK.getProgramById(curated("noSubtitleProgram"));
        assert.equal(program.subtitle, "");
        assert.ok(program.title.length > 0);
    });

    it("handles a film-length program", async () => {
        const program = await NRK.getProgramById(curated("filmProgram"));
        assert.ok(program.durationInSeconds >= 75 * 60);
        assert.ok(program.category.length > 0);
    });

    it("handles a geoblocked program", async () => {
        const program = await NRK.getProgramById(curated("geoblockedProgram"));
        assert.ok(program.title.length > 0);
    });

    it("has usable images for every recorded program", async () => {
        for (const role of ["availableProgram", "noSubtitleProgram", "filmProgram"]) {
            const program = await NRK.getProgramById(curated(role));
            assert.ok(program.images.length > 0, role + " has no images");
            for (const image of program.images) {
                assert.ok(isHttpUrl(image.url), role + ": bad image url " + image.url);
                assert.ok(image.width > 0);
            }
        }
    });

    it("reports expired and upcoming programs by availability status", async () => {
        const expired = await NRK.getProgramById(curated("expiredProgram"));
        const coming = await NRK.getProgramById(curated("comingProgram"));
        assert.equal(expired.availabilityStatus, "expired");
        assert.equal(coming.availabilityStatus, "coming");
    });

    it("rejects with NrkHttpError 400 for a malformed program id", async () => {
        await assert.rejects(NRK.getProgramById(curated("missingProgram")), (e: unknown) => {
            assert.ok(e instanceof NrkHttpError);
            assert.equal(e.status, 400);
            assert.match(e.url, /programs\/DOESNOTEXIST$/);
            return true;
        });
    });
});
