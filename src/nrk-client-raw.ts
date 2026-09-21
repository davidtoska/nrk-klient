/** A request that has not answered within this time fails with a TimeoutError. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Set by the package build; "dev" when running from source. */
declare const __NRK_KLIENT_VERSION__: string | undefined;
const VERSION = typeof __NRK_KLIENT_VERSION__ === "string" ? __NRK_KLIENT_VERSION__ : "dev";
const USER_AGENT = `narko-klient/${VERSION} (+https://github.com/davidtoska/nrk-klient)`;

/**
 * Thrown when psapi.nrk.no answers with a non-2xx status.
 * The body is kept as-is (parsed JSON when possible, otherwise text).
 * retryAfterSeconds is set from the Retry-After header (typically on 429).
 */
export class NrkHttpError extends Error {
    constructor(
        readonly status: number,
        readonly url: string,
        readonly body: unknown,
        readonly retryAfterSeconds: number | null = null,
    ) {
        super(`NRK API responded ${status} for ${url}`);
        this.name = "NrkHttpError";
    }
}

/** Retry-After is either a number of seconds or an HTTP date. */
export const parseRetryAfter = (header: string | null, now = Date.now()): number | null => {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return seconds > 0 ? seconds : null;
    }
    const at = Date.parse(header);
    if (Number.isNaN(at)) return null;
    const wait = Math.ceil((at - now) / 1000);
    return wait > 0 ? wait : null;
};

/** GET a URL and return the JSON body (the text when it is not JSON). Throws NrkHttpError on non-2xx. */
export const fetchJson = async (url: string): Promise<unknown> => {
    const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        // keep the text as body
    }
    if (!response.ok) {
        throw new NrkHttpError(response.status, url, body, parseRetryAfter(response.headers.get("retry-after")));
    }
    return body;
};
