/**
 * Live tests - run against the real psapi.nrk.no with the ids in
 * test/fixtures/ids.json (a few hundred programs, films and series).
 *
 *   npm run test:live
 *
 * Requests are rate limited and cached on disk (.cache/http) so a rerun is cheap.
 * Optional environment variables:
 *   NRK_LIVE_LIMIT        max ids per group (default: all)
 *   NRK_LIVE_INTERVAL_MS  minimum ms between requests (default: 350)
 *
 * Content on NRK expires and moves, so "gone" errors (not_found, forbidden or not_playable)
 * are counted separately and only fail the run above a threshold.
 * Anything else - invalid responses, unexpected shapes - fails immediately.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { NrkClient } from "../../src/nrk-client";
import type { Episodes, Program, Result } from "../../src/types";
import { IdEntry, readIds } from "../support/fixtures";
import { installPoliteFetch } from "../support/polite-fetch";
import { isHttpUrl } from "../support/helpers";

const LIMIT = Number(process.env.NRK_LIVE_LIMIT) || Infinity;
const INTERVAL_MS = Number(process.env.NRK_LIVE_INTERVAL_MS) || 350;
const CONCURRENCY = 3;
const MAX_GONE_RATIO = 0.1;

const ids = readIds();
const limited = <T>(list: ReadonlyArray<T>) => list.slice(0, LIMIT);
const client = new NrkClient({ minIntervalMs: 0 }); // the polite fetch already paces requests

/** An error result, thrown so that runAll can count it. */
class ResultError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(`${code}: ${message}`);
    }
}
const unwrap = <T>(result: Result<T>): T => {
    if (!result.ok) throw new ResultError(result.error.code, result.error.message);
    return result.data;
};

type Outcome = { id: string; kind: "ok" | "gone" | "hard"; message: string };

const isGone = (code: string) => ["not_found", "forbidden", "not_playable"].includes(code);
const classify = (e: unknown): "gone" | "hard" => (e instanceof ResultError && isGone(e.code) ? "gone" : "hard");

const runAll = async <T extends { id: string }>(
    items: ReadonlyArray<T>,
    check: (item: T) => Promise<void>,
): Promise<Outcome[]> => {
    const outcomes: Outcome[] = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (next < items.length) {
                const i = next++;
                const item = items[i] as T;
                try {
                    await check(item);
                    outcomes[i] = { id: item.id, kind: "ok", message: "" };
                } catch (e) {
                    outcomes[i] = {
                        id: item.id,
                        kind: classify(e),
                        message: e instanceof Error ? e.message.slice(0, 300) : String(e),
                    };
                }
            }
        }),
    );
    return outcomes;
};

