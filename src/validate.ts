/**
 * A small validation toolkit with no dependencies.
 *
 * A validator is a plain function that reads an unknown value and returns it typed.
 * When the value is wrong it records an issue (with the path to the field) instead of
 * throwing, so one pass reports every problem. Combinators (object, array, union, ...)
 * build bigger validators from smaller ones, and the TypeScript type of the result is
 * inferred from how the validator is built:
 *
 *   const person = object({ name: string, age: optional(number) });
 *   type Person = Infer<typeof person>; // { name: string; age?: number | undefined }
 *
 *   parse(person, json); // typed Person, or throws NrkValidationError
 *
 * Like the schemas it replaces, object() keeps only the keys it knows about.
 */

import { NrkValidationError, formatIssues } from "./validation-error";
import type { Issue, Path } from "./validation-error";

export { NrkValidationError, formatIssues };
export type { Issue, Path };

/** Reads `input`, records problems in `issues`, and returns the typed value. */
export type Validator<T> = (input: unknown, path: Path, issues: Issue[]) => T;

/** A validator for a value that may be missing; object() makes its key optional. */
export type OptionalValidator<T> = Validator<T | undefined> & { readonly optionalKey: true };

export type Infer<V> = V extends (input: any, path: any, issues: any) => infer T ? T : never;

export const safeParse = <T>(
    validator: Validator<T>,
    input: unknown,
): { success: true; data: T } | { success: false; issues: Issue[] } => {
    const issues: Issue[] = [];
    const data = validator(input, [], issues);
    return issues.length === 0 ? { success: true, data } : { success: false, issues };
};

/** Returns the validated value, or throws NrkValidationError. `label` starts the error message. */
export const parse = <T>(validator: Validator<T>, input: unknown, label?: string): T => {
    const result = safeParse(validator, input);
    if (!result.success) {
        throw new NrkValidationError(result.issues, label);
    }
    return result.data;
};

// ── Primitives ──────────────────────────────────────────────────────

const describeValue = (value: unknown): string => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    if (typeof value === "string") return JSON.stringify(value.length > 30 ? value.slice(0, 30) + "..." : value);
    return typeof value;
};

const report = (issues: Issue[], path: Path, message: string): void => {
    issues.push({ path, message });
};

export const string: Validator<string> = (input, path, issues) => {
    if (typeof input === "string") return input;
    report(issues, path, `expected string, got ${describeValue(input)}`);
    return "";
};

export const number: Validator<number> = (input, path, issues) => {
    if (typeof input === "number" && Number.isFinite(input)) return input;
    report(issues, path, `expected number, got ${describeValue(input)}`);
    return 0;
};

export const boolean: Validator<boolean> = (input, path, issues) => {
    if (typeof input === "boolean") return input;
    report(issues, path, `expected boolean, got ${describeValue(input)}`);
    return false;
};

/** A string that parses as an absolute URL. */
export const url: Validator<string> = (input, path, issues) => {
    const text = string(input, path, issues);
    if (typeof input === "string") {
        try {
            new URL(text);
        } catch {
            report(issues, path, "expected a URL");
        }
    }
    return text;
};

export const nonEmptyString =
    (message = "must not be empty"): Validator<string> =>
    (input, path, issues) => {
        const text = string(input, path, issues);
        if (typeof input === "string" && text.length === 0) report(issues, path, message);
        return text;
    };

export const stringOf =
    (limits: { min?: number; max?: number; pattern?: RegExp; patternMessage?: string }): Validator<string> =>
    (input, path, issues) => {
        const text = string(input, path, issues);
        if (typeof input !== "string") return text;
        if (limits.min !== undefined && text.length < limits.min) {
            report(issues, path, `must be at least ${limits.min} character(s)`);
        }
        if (limits.max !== undefined && text.length > limits.max) {
            report(issues, path, `must be at most ${limits.max} characters`);
        }
        if (limits.pattern && !limits.pattern.test(text)) {
            report(issues, path, limits.patternMessage ?? `must match ${limits.pattern}`);
        }
        return text;
    };

export const positiveNumber =
    (message = "must be positive"): Validator<number> =>
    (input, path, issues) => {
        const n = number(input, path, issues);
        if (typeof input === "number" && Number.isFinite(input) && n <= 0) report(issues, path, message);
        return n;
    };

export const integer =
    (limits: { min?: number; max?: number } = {}): Validator<number> =>
    (input, path, issues) => {
        const n = number(input, path, issues);
        if (typeof input !== "number" || !Number.isFinite(input)) return n;
        if (!Number.isInteger(n)) report(issues, path, "expected an integer");
        else if (limits.min !== undefined && n < limits.min) report(issues, path, `must be at least ${limits.min}`);
        else if (limits.max !== undefined && n > limits.max) report(issues, path, `must be at most ${limits.max}`);
        return n;
    };

