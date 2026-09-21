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
 * Content on NRK expires and moves, so "gone" errors (403/404/410 or "not
 * playable") are counted separately and only fail the run above a threshold.
 * Anything else - validation errors, unexpected shapes - fails immediately.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { NRK } from "../../src/client";
import { NrkHttpError } from "../../src/nrk-client-raw";
import type { ProgramById, SeasonsWithEpisodes } from "../../src/nrk-response";
import { IdEntry, readIds } from "../support/fixtures";
import { installPoliteFetch } from "../support/polite-fetch";
import { isHttpUrl } from "../support/helpers";
import { AiClient } from "../../src/ai-client";

const LIMIT = Number(process.env.NRK_LIVE_LIMIT) || Infinity;
const INTERVAL_MS = Number(process.env.NRK_LIVE_INTERVAL_MS) || 350;
const CONCURRENCY = 3;
const MAX_GONE_RATIO = 0.1;

const ids = readIds();
const limited = <T>(list: ReadonlyArray<T>) => list.slice(0, LIMIT);

type Outcome = { id: string; kind: "ok" | "gone" | "hard"; message: string };

const classify = (e: unknown): "gone" | "hard" => {
    if (e instanceof NrkHttpError && [403, 404, 410].includes(e.status)) {
        return "gone";
    }
    if (e instanceof Error && /Missing (playable|availability)/.test(e.message)) {
        return "gone";
    }
    return "hard";
};

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

const checkProgramPage = (p: ProgramById) => {
    checkPersonalizationFields(p);
    assert.ok(p.seriesId === null || p.seriesId.length > 0, "seriesId");
    assert.ok(p.title.length > 0, "title");
    assert.equal(typeof p.subtitle, "string");
    assert.ok(p.images.length > 0, "images");
    assert.ok(p.images.every((i) => isHttpUrl(i.url) && i.width > 0), "image urls");
    assert.ok(p.durationInSeconds > 0, "duration");
    assert.ok(p.category.length > 0, "category");
    assert.ok(
        p.productionYear === null || Number.isInteger(p.productionYear),
        "productionYear is " + p.productionYear,
    );
    assert.ok(
        ["coming", "available", "expires", "expired", "notAvailableOnline"].includes(
            p.availabilityStatus,
        ),
    );
};

const checkPlayableProgram = async (id: string) => {
    const program = await NRK.getProgramById(id);
    checkProgramPage(program);
    // playback endpoints are only meaningful while the program can be played
    const meta = await NRK.getMetadata(id);
    assert.equal(meta.prfId, id);
    assert.ok(meta.title.length > 0, "metadata title");
    assert.ok(meta.images.every((i) => isHttpUrl(i.url)));
    const manifest = await NRK.getManifest(id);
    assert.equal(manifest.format, "HLS");
    assert.ok(isHttpUrl(manifest.playUrl), "playUrl");
    return program;
};

const checkEpisodes = (result: SeasonsWithEpisodes) => {
    for (const e of result.episodes) {
        checkPersonalizationFields(e);
        assert.ok(e.prfId.length > 0, "prfId");
        assert.ok(e.title.length > 0, "episode title");
        assert.ok(e.durationInSeconds > 0, "episode duration");
        assert.ok(e.images.every((i) => isHttpUrl(i.url)), "episode image urls");
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
        const all = await NRK.getAllLetters();
        console.log(`  letters: ${all.programs.length} programs, ${all.series.length} series`);
        assert.ok(all.programs.length > 5000, "programs: " + all.programs.length);
        assert.ok(all.series.length > 3000, "series: " + all.series.length);
        assert.ok(all.letter.includes("w"), "letter w is part of the alphabet");
        const programIds = new Set(all.programs.map((p) => p.id));
        assert.equal(programIds.size, all.programs.length, "program ids are unique");
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
            assert.ok(
                program.durationInSeconds >= 60 * 60,
                `film is only ${program.durationInSeconds}s`,
            );
        });
        assertOutcomes("films", outcomes);
    });

    it(`geoblocked programs (${limited(ids.programs.geoblocked).length})`, async () => {
        const outcomes = await runAll(limited(ids.programs.geoblocked), async (p) => {
            checkProgramPage(await NRK.getProgramById(p.id));
        });
        assertOutcomes("geoblocked programs", outcomes);
    });

    it(`expired / upcoming programs (${limited(ids.programs.unavailable).length})`, async () => {
        const outcomes = await runAll(limited(ids.programs.unavailable), async (p) => {
            const program = await NRK.getProgramById(p.id);
            checkProgramPage(program);
            // an unavailable program must fail cleanly: 404 or "Missing playable", never a parse error
            if (program.availabilityStatus === "available") {
                return; // it became available since the recording
            }
            await assert.rejects(NRK.getManifest(p.id), (e: unknown) => classify(e) === "gone");
        });
        assertOutcomes("unavailable programs", outcomes);
    });

    it("AiClient: list the catalog -> series -> episodes available today", async () => {
        const ai = new AiClient({ minIntervalMs: 0 }); // the polite fetch already paces requests
        const today = new Date().toISOString().slice(0, 10);

        const catalog = await ai.listCatalog();
        assert.ok(catalog.ok, JSON.stringify(catalog));
        assert.deepEqual(catalog.data.failed, []);
        assert.ok(catalog.data.items.length > 10000, "catalog size " + catalog.data.items.length);
        const ids = catalog.data.items.map((i) => i.type + ":" + i.id);
        assert.equal(new Set(ids).size, ids.length, "every item is listed once");

        // NRK has no search: picking content is done on the listing
        const candidates = catalog.data.items
            .filter((i) => i.type === "series" && i.availableNow && !i.geoBlocked)
            .filter((i) => /natur|dyr|dokumentar/i.test(i.title + " " + i.description))
            .slice(0, 5);
        assert.ok(candidates.length > 0, "expected series matching the keywords");

        let withEpisodes = 0;
        for (const item of candidates) {
            const series = await ai.getSeries({ seriesId: item.id });
            assert.ok(series.ok, item.id + ": " + JSON.stringify(series));
            const season = series.data.seasons[0];
            if (!season) continue;
            const result = await ai.getEpisodes({ seriesId: item.id, seasonName: season.name, availableOn: today });
            assert.ok(result.ok, item.id + ": " + JSON.stringify(result));
            for (const episode of result.data.episodes) {
                assert.ok(episode.durationMinutes >= 0 && episode.id.length > 0);
                assert.ok(episode.availableTo === null || episode.availableTo.slice(0, 10) >= today);
            }
            withEpisodes += result.data.episodes.length > 0 ? 1 : 0;
        }
        assert.ok(withEpisodes > 0, "at least one series should have episodes available today");
    });

    for (const type of ["standard", "sequential", "news"] as const) {
        const group = limited(ids.series[type]);
        it(`${type} series (${group.length})`, async () => {
            const outcomes = await runAll(group, async (s) => {
                assert.equal(await NRK.getSeriesType(s.id), type);

                const series = await NRK.getSeasons(s.id);
                assert.equal(series.seriesType, type);
                assert.ok(series.title.length > 0, "title");
                assert.ok(series.imageUrl300 === null || isHttpUrl(series.imageUrl300), "imageUrl300");
                assert.ok(series.seasons.length > 0, "seasons");

                const season = series.seasons[0];
                assert.ok(season, "first season");
                const episodes = await NRK.getAllEpisodes(s.id, season.name);
                assert.equal(episodes.seriesType, type);
                checkEpisodes(episodes);
            });
            assertOutcomes(`${type} series`, outcomes);
        });
    }
});