const assertOutcomes = (group: string, outcomes: Outcome[]) => {
    const hard = outcomes.filter((o) => o.kind === "hard");
    const gone = outcomes.filter((o) => o.kind === "gone");
    const summary = `${group}: ${outcomes.length} checked, ${gone.length} gone, ${hard.length} failed`;
    console.log("  " + summary);
    assert.equal(
        hard.length,
        0,
        `${summary}\n` +
            hard
                .slice(0, 10)
                .map((o) => `  ${o.id}: ${o.message}`)
                .join("\n"),
    );
    assert.ok(
        gone.length <= Math.max(1, outcomes.length * MAX_GONE_RATIO),
        `${summary} - too many items have gone away, refresh with \`npm run record\`.\n` +
            gone
                .slice(0, 10)
                .map((o) => `  ${o.id}: ${o.message}`)
                .join("\n"),
    );
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const checkPersonalizationFields = (x: {
    firstAired: string | null;
    contributors: ReadonlyArray<{ name: string; role: string }>;
}) => {
    assert.ok(x.firstAired === null || ISO_DATE.test(x.firstAired), "firstAired is " + x.firstAired);
    for (const c of x.contributors) {
        assert.ok(c.name.length > 0 && c.role.length > 0, "contributor " + JSON.stringify(c));
    }
};

const checkPicture = (imageUrl: string | null) => {
    assert.ok(imageUrl === null || isHttpUrl(imageUrl), "imageUrl is " + imageUrl);
};

const checkProgram = (p: Program) => {
    checkPersonalizationFields(p);
    assert.ok(p.seriesId === null || p.seriesId.length > 0, "seriesId");
    assert.ok(p.title.length > 0, "title");
    checkPicture(p.imageUrl);
    assert.ok(p.durationSeconds > 0, "duration");
    assert.ok(p.category.length > 0, "category");
    assert.ok(p.productionYear === null || Number.isInteger(p.productionYear), "productionYear is " + p.productionYear);
    assert.ok(["coming", "available", "expires", "expired", "notAvailableOnline"].includes(p.status));
};

const checkPlayableProgram = async (id: string) => {
    const program = unwrap(await client.getProgram({ id }));
    checkProgram(program);
    // playback is only meaningful while the program can be played
    const playback = unwrap(await client.getPlayback({ id }));
    assert.equal(playback.id, id);
    assert.ok(playback.title.length > 0, "playback title");
    assert.ok(isHttpUrl(playback.streamUrl), "streamUrl");
    checkPicture(playback.posterUrl);
    return program;
};

const checkEpisodes = (result: Episodes) => {
    for (const e of result.episodes) {
        checkPersonalizationFields(e);
        assert.ok(e.id.length > 0, "id");
        assert.ok(e.title.length > 0, "episode title");
        assert.ok(e.durationSeconds > 0, "episode duration");
        checkPicture(e.imageUrl);
        for (const n of [e.productionYear, e.episodeNumber]) {
            assert.ok(n === null || Number.isInteger(n), "number is " + n);
        }
    }
};

describe("live: psapi.nrk.no", () => {
    let restore: () => void;
    before(() => {
        restore = installPoliteFetch({
            minIntervalMs: INTERVAL_MS,
            cacheDir: path.resolve(__dirname, "../../../.cache/http"),
            log: (m) => console.log("  " + m),
        });
    });
    after(() => restore());

    it("lists thousands of programs and series across the whole alphabet", async () => {
        const catalog = unwrap(await client.listCatalog());
        const programs = catalog.items.filter((i) => i.type === "program");
        const series = catalog.items.filter((i) => i.type === "series");
        console.log(`  catalog: ${programs.length} programs, ${series.length} series`);
        assert.deepEqual(catalog.failed, []);
        assert.ok(programs.length > 5000, "programs: " + programs.length);
        assert.ok(series.length > 3000, "series: " + series.length);
        const keys = catalog.items.map((i) => i.type + ":" + i.id);
        assert.equal(new Set(keys).size, keys.length, "every item is listed once");
    });

    it(`available programs (${limited(ids.programs.available).length})`, async () => {
        const outcomes = await runAll(limited(ids.programs.available), async (p: IdEntry) => {
            const program = await checkPlayableProgram(p.id);
            assert.equal(program.id, p.id);
        });
        assertOutcomes("available programs", outcomes);
    });

    it(`films (${limited(ids.programs.films).length})`, async () => {
        const outcomes = await runAll(limited(ids.programs.films), async (f) => {
            const program = await checkPlayableProgram(f.id);
            assert.ok(program.durationSeconds >= 60 * 60, `film is only ${program.durationSeconds}s`);
        });
        assertOutcomes("films", outcomes);
    });

    it(`geoblocked programs (${limited(ids.programs.geoblocked).length})`, async () => {
        const outcomes = await runAll(limited(ids.programs.geoblocked), async (p) => {
            checkProgram(unwrap(await client.getProgram({ id: p.id })));
        });
        assertOutcomes("geoblocked programs", outcomes);
    });

    it(`expired / upcoming programs (${limited(ids.programs.unavailable).length})`, async () => {
        const outcomes = await runAll(limited(ids.programs.unavailable), async (p) => {
            const program = unwrap(await client.getProgram({ id: p.id }));
            checkProgram(program);
            // an unavailable program must fail cleanly: not_found or not_playable, never an invalid response
            if (program.status === "available") {
                return; // it became available since the recording
            }
            const playback = await client.getPlayback({ id: p.id });
            assert.ok(!playback.ok, "playback of an unavailable program");
            assert.ok(isGone(playback.error.code), "expected not_found or not_playable, got " + playback.error.code);
        });
        assertOutcomes("unavailable programs", outcomes);
    });

    it("list the catalog -> series -> episodes available today", async () => {
        const today = new Date().toISOString().slice(0, 10);

        const catalog = unwrap(await client.listCatalog());
        assert.ok(catalog.items.length > 10000, "catalog size " + catalog.items.length);

        const candidates = catalog.items
            .filter((i) => i.type === "series" && i.availableNow && !i.geoBlocked)
            .filter((i) => /natur|dyr|dokumentar/i.test(i.title + " " + i.description))
            .slice(0, 5);
        assert.ok(candidates.length > 0, "expected series matching the keywords");

        let withEpisodes = 0;
        for (const item of candidates) {
            const series = unwrap(await client.getSeries({ id: item.id }));
            const season = series.seasons[0];
            if (!season) continue;
            const result = unwrap(await client.getEpisodes({ seriesId: item.id, seasonName: season.name, availableOn: today }));
            for (const episode of result.episodes) {
                assert.ok(episode.durationMinutes >= 0 && episode.id.length > 0);
                assert.ok(episode.availableTo === null || episode.availableTo.slice(0, 10) >= today);
            }
            withEpisodes += result.episodes.length > 0 ? 1 : 0;
        }
        assert.ok(withEpisodes > 0, "at least one series should have episodes available today");
    });

    for (const type of ["standard", "sequential", "news"] as const) {
        const group = limited(ids.series[type]);
        it(`${type} series (${group.length})`, async () => {
            const outcomes = await runAll(group, async (s) => {
                const series = unwrap(await client.getSeries({ id: s.id }));
                assert.equal(series.seriesType, type);
                assert.ok(series.title.length > 0, "title");
                checkPicture(series.imageUrl);
                assert.ok(series.seasons.length > 0, "seasons");

                const season = series.seasons[0];
                assert.ok(season, "first season");
                checkEpisodes(unwrap(await client.getEpisodes({ seriesId: s.id, seasonName: season.name })));
            });
            assertOutcomes(`${type} series`, outcomes);
        });
    }
});
