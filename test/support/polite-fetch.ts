import * as fs from "node:fs";
import * as path from "node:path";
import { fileNameForUrl } from "./fixtures";

export interface PoliteFetchOptions {
    /** Minimum time between the start of two requests. */
    readonly minIntervalMs: number;
    /** How many times a 429 is retried before giving up. */
    readonly maxRetries?: number;
    /** Upper bound for a single Retry-After wait. */
    readonly maxWaitSeconds?: number;
    /** When set, 200/400/404 responses are cached on disk and reused. */
    readonly cacheDir?: string;
    readonly log?: (message: string) => void;
}

const CACHEABLE = new Set([200, 400, 404]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Replaces global fetch with a rate-limited version that
 *  - spaces requests at least minIntervalMs apart (across all callers),
 *  - pauses *all* requests when the API answers 429 and honours Retry-After,
 *  - optionally caches responses on disk so reruns do not hit the API.
 *
 * Returns a function that restores the original fetch.
 */
export function installPoliteFetch(options: PoliteFetchOptions): () => void {
    const original = globalThis.fetch;
    const maxRetries = options.maxRetries ?? 2;
    const maxWaitMs = (options.maxWaitSeconds ?? 660) * 1000;
    let nextStart = 0;
    let requests = 0;
    let cacheHits = 0;

    const reserveSlot = async () => {
        const now = Date.now();
        const start = Math.max(now, nextStart);
        nextStart = start + options.minIntervalMs;
        if (start > now) {
            await sleep(start - now);
        }
    };

    const cacheFile = (url: string) =>
        options.cacheDir
            ? path.join(options.cacheDir, fileNameForUrl(url))
            : null;

    globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;

        const file = cacheFile(url);
        if (file && fs.existsSync(file)) {
            const cached = JSON.parse(fs.readFileSync(file, "utf8")) as {
                status: number;
                text: string;
            };
            cacheHits++;
            return new Response(cached.text, { status: cached.status });
        }

        for (let attempt = 0; ; attempt++) {
            await reserveSlot();
            requests++;
            const response = await original(url);
            if (response.status === 429 && attempt < maxRetries) {
                const seconds = Number(response.headers.get("retry-after")) || 60;
                const waitMs = Math.min(seconds * 1000, maxWaitMs) + 1000;
                options.log?.(
                    `429 from NRK - pausing all requests for ${Math.round(waitMs / 1000)}s ` +
                        `(retry ${attempt + 1}/${maxRetries})`,
                );
                nextStart = Math.max(nextStart, Date.now() + waitMs);
                continue;
            }
            if (file && CACHEABLE.has(response.status)) {
                const text = await response.clone().text();
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(
                    file,
                    JSON.stringify({ status: response.status, text }),
                );
            }
            return response;
        }
    }) as typeof fetch;

    return () => {
        globalThis.fetch = original;
        options.log?.(
            `polite-fetch: ${requests} network requests, ${cacheHits} cache hits`,
        );
    };
}
