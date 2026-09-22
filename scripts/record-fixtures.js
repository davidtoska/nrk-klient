#!/usr/bin/env node
/**
 * Collects test data from psapi.nrk.no.
 *
 *   npm run record
 *
 * 1. Fetches the whole catalog and picks a few hundred programs and series
 *    (a deterministic sample) -> test/fixtures/ids.json. Used by the live tests.
 * 2. Records NRK's raw answers for a small hand-picked set -> test/fixtures/raw/.
 *    Used by the offline tests through the fetch stub.
 *
 * Needs the project to be built (npm run record does that).
 */
const fs = require("node:fs");
const path = require("node:path");

const dist = path.resolve(__dirname, "../build");
const { NrkClient } = require(path.join(dist, "src/nrk-client.js"));
const { NrkHttpError } = require(path.join(dist, "src/nrk-client-raw.js"));
const { nrkApi } = require(path.join(dist, "src/nrk-api.js"));
const { writeRecorded, FIXTURES_DIR, RAW_DIR } = require(
    path.join(dist, "test/support/fixtures.js"),
);
const { installPoliteFetch } = require(path.join(dist, "test/support/polite-fetch.js"));

// Polite to the API: an even rate, a pause on 429, and a disk cache (.cache/http)
// so that repeated runs do not hit the network.
const restoreFetch = installPoliteFetch({
    minIntervalMs: 350,
    maxRetries: 3,
    cacheDir: path.resolve(__dirname, "../.cache/http"),
    log: (m) => console.log("  " + m),
});

const CONCURRENCY = 4;
const BASE = "https://psapi.nrk.no";
const FILM_MIN_SECONDS = 75 * 60;

// ---------- helpers ----------

const mulberry32 = (seed) => {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};
const rnd = mulberry32(20260921);
const shuffled = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};
const pool = async (items, fn) => {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i], i);
            }
        }),
    );
    return out;
};
const log = (...a) => console.log(...a);
let swallowed = 0;

// ---------- recording raw answers ----------

let recording = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input.url ?? String(input));
    const res = await realFetch(input, init);
    if (recording && ![200, 400, 404].includes(res.status)) {
        throw new Error(`Will not record ${res.status} for ${url}`);
    }
    if (recording) {
        const text = await res.clone().text();
        let parsed;
        let isJson = false;
        try {
            parsed = JSON.parse(text);
            isJson = true;
        } catch {
            /* not JSON */
        }
        writeRecorded(
            url,
            isJson ? { status: res.status, json: parsed } : { status: res.status, text },
        );
    }
    return res;
};
const record = async (fn) => {
    recording = true;
    try {
        return await fn();
    } catch (e) {
        return { error: e };
    } finally {
        recording = false;
    }
};

// ---------- main ----------

// the catalog comes through NrkClient; the rest through the endpoints in nrk-api (the same URLs the client uses)
const client = new NrkClient({ minIntervalMs: 0 });
const unwrap = (result) => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.data;
};
const contributorNames = (page) => (page.contributors ?? []).flatMap((group) => group.name);