type Literal = string | number | boolean;

export const literal =
    <const T extends Literal>(value: T): Validator<T> =>
    (input, path, issues) => {
        if (input !== value) report(issues, path, `expected ${JSON.stringify(value)}, got ${describeValue(input)}`);
        return value;
    };

/**
 * Every member of a string-literal union, as a list. The compiler checks that the object
 * has exactly the members of the union, so the list cannot drift from the type:
 *
 *   type Color = "red" | "blue";
 *   const COLORS = allOf<Color>({ red: true, blue: true }); // [Color, ...Color[]]
 */
export const allOf = <T extends string>(members: Record<T, true>): [T, ...T[]] =>
    Object.keys(members) as [T, ...T[]];

/** One of several literal values: oneOf("a", "b") is typed "a" | "b". */
export const oneOf =
    <const T extends readonly [Literal, ...Literal[]]>(...values: T): Validator<T[number]> =>
    (input, path, issues) => {
        if (values.includes(input as Literal)) return input as T[number];
        report(
            issues,
            path,
            `expected one of ${values.map((x) => JSON.stringify(x)).join(" | ")}, got ${describeValue(input)}`,
        );
        return values[0];
    };

// ── Combinators ─────────────────────────────────────────────────────

export const array =
    <T>(
        item: Validator<T>,
        limits: { min?: number; max?: number; message?: string } = {},
    ): Validator<T[]> =>
    (input, path, issues) => {
        if (!Array.isArray(input)) {
            report(issues, path, `expected array, got ${describeValue(input)}`);
            return [];
        }
        if (limits.min !== undefined && input.length < limits.min) {
            report(issues, path, limits.message ?? `must have at least ${limits.min} item(s)`);
        }
        if (limits.max !== undefined && input.length > limits.max) {
            report(issues, path, `must have at most ${limits.max} items`);
        }
        return input.map((element, i) => item(element, [...path, i], issues));
    };

type Shape = Record<string, Validator<any>>;
type OptionalKeys<S extends Shape> = {
    [K in keyof S]: S[K] extends { readonly optionalKey: true } ? K : never;
}[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOf<S extends Shape> = Simplify<
    { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

/** An object with the given fields. Unknown keys are dropped, missing required keys are reported. */
export const object =
    <S extends Shape>(shape: S): Validator<ObjectOf<S>> =>
    (input, path, issues) => {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
            report(issues, path, `expected object, got ${describeValue(input)}`);
            return {} as ObjectOf<S>;
        }
        const record = input as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(shape)) {
            const value = (shape[key] as Validator<unknown>)(record[key], [...path, key], issues);
            if (value !== undefined) result[key] = value;
        }
        return result as ObjectOf<S>;
    };

const markOptional = <T>(validator: Validator<T | undefined>): OptionalValidator<T> =>
    Object.assign(validator, { optionalKey: true as const });

/** The field may be missing (undefined). */
export const optional = <T>(inner: Validator<T>): OptionalValidator<T> =>
    markOptional<T>((input, path, issues) => (input === undefined ? undefined : inner(input, path, issues)));

/** The value may be null. */
export const nullable =
    <T>(inner: Validator<T>): Validator<T | null> =>
    (input, path, issues) =>
        input === null ? null : inner(input, path, issues);

/** The value may be null, and the field may be missing. */
export const nullish = <T>(inner: Validator<T>): OptionalValidator<T | null> =>
    markOptional<T | null>((input, path, issues) =>
        input === undefined ? undefined : input === null ? null : inner(input, path, issues),
    );

/** Uses `fallback` when the value is missing. */
export const withDefault =
    <T>(inner: Validator<T>, fallback: T): Validator<T> =>
    (input, path, issues) =>
        input === undefined ? fallback : inner(input, path, issues);

/** Validates, then converts the value. `convert` only runs when validation passed. */
export const map =
    <A, B>(inner: Validator<A>, convert: (value: A) => B): Validator<B> =>
    (input, path, issues) => {
        const before = issues.length;
        const value = inner(input, path, issues);
        return (issues.length === before ? convert(value) : value) as B;
    };

/**
 * The first validator that accepts the value. If none does, the issues of the closest
 * one (fewest problems) are reported, which for tagged objects is the right variant.
 */
export const union =
    <const Vs extends readonly [Validator<any>, ...Validator<any>[]]>(
        ...variants: Vs
    ): Validator<Infer<Vs[number]>> =>
    (input, path, issues) => {
        let closest: Issue[] | undefined;
        for (const variant of variants) {
            const attempt: Issue[] = [];
            const value = variant(input, path, attempt);
            if (attempt.length === 0) return value;
            if (closest === undefined || attempt.length < closest.length) closest = attempt;
        }
        issues.push(...(closest ?? []));
        return undefined as Infer<Vs[number]>;
    };
