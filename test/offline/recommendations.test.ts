import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NRK } from "../../src/client";
import { FetchStub, installFetchStub } from "../support/fetch-stub";
import { curated } from "../support/helpers";

describe("NRK.getRecommendation", () => {
    let stub: FetchStub | undefined;
    afterEach(() => stub?.restore());

    it("requests 25 recommendations for adults by default", async () => {
        stub = installFetchStub();
        await NRK.getRecommendation(curated("availableProgram"), {});

        const url = new URL(stub.requested[0] ?? "");
        assert.equal(url.pathname, `/tv/recommendations/${curated("availableProgram")}`);
        assert.equal(url.searchParams.get("maxNumber"), "25");
        assert.equal(url.searchParams.get("contentGroup"), "adults");
        assert.equal(url.searchParams.get("age"), null);
    });

    it("forwards count, contentGroup and age to the API", async () => {
        stub = installFetchStub();
        await NRK.getRecommendation(curated("availableProgram"), {
            count: 5,
            contentGroup: "children",
            age: 9,
        });

        const url = new URL(stub.requested[0] ?? "");
        assert.equal(url.searchParams.get("maxNumber"), "5");
        assert.equal(url.searchParams.get("contentGroup"), "children");
        assert.equal(url.searchParams.get("age"), "9");
    });

    it("maps recommendations to programs and series", async () => {
        stub = installFetchStub();
        const result = await NRK.getRecommendation(curated("standardSeries"), { count: 10 });

        assert.ok(result.programs.length + result.series.length > 0, "expected recommendations");
        for (const item of [...result.programs, ...result.series]) {
            assert.ok(item.id.length > 0);
            assert.ok(item.title.length > 0);
            assert.ok(item.brand.length > 0);
            assert.ok(item.name.length > 0);
            assert.equal(typeof item.subtitle, "string");
            assert.ok(item.images.length > 0);
        }
        assert.ok(result.programs.every((p) => p.type === "program"));
        assert.ok(result.series.every((s) => s.type === "series"));
    });

    it("sorts images by width and picks the smallest as the main image", async () => {
        stub = installFetchStub();
        const result = await NRK.getRecommendation(curated("availableProgram"), {});

        for (const item of [...result.programs, ...result.series]) {
            const widths = item.images.map((i) => i.width);
            assert.deepEqual(widths, [...widths].sort((a, b) => a - b));
            assert.deepEqual(item.image, item.images[0] ?? null);
        }
    });
});
