import { readRecorded } from "./fixtures";

export interface FetchStub {
    /** Every URL requested while the stub was installed, in order. */
    readonly requested: string[];
    restore(): void;
}

function urlOf(input: string | URL | Request): string {
    return typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
}

/** Replaces global fetch with a custom handler. */
export function installFetchMock(
    handler: (url: string) => Response | Promise<Response>,
): FetchStub {
    const original = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = urlOf(input);
        requested.push(url);
        return handler(url);
    }) as typeof fetch;
    return {
        requested,
        restore() {
            globalThis.fetch = original;
        },
    };
}

/**
 * Serves recorded responses from test/fixtures/raw.
 * Unknown URLs fail loudly, so tests never silently hit the network.
 */
export function installFetchStub(): FetchStub {
    return installFetchMock((url) => {
        const recorded = readRecorded(url);
        if (!recorded) {
            throw new Error(
                "No recorded fixture for URL: " +
                    url +
                    " (run `npm run record` to update fixtures)",
            );
        }
        const body =
            recorded.json !== undefined
                ? JSON.stringify(recorded.json)
                : (recorded.text ?? "");
        return new Response(body, { status: recorded.status });
    });
}

/** Answers every request with an empty JSON array. */
export function installEmptyListStub(): FetchStub {
    return installFetchMock(() => new Response("[]", { status: 200 }));
}
