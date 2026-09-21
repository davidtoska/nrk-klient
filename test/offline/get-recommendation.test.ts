import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NrkClient, NrkLike } from "../../src/nrk-client";
import { NrkHttpError } from "../../src/nrk-client-raw";
import type { RecommendedItem } from "../../src/types";
import { FetchStub, installFetchStub } from "../support/fetch-stub";
import { recordedJson, BASE } from "../support/helpers";

/**
 * getRecommendation: recommendations for what the viewer likes, merged over several ids.
 * The recorded answers are NRK's real ones (10 recommendations each, for adults).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const url = (id: string, count = 10) =>
    `${BASE}/tv/recommendations/${id}?maxNumber=${count}&contentGroup=adults`;
const rawItems = (id: string): Array<{ type: string; id: string; title: string; subtitle: string }> =>
    (recordedJson(url(id))._embedded.recommendations as any[]).map((r) => {
        const body = r.type === "program" ? r.program : r.series;
        return { type: r.type, id: body.id, title: body.titles.title, subtitle: body.titles.subtitle ?? "" };
    });

const LIKED = ["FFIL63000263", "OCUH11002809", "filmavisen-innslag-i-utvalg"];

const newClient = () => new NrkClient({ minIntervalMs: 0 });

describe("getRecommendation against recorded answers", () => {
    let stub: FetchStub;
    beforeEach(() => {
        stub = installFetchStub();
    });
    afterEach(() => stub.restore());

    for (const id of LIKED) {
        it(`${id}: gives NRK's recommendations, field by field`, async () => {
            const result = await newClient().getRecommendation({ basedOn: [id] });
            assert.ok(result.ok, !result.ok ? result.error.message : "");
            assert.deepEqual(result.data.failed, []);

            const expected = rawItems(id);
            assert.equal(result.data.items.length, expected.length);
            assert.ok(expected.length >= 5, "the recording should have recommendations");
            for (const item of expected) {
                const got: RecommendedItem | undefined = result.data.items.find((candidate) => candidate.id === item.id);
                assert.ok(got, "missing " + item.id);
                assert.equal(got.type, item.type);
                assert.equal(got.title, item.title);
                assert.equal(got.subtitle, item.subtitle === "" ? null : item.subtitle);
                assert.deepEqual(got.basedOn, [id]);
            }
            assert.deepEqual(stub.requested, [url(id)]);
        });
    }

    it("merges three liked ids: every recommendation once, with what led to it", async () => {
        const result = await newClient().getRecommendation({ basedOn: LIKED });
        assert.ok(result.ok);
        assert.deepEqual(stub.requested, LIKED.map((id) => url(id)));

        const expected = new Map<string, string[]>();
        for (const id of LIKED) {
            for (const item of rawItems(id)) {
                if (LIKED.includes(item.id)) continue;
                expected.set(item.id, [...(expected.get(item.id) ?? []), id]);
            }
        }
        assert.equal(result.data.items.length, expected.size);
        assert.equal(new Set(result.data.items.map((i) => i.id)).size, expected.size);
        for (const item of result.data.items) {
            assert.deepEqual(item.basedOn, expected.get(item.id), item.id);
        }
        const strengths = result.data.items.map((i) => i.basedOn.length);
        assert.deepEqual(strengths, [...strengths].sort((a, b) => b - a), "strongest matches first");
    });

    it("gives general recommendations for an id NRK does not know (NRK answers 200)", async () => {
        const result = await newClient().getRecommendation({ basedOn: ["DOESNOTEXIST"] });
        assert.ok(result.ok);
        assert.ok(result.data.items.length > 0);
    });

    it("rejects bad input without asking NRK", async () => {
        const bad: unknown[] = [
            {},
            { basedOn: [] },
            { basedOn: ["a", "b", "c", "d", "e", "f"] },
            { basedOn: [""] },
            { basedOn: "FFIL63000263" },
            { basedOn: [42] },
            { basedOn: ["FFIL63000263"], count: 7 },
            { basedOn: ["FFIL63000263"], count: "10" },
            null,
        ];
        for (const input of bad) {
            // @ts-expect-error deliberately wrong
            const result = await newClient().getRecommendation(input);
            assert.ok(!result.ok, JSON.stringify(input));
            assert.equal(result.error.code, "invalid_input", JSON.stringify(input));
        }
        assert.deepEqual(stub.requested, []);
    });
});

// ── merging rules, with a fake NRK ───────────────────────────────────

const rec = (id: string, type: "program" | "series" = "program", subtitle: string | null = "") => ({
    id,
    type,
    duration: "",
    name: id,
    brand: "b",
    image: null,
    title: "Title " + id,
    subtitle,
    images: [],
});

type Reply = { programs: ReturnType<typeof rec>[]; series: ReturnType<typeof rec>[] } | Error;
const fakeNrk = (replies: Record<string, Reply>, calls: Array<{ id: string; options: unknown }> = []) =>
    new NrkClient({
        nrk: {
            getRecommendation: async (id: string, options: unknown) => {
                calls.push({ id, options });
                const reply = replies[id];
                if (reply === undefined) throw new Error("unexpected " + id);
                if (reply instanceof Error) throw reply;
                return reply;
            },
        } as unknown as NrkLike,
        minIntervalMs: 0,
    });

describe("getRecommendation merging", () => {
    it("puts items recommended for several ids first, keeps NRK's order otherwise, leaves out the given ids", async () => {
        const client = fakeNrk({
            A: { programs: [rec("P1"), rec("P2"), rec("B")], series: [rec("S1", "series")] },
            B: { programs: [rec("P3"), rec("P2"), rec("A")], series: [rec("S1", "series")] },
        });
        const result = await client.getRecommendation({ basedOn: ["A", "B"] });
        assert.ok(result.ok);
        assert.deepEqual(
            result.data.items.map((i) => [i.id, i.basedOn]),
            [
                ["P2", ["A", "B"]],
                ["S1", ["A", "B"]],
                ["P1", ["A"]],
                ["P3", ["B"]],
            ],
        );
    });

    it("asks once per distinct id, with the count", async () => {
        const calls: Array<{ id: string; options: unknown }> = [];
        const client = fakeNrk({ A: { programs: [rec("P1")], series: [] } }, calls);
        const result = await client.getRecommendation({ basedOn: ["A", "A"], count: 5 });
        assert.ok(result.ok);
        assert.deepEqual(calls, [{ id: "A", options: { count: 5 } }]);
        assert.deepEqual(result.data.items.map((i) => i.basedOn), [["A"]]);

        const defaults: Array<{ id: string; options: unknown }> = [];
        await fakeNrk({ A: { programs: [], series: [] } }, defaults).getRecommendation({ basedOn: ["A"] });
        assert.deepEqual(defaults, [{ id: "A", options: { count: 10 } }]);
    });

    it("turns an empty or missing subtitle into null and keeps a real one", async () => {
        const client = fakeNrk({
            A: { programs: [rec("P1", "program", ""), rec("P2", "program", null), rec("P3", "program", "Del 2")], series: [] },
        });
        const result = await client.getRecommendation({ basedOn: ["A"] });
        assert.ok(result.ok);
        assert.deepEqual(result.data.items.map((i) => i.subtitle), [null, null, "Del 2"]);
    });

    it("reports the id that failed and still returns the others", async () => {
        const client = fakeNrk({
            A: new NrkHttpError(500, "u", null, null),
            B: { programs: [rec("P1")], series: [] },
        });
        const result = await client.getRecommendation({ basedOn: ["A", "B"] });
        assert.ok(result.ok);
        assert.deepEqual(result.data.items.map((i) => i.id), ["P1"]);
        assert.equal(result.data.failed.length, 1);
        assert.equal(result.data.failed[0]?.id, "A");
        assert.equal(result.data.failed[0]?.error.code, "upstream_error");
    });

    it("returns the error when every id fails", async () => {
        const client = fakeNrk({ A: new NrkHttpError(500, "u", null, null), B: new NrkHttpError(500, "u", null, null) });
        const result = await client.getRecommendation({ basedOn: ["A", "B"] });
        assert.ok(!result.ok);
        assert.equal(result.error.code, "upstream_error");
    });

    it("stops asking on 429", async () => {
        const calls: Array<{ id: string; options: unknown }> = [];
        const client = fakeNrk(
            {
                A: { programs: [rec("P1")], series: [] },
                B: new NrkHttpError(429, "u", null, 600),
                C: { programs: [rec("P2")], series: [] },
            },
            calls,
        );
        const result = await client.getRecommendation({ basedOn: ["A", "B", "C"] });
        assert.ok(result.ok);
        assert.deepEqual(calls.map((c) => c.id), ["A", "B"]);
        assert.equal(result.data.failed[0]?.error.code, "rate_limited");
        assert.equal(result.data.failed[0]?.error.retryAfterSeconds, 600);
        assert.deepEqual(result.data.items.map((i) => i.id), ["P1"]);
    });

    it("says invalid_response when NRK's data breaks the result type", async () => {
        const client = fakeNrk({ A: { programs: [rec("")], series: [] } });
        const result = await client.getRecommendation({ basedOn: ["A"] });
        assert.ok(!result.ok);
        assert.equal(result.error.code, "invalid_response");
    });
});
