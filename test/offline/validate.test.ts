import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as v from "../../src/validate";

/** The messages of every issue, as "path: message". */
const issuesOf = <T>(validator: v.Validator<T>, input: unknown): string[] => {
    const result = v.safeParse(validator, input);
    return result.success
        ? []
        : result.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "input"}: ${i.message}`);
};
const accepts = <T>(validator: v.Validator<T>, input: unknown) => v.safeParse(validator, input).success;

describe("primitives", () => {
    it("string, number and boolean accept only their own type", () => {
        assert.ok(accepts(v.string, "") && accepts(v.number, 0) && accepts(v.boolean, false));
        assert.deepEqual(issuesOf(v.string, 1), ["input: expected string, got number"]);
        assert.deepEqual(issuesOf(v.string, null), ["input: expected string, got null"]);
        assert.deepEqual(issuesOf(v.string, undefined), ["input: expected string, got undefined"]);
        assert.deepEqual(issuesOf(v.number, "1"), ['input: expected number, got "1"']);
        assert.deepEqual(issuesOf(v.boolean, "true"), ['input: expected boolean, got "true"']);
    });

    it("numbers must be finite", () => {
        for (const bad of [NaN, Infinity, -Infinity]) {
            assert.ok(!accepts(v.number, bad), String(bad));
        }
        assert.ok(accepts(v.number, -1.5));
    });

    it("nonEmptyString uses the given message", () => {
        assert.ok(accepts(v.nonEmptyString(), "x"));
        assert.deepEqual(issuesOf(v.nonEmptyString(), ""), ["input: must not be empty"]);
        assert.deepEqual(issuesOf(v.nonEmptyString("Id can not be empty."), ""), ["input: Id can not be empty."]);
        assert.deepEqual(issuesOf(v.nonEmptyString(), 5), ["input: expected string, got number"]);
    });

    it("stringOf checks length and pattern", () => {
        const s = v.stringOf({ min: 2, max: 4, pattern: /^[a-z]+$/, patternMessage: "letters only" });
        assert.ok(accepts(s, "abc"));
        assert.deepEqual(issuesOf(s, "a"), ["input: must be at least 2 character(s)"]);
        assert.deepEqual(issuesOf(s, "abcde"), ["input: must be at most 4 characters"]);
        assert.deepEqual(issuesOf(s, "ab1"), ["input: letters only"]);
    });

    it("url accepts absolute URLs only", () => {
        assert.ok(accepts(v.url, "https://gfx.nrk.no/x"));
        assert.deepEqual(issuesOf(v.url, "not a url"), ["input: expected a URL"]);
    });

    it("positiveNumber rejects zero and negatives", () => {
        assert.ok(accepts(v.positiveNumber(), 0.1));
        assert.deepEqual(issuesOf(v.positiveNumber(), 0), ["input: must be positive"]);
        assert.deepEqual(issuesOf(v.positiveNumber("Has to be > 0"), -1), ["input: Has to be > 0"]);
    });

    it("integer checks whole numbers and bounds", () => {
        const n = v.integer({ min: 1, max: 50 });
        assert.ok(accepts(n, 1) && accepts(n, 50));
        assert.deepEqual(issuesOf(n, 0), ["input: must be at least 1"]);
        assert.deepEqual(issuesOf(n, 51), ["input: must be at most 50"]);
        assert.deepEqual(issuesOf(n, 1.5), ["input: expected an integer"]);
        assert.deepEqual(issuesOf(n, "1"), ['input: expected number, got "1"']);
        assert.ok(accepts(v.integer(), -7));
    });

    it("literal and oneOf accept only the listed values", () => {
        assert.ok(accepts(v.literal("HLS"), "HLS"));
        assert.deepEqual(issuesOf(v.literal("HLS"), "MP4"), ['input: expected "HLS", got "MP4"']);
        const status = v.oneOf("coming", "available");
        assert.ok(accepts(status, "coming"));
        assert.deepEqual(issuesOf(status, "gone"), ['input: expected one of "coming" | "available", got "gone"']);
        assert.deepEqual(issuesOf(status, 1), ['input: expected one of "coming" | "available", got number']);
    });

    it("long strings are shortened in messages", () => {
        const [message] = issuesOf(v.number, "x".repeat(200));
        assert.ok(message !== undefined && message.length < 80);
    });
});

describe("array", () => {
    it("validates every item and reports the index in the path", () => {
        assert.deepEqual(issuesOf(v.array(v.number), [1, "b", 3, null]), [
            '1: expected number, got "b"',
            "3: expected number, got null",
        ]);
        assert.deepEqual(issuesOf(v.array(v.number), "nope"), ['input: expected array, got "nope"']);
    });

    it("min, max and a custom empty message", () => {
        assert.deepEqual(issuesOf(v.array(v.string, { min: 1 }), []), ["input: must have at least 1 item(s)"]);
        assert.deepEqual(issuesOf(v.array(v.string, { min: 1, message: "Image-array should not be empty" }), []), [
            "input: Image-array should not be empty",
        ]);
        assert.deepEqual(issuesOf(v.array(v.string, { max: 2 }), ["a", "b", "c"]), ["input: must have at most 2 items"]);
    });
});

describe("object", () => {
    const person = v.object({
        name: v.string,
        age: v.optional(v.number),
        nick: v.nullish(v.string),
        city: v.nullable(v.string),
    });

    it("returns only the known keys", () => {
        const parsed = v.parse(person, { name: "Kari", city: null, extra: "dropped", more: { a: 1 } });
        assert.deepEqual(parsed, { name: "Kari", city: null });
        assert.ok(!("extra" in parsed));
    });

    it("keeps optional keys absent when missing, and null when null", () => {
        assert.deepEqual(v.parse(person, { name: "K", city: "Oslo" }), { name: "K", city: "Oslo" });
        assert.deepEqual(v.parse(person, { name: "K", city: "Oslo", nick: null, age: 3 }), {
            name: "K",
            city: "Oslo",
            nick: null,
            age: 3,
        });
    });

    it("reports missing required keys with the full path", () => {
        assert.deepEqual(issuesOf(person, {}), [
            "name: expected string, got undefined",
            "city: expected string, got undefined",
        ]);
    });

    it("distinguishes optional, nullable and nullish", () => {
        assert.ok(accepts(v.object({ a: v.optional(v.string) }), {}));
        assert.ok(!accepts(v.object({ a: v.optional(v.string) }), { a: null }));
        assert.ok(!accepts(v.object({ a: v.nullable(v.string) }), {}));
        assert.ok(accepts(v.object({ a: v.nullable(v.string) }), { a: null }));
        assert.ok(accepts(v.object({ a: v.nullish(v.string) }), {}));
        assert.ok(accepts(v.object({ a: v.nullish(v.string) }), { a: null }));
        assert.ok(!accepts(v.object({ a: v.nullish(v.string) }), { a: 1 }));
    });

    it("rejects things that are not objects", () => {
        for (const bad of [null, undefined, "x", 1, [], [{}]]) {
            assert.ok(!accepts(person, bad), JSON.stringify(bad));
        }
        assert.deepEqual(issuesOf(person, [1]), ["input: expected object, got array"]);
    });

    it("nests, and paths go through arrays", () => {
        const schema = v.object({
            _embedded: v.object({ episodes: v.array(v.object({ id: v.nonEmptyString() })) }),
        });
        assert.deepEqual(issuesOf(schema, { _embedded: { episodes: [{ id: "a" }, { id: "" }, {}] } }), [
            "_embedded.episodes.1.id: must not be empty",
            "_embedded.episodes.2.id: expected string, got undefined",
        ]);
    });

    it("has the right TypeScript type (checked by tsc)", () => {
        type Person = v.Infer<typeof person>;
        const minimal: Person = { name: "x", city: null };
        const full: Person = { name: "x", city: "y", age: 1, nick: null };
        // @ts-expect-error name is required
        const noName: Person = { city: null };
        // @ts-expect-error age must be a number
        const badAge: Person = { name: "x", city: null, age: "1" };
        assert.ok(minimal && full && noName && badAge);
    });
});

describe("withDefault, map and union", () => {
    it("withDefault fills in only when the value is missing", () => {
        const limit = v.withDefault(v.integer({ min: 1 }), 20);
        assert.equal(v.parse(limit, undefined), 20);
        assert.equal(v.parse(limit, 5), 5);
        assert.deepEqual(issuesOf(limit, 0), ["input: must be at least 1"]);
        assert.deepEqual(issuesOf(limit, null), ["input: expected number, got null"]);
        assert.deepEqual(v.parse(v.object({ limit }), {}), { limit: 20 });
    });

    it("map converts valid values and does not run on invalid ones", () => {
        let calls = 0;
        const doubled = v.map(v.number, (n) => {
            calls++;
            return n * 2;
        });
        assert.equal(v.parse(doubled, 4), 8);
        assert.equal(calls, 1);
        assert.ok(!accepts(doubled, "4"));
        assert.equal(calls, 1, "convert must not run on invalid input");
    });

    it("map is how image lists are reshaped", () => {
        const images = v.map(
            v.array(v.object({ uri: v.string, width: v.number }), { min: 1 }),
            (list) => list.map((i) => ({ url: i.uri, width: i.width })),
        );
        assert.deepEqual(v.parse(images, [{ uri: "u", width: 1, extra: true }]), [{ url: "u", width: 1 }]);
    });

    it("union returns the first variant that matches", () => {
        const u = v.union(v.string, v.number);
        assert.equal(v.parse(u, "a"), "a");
        assert.equal(v.parse(u, 1), 1);
        assert.ok(!accepts(u, true));
    });

    it("union reports the closest variant, which is the tagged one for tagged objects", () => {
        const series = v.union(
            v.object({ kind: v.literal("news"), news: v.object({ title: v.string }) }),
            v.object({ kind: v.literal("standard"), standard: v.object({ title: v.string }) }),
        );
        assert.ok(accepts(series, { kind: "standard", standard: { title: "x" } }));
        // wrong content inside the "standard" variant: only that variant's problems are shown
        assert.deepEqual(issuesOf(series, { kind: "standard", standard: { title: 1 } }), [
            'standard.title: expected string, got number',
        ]);
        assert.ok(issuesOf(series, { kind: "other" }).length >= 1);
    });

    it("the union type is inferred (checked by tsc)", () => {
        const u = v.union(v.object({ t: v.literal("a"), a: v.number }), v.object({ t: v.literal("b"), b: v.string }));
        const value = v.parse(u, { t: "a", a: 1 });
        if (value.t === "a") {
            const n: number = value.a;
            assert.equal(n, 1);
        } else {
            const s: string = value.b;
            assert.fail(s);
        }
    });
});

describe("allOf", () => {
    it("lists the members of a union, and the compiler keeps the list complete", () => {
        type Color = "red" | "blue";
        const colors = v.allOf<Color>({ red: true, blue: true });
        assert.deepEqual([...colors].sort(), ["blue", "red"]);
        // @ts-expect-error a member is missing
        v.allOf<Color>({ red: true });
        // @ts-expect-error a member that is not in the union
        v.allOf<Color>({ red: true, blue: true, green: true });
        assert.ok(accepts(v.oneOf(...colors), "red"));
        assert.ok(!accepts(v.oneOf(...colors), "green"));
    });
});

describe("parse and errors", () => {
    it("parse throws NrkValidationError with the issues", () => {
        assert.throws(
            () => v.parse(v.object({ id: v.string }), { id: 1 }),
            (e: unknown) => {
                assert.ok(e instanceof v.NrkValidationError);
                assert.ok(e instanceof Error);
                assert.equal(e.name, "NrkValidationError");
                assert.equal(e.issues.length, 1);
                assert.deepEqual(e.issues[0]?.path, ["id"]);
                assert.match(e.message, /Unexpected response shape - id: expected string, got number/);
                return true;
            },
        );
    });

    it("messages stay short however many problems there are", () => {
        const many = Array.from({ length: 500 }, () => 1);
        const result = v.safeParse(v.array(v.string), many);
        assert.ok(!result.success);
        assert.equal(result.issues.length, 500);
        const message = v.formatIssues(result.issues);
        assert.match(message, /\(\+495 more\)$/);
        assert.ok(message.length < 400);
    });

    it("safeParse returns data on success", () => {
        const result = v.safeParse(v.number, 3);
        assert.deepEqual(result, { success: true, data: 3 });
    });

    it("never throws while validating, whatever it is given", () => {
        const schema = v.object({
            a: v.array(v.object({ b: v.union(v.string, v.nullable(v.number)) })),
            c: v.optional(v.oneOf("x", "y")),
        });
        const weird = [undefined, null, 0, NaN, "", [], {}, { a: null }, { a: [null] }, { a: [{ b: {} }] }, Symbol("s"), () => 1];
        for (const input of weird) {
            assert.doesNotThrow(() => v.safeParse(schema, input));
        }
    });
});
