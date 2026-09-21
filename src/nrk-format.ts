import type { NrkContributor } from "./nrk-response";

/**
 * Small pure helpers for turning NRK's display strings into data.
 * Kept separate from the client so they can be tested on real strings.
 */

const MONTHS = [
    "januar",
    "februar",
    "mars",
    "april",
    "mai",
    "juni",
    "juli",
    "august",
    "september",
    "oktober",
    "november",
    "desember",
];

const isoDate = (year: number, month: number, day: number): string | null => {
    if (year < 1900 || year > 2100) {
        return null;
    }
    // rejects impossible dates such as 31. februar
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day
    ) {
        return null;
    }
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
};

const parseOne = (text: string): string | null => {
    // "29.11.2019"
    const numeric = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text.trim());
    if (numeric) {
        return isoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
    }
    // "NRK1 · mandag 11. desember 1995 kl. 00:00"
    const long = /(\d{1,2})\.\s+(\p{L}+)\s+(\d{4})/u.exec(text);
    if (long) {
        const month = MONTHS.indexOf((long[2] ?? "").toLowerCase());
        if (month >= 0) {
            return isoDate(Number(long[3]), month + 1, Number(long[1]));
        }
    }
    return null;
};

/**
 * The date a program was first broadcast on NRK, as YYYY-MM-DD, from the first
 * candidate string that can be read. null when none can.
 * (The time of day NRK sends is unreliable for old programs, so it is dropped.)
 */
export const parseFirstAired = (
    ...candidates: ReadonlyArray<string | null | undefined>
): string | null => {
    for (const candidate of candidates) {
        if (!candidate) continue;
        const date = parseOne(candidate);
        if (date) return date;
    }
    return null;
};

/** "/tv/catalog/series/muhammad-ali" -> "muhammad-ali" */
export const seriesIdFromHref = (href: string | null | undefined): string | null => {
    if (!href) return null;
    const path = href.split(/[?#]/)[0] ?? "";
    const id = path.split("/").filter(Boolean).pop();
    return id ? decodeURIComponent(id) : null;
};

/**
 * The program page groups people by role ({ role, name: [..] }); episodes list
 * them flat. Both end up as one flat list, in NRK's order, without empty names.
 */
export const flattenContributors = (
    groups: ReadonlyArray<{ role: string; name: ReadonlyArray<string> }> | null | undefined,
): NrkContributor[] => {
    const people: NrkContributor[] = [];
    for (const group of groups ?? []) {
        for (const name of group.name) {
            const trimmed = name.trim();
            if (trimmed) people.push({ name: trimmed, role: group.role });
        }
    }
    return people;
};

/** "PT1H2M3S" -> 3723. Null for anything that is not an ISO 8601 duration. */
export const parseIsoDuration = (text: string): number | null => {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
    if (!m || text === "P" || text.endsWith("T")) {
        return null;
    }
    const [, d, h, min, sec] = m;
    return Math.round(
        Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(sec ?? 0),
    );
};