(async () => {
    fs.rmSync(RAW_DIR, { recursive: true, force: true });

    // 1. All letter lists
    const catalog = unwrap(await client.listCatalog());
    if (catalog.failed.length > 0) {
        throw new Error("Letter lists failed: " + catalog.failed.map((f) => f.letter).join(", "));
    }
    const programs = catalog.items.filter((i) => i.type === "program");
    const series = catalog.items.filter((i) => i.type === "series");
    // a stable order whatever the network timing
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    programs.sort(byId);
    series.sort(byId);
    log(`Letter lists: ${programs.length} programs, ${series.length} series`);

    // 2. Programs
    const onDemand = programs.filter((p) => p.availableNow && !p.geoBlocked);
    const geoblockedAll = programs.filter((p) => p.availableNow && p.geoBlocked);
    const unavailableAll = programs.filter((p) => !p.availableNow);
    const pick = (list, n) => shuffled(list).slice(0, n).map(({ id, title }) => ({ id, title }));

    const available = pick(onDemand, 220);
    const geoblocked = pick(geoblockedAll, 20);
    const unavailable = pick(unavailableAll, 40);

    // films: long programs. The length comes from the program page, for a large random sample.
    const availableIds = new Set(available.map((p) => p.id));
    const filmCandidates = shuffled(onDemand.filter((p) => !availableIds.has(p.id))).slice(0, 400);
    const filmChecked = await pool(filmCandidates, async (p) => {
        try {
            const x = await nrkApi.program(p.id);
            return { id: p.id, title: p.title, durationInSeconds: x.moreInformation.duration.seconds };
        } catch {
            swallowed++;
            return null;
        }
    });
    const films = filmChecked
        .filter((f) => f && f.durationInSeconds >= FILM_MIN_SECONDS)
        .slice(0, 40);
    log(`Programs: ${available.length} available, ${films.length} films, ` +
        `${geoblocked.length} geoblocked, ${unavailable.length} unavailable`);

    // 3. Series: find the series type for a larger sample
    const seriesSample = shuffled(series).slice(0, 400);
    const typed = await pool(seriesSample, async (s) => {
        try {
            return { id: s.id, title: s.title, seriesType: (await nrkApi.series(s.id)).seriesType };
        } catch {
            swallowed++;
            return null;
        }
    });
    const ofType = (t, n) => typed.filter((s) => s && s.seriesType === t).slice(0, n);
    const seriesOut = {
        standard: ofType("standard", 100),
        sequential: ofType("sequential", 100),
        news: ofType("news", 20),
    };
    log(`Series: ${seriesOut.standard.length} standard, ` +
        `${seriesOut.sequential.length} sequential, ${seriesOut.news.length} news`);

    // 4. Hand-picked examples for the offline tests
    const curated = {};

    // an available program, preferably one without a subtitle as well
    const firstAvailable = available[0];
    curated.availableProgram = firstAvailable.id;
    for (const p of available.slice(0, 60)) {
        try {
            const x = await nrkApi.program(p.id);
            if (!x.programInformation.titles.subtitle) {
                curated.noSubtitleProgram = p.id;
                break;
            }
        } catch {
            /* skip */
        }
    }
    // a program with several credited people (tests the mapping of contributors)
    for (const p of available.slice(0, 150)) {
        try {
            const x = await nrkApi.program(p.id);
            if (contributorNames(x).length >= 3) {
                curated.programWithContributors = p.id;
                break;
            }
        } catch {
            swallowed++;
        }
    }
    if (films[0]) curated.filmProgram = films[0].id;
    if (geoblocked[0]) curated.geoblockedProgram = geoblocked[0].id;

    // expired (manifest 200 without playable) and upcoming (playback 404)
    for (const p of unavailable) {
        const page = await (await realFetch(`${BASE}/tv/catalog/programs/${p.id}`)).json();
        const status = page?.programInformation?.availability?.status;
        const man = await realFetch(`${BASE}/playback/manifest/program/${p.id}`);
        if (status === "expired" && man.status === 200 && !curated.expiredProgram) {
            curated.expiredProgram = p.id;
        }
        if (status === "coming" && man.status === 404 && !curated.comingProgram) {
            curated.comingProgram = p.id;
        }
    }

    // one series of each type, preferably with several seasons
    for (const t of ["standard", "sequential", "news"]) {
        let best = null;
        for (const s of seriesOut[t].slice(0, 25)) {
            const info = await nrkApi.series(s.id).catch(() => null);
            if (info && info._links.seasons.length >= 2) {
                best = s;
                break;
            }
            best ??= info ? s : null;
        }
        if (best) curated[`${t}Series`] = best.id;
    }
    // a series whose episodes have credited people
    search: for (const s of [...seriesOut.standard, ...seriesOut.sequential].slice(0, 150)) {
        try {
            const info = await nrkApi.series(s.id);
            const season = info._links.seasons[0];
            if (!season) continue;
            const eps = await nrkApi.season(s.id, season.name);
            const episodes = [...(eps._embedded.episodes ?? []), ...(eps._embedded.instalments ?? [])];
            if (episodes.some((e) => (e.contributors ?? []).length > 0)) {
                curated.contributorSeries = s.id;
                curated.contributorSeason = season.name;
                break search;
            }
        } catch {
            swallowed++;
        }
    }
    curated.missingProgram = "DOESNOTEXIST";
    curated.missingSeries = "finnes-ikke-serie";

    log("Hand-picked:", curated);

    // 5. Record the raw answers for the hand-picked ones
    for (const role of [
        "availableProgram",
        "noSubtitleProgram",
        "filmProgram",
        "geoblockedProgram",
        "programWithContributors",
        "expiredProgram",
        "comingProgram",
    ]) {
        const id = curated[role];
        if (!id) continue;
        await record(() => nrkApi.program(id));
        await record(() => nrkApi.manifest(id));
        await record(() => nrkApi.metadata(id));
    }
    // playback: manifest and metadata for the 20 ids in playback-ids.json
    const playbackIds = JSON.parse(
        fs.readFileSync(path.join(FIXTURES_DIR, "playback-ids.json"), "utf8"),
    ).ids;
    for (const id of playbackIds) {
        await record(() => nrkApi.manifest(id));
        await record(() => nrkApi.metadata(id));
    }
    for (const t of ["standard", "sequential", "news"]) {
        const id = curated[`${t}Series`];
        if (!id) continue;
        const info = await nrkApi.series(id);
        await record(() => nrkApi.series(id));
        for (const season of info._links.seasons.slice(0, 2)) {
            await record(() => nrkApi.season(id, season.name));
        }
    }
    if (curated.contributorSeries) {
        await record(() => nrkApi.series(curated.contributorSeries));
        await record(() => nrkApi.season(curated.contributorSeries, curated.contributorSeason));
    }
    const missing = await record(() => nrkApi.program(curated.missingProgram));
    const missingSeries = await record(() => nrkApi.series(curated.missingSeries));
    if (!(missing.error instanceof NrkHttpError) || !(missingSeries.error instanceof NrkHttpError)) {
        throw new Error("Expected NrkHttpError for ids that do not exist");
    }
    // the recommendations NrkClient.getRecommendations asks for (10 per id, for adults)
    for (const id of ["FFIL63000263", "OCUH11002809", "filmavisen-innslag-i-utvalg", "DOESNOTEXIST"]) {
        await record(() => nrkApi.recommendations(id, 10));
    }
    // the free-text searches NrkClient.search asks for (20 hits per search)
    for (const query of ["norsk historie", "Ivar Aasen", "fotball", "krigen", "qzxwvyk"]) {
        await record(() => nrkApi.search(query, 20));
    }
    // small letter lists
    for (const l of ["w", "x", "y", "æ"]) await record(() => nrkApi.letter(l));

    // 6. ids.json
    const ids = {
        generatedAt: new Date().toISOString(),
        programs: { available, films, geoblocked, unavailable },
        series: seriesOut,
        curated,
    };
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    fs.writeFileSync(path.join(FIXTURES_DIR, "ids.json"), JSON.stringify(ids, null, 1) + "\n");

    const files = fs.readdirSync(RAW_DIR);
    const bytes = files.reduce((n, f) => n + fs.statSync(path.join(RAW_DIR, f)).size, 0);
    restoreFetch();
    if (swallowed > 0) {
        log(`WARNING: ${swallowed} calls failed and were skipped - the sample may be incomplete.`);
    }
    log(`Done: ${files.length} raw fixtures (${(bytes / 1024).toFixed(0)} KB), ids.json written.`);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
