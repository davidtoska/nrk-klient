/** The error type that validation reports. Kept apart from the validators so it can be exported alone. */

export type Path = ReadonlyArray<string | number>;

/** One thing wrong with a value: where (`path`, from the root) and what. */
export interface Issue {
    readonly path: Path;
    readonly message: string;
}

export const formatIssues = (issues: ReadonlyArray<Issue>, max = 5): string => {
    const shown = issues
        .slice(0, max)
        .map((i) => `${i.path.length > 0 ? i.path.join(".") : "input"}: ${i.message}`);
    const rest = issues.length - max;
    return shown.join("; ") + (rest > 0 ? ` (+${rest} more)` : "");
};

/**
 * Thrown when a value does not have the expected shape: a response from NRK, or a value one
 * of the clients was about to return. `issues` lists every offending field.
 */
export class NrkValidationError extends Error {
    constructor(
        readonly issues: ReadonlyArray<Issue>,
        label = "Unexpected response shape",
    ) {
        super(label + " - " + formatIssues(issues));
        this.name = "NrkValidationError";
    }
}
