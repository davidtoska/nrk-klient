import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NRK } from "../../src/client";
import {
    FetchStub,
    installEmptyListStub,
    installFetchStub,
} from "../support/fetch-stub";
import { isHttpUrl, recordedJson, urls } from "../support/helpers";

describe("NRK.letter", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    for (const letter of ["w", "y", "æ"]) {
        it(`splits letter "${letter}" into programs and series`, async () => {
            stub = installFetchStub();
            const raw: Array<{ id: string; type: string; title: string }> = recordedJson(
                urls.letter(letter),
            );

            const result = await NRK.letter(letter);

            assert.equal(result.letter, letter);
            assert.equal(
                result.programs.length,
                raw.filter((r) => r.type === "programme").length,
            );
            assert.equal(result.series.length, raw.filter((r) => r.type === "series").length);
            assert.equal(result.programs.length + result.series.length, raw.length);
            assert.ok(result.programs.every((p) => p.type === "programme"));
            assert.ok(result.series.every((s) => s.type === "series"));
        });
    }

    it("maps every listed item to a well-formed ListedContent", async () => {
        stub = installFetchStub();
        const result = await NRK.letter("w");

        for (const item of [...result.programs, ...result.series]) {
            assert.ok(item.id.length > 0);
            assert.ok(item.title.length > 0);
            assert.ok(item.description.length > 0, "description falls back to a default");
            assert.ok(isHttpUrl(item.imageUrl));
            assert.equal(typeof item.hasOnDemandRights, "boolean");
            assert.equal(typeof item.isGeoBlocked, "boolean");
        }
        const ids = [...result.programs, ...result.series].map((i) => i.id);
        assert.equal(new Set(ids).size, ids.length, "ids should be unique");
    });

    it("handles a letter that only has series (x)", async () => {
        stub = installFetchStub();
        const result = await NRK.letter("x");
        assert.equal(result.programs.length, 0);
        assert.ok(result.series.length > 0);
    });
});

describe("NRK.getAllLetters", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("requests every letter of the Norwegian alphabet, including w", async () => {
        stub = installEmptyListStub();

        await NRK.getAllLetters();

        const requestedLetters = stub.requested
            .map((u) => decodeURIComponent(u.split("/letters/")[1]?.split("/")[0] ?? ""))
            .sort();
        const expected = "abcdefghijklmnopqrstuvwxyzæøå".split("").sort();
        assert.deepEqual(requestedLetters, expected);
    });
});
