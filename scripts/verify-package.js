#!/usr/bin/env node
/**
 * Checks the package the way a user gets it:
 *
 *   npm run build && npm run verify:package
 *
 * 1. `npm pack`, and check what ends up in the tarball
 * 2. install the tarball into an empty project and run it
 * 3. type-check a small TypeScript program against the installed package
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "narko-klient-verify-"));
const problems = [];
const check = (ok, message) => {
    console.log((ok ? "  ok   " : "  FAIL ") + message);
    if (!ok) problems.push(message);
};
// npm publish --dry-run sets npm_config_dry_run, which would stop the inner npm pack from writing the tarball
const env = { ...process.env, npm_config_dry_run: "false" };
const run = (command, cwd, options = {}) =>
    spawnSync(command, { cwd, shell: true, encoding: "utf8", env, ...options });

try {
    if (!fs.existsSync(path.join(root, "dist/index.js"))) {
        throw new Error("dist/ is missing - run `npm run build` first");
    }

    // 1. the tarball
    console.log("Tarball");
    const packed = run(`npm pack --json --pack-destination "${tmp}"`, root);
    if (packed.status !== 0) throw new Error("npm pack failed:\n" + packed.stderr);
    const info = JSON.parse(packed.stdout)[0];
    const names = info.files.map((f) => f.path);
    const allowed = (n) =>
        n === "package.json" || n === "README.md" || n === "LICENSE" || n.startsWith("dist/");
    check(names.every(allowed), `only dist/, README, LICENSE and package.json are shipped (${names.length} files)`);
    check(!names.some((n) => /swagger|fixtures|^src\/|^test\//i.test(n)), "no sources, tests, fixtures or swagger files");
    check(names.includes("dist/index.js") && names.includes("dist/index.d.ts"), "index.js and index.d.ts are present");
    console.log(`  ${(info.size / 1024).toFixed(1)} KB packed, ${(info.unpackedSize / 1024).toFixed(1)} KB unpacked`);
    const tarball = path.join(tmp, info.filename);

    // 2. install into an empty project
    console.log("Install in an empty project");
    const app = path.join(tmp, "app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "consumer", private: true }));
    const install = run(`npm install "${tarball}" --no-audit --no-fund --ignore-scripts`, app);
    if (install.status !== 0) throw new Error("npm install failed:\n" + install.stderr);
    const installed = JSON.parse(fs.readFileSync(path.join(app, "node_modules/narko-klient/package.json"), "utf8"));
    check(!installed.dependencies && !installed.peerDependencies, "package declares no dependencies or peer dependencies");
    check(!installed.dependencies && !installed.peerDependencies && !installed.optionalDependencies, "package declares no dependencies of any kind");
    const installedPackages = fs.readdirSync(path.join(app, "node_modules")).filter((n) => !n.startsWith("."));
    check(installedPackages.join() === "narko-klient", "nothing else was installed (found: " + installedPackages.join(", ") + ")");

    // 3. run it, with fetch replaced by recorded answers
    console.log("Runtime");
    const ids = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/ids.json"), "utf8")).curated;
    const raw = (name) => path.join(root, "test/fixtures/raw", name).replace(/\\/g, "/");
    fs.writeFileSync(
        path.join(app, "smoke.js"),
        `
const fs = require("node:fs");
const assert = require("node:assert/strict");
const pkg = require("narko-klient");

assert.deepEqual(Object.keys(pkg).sort(), ["NrkClient"]);

const fixtures = {
  "/tv/catalog/programs/${ids.availableProgram}": ${JSON.stringify(raw(`tv__catalog__programs__${ids.availableProgram}.json`))},
  "/playback/metadata/program/${ids.availableProgram}": ${JSON.stringify(raw(`playback__metadata__program__${ids.availableProgram}.json`))},
};
const fetchWithFixtures = async (url) => {
  const p = new URL(url).pathname;
  if (p.startsWith("/medium/tv/letters/")) {
    return new Response(JSON.stringify([{
      id: "P1", title: "Fotball-VM", sortLetter: "F", type: "programme", isGeoBlocked: false,
      hasOndemandRights: true, description: "Kampen om pokalen.",
      image: { webImages: [{ imageUrl: "https://gfx.nrk.no/x", pixelWidth: 300 }] },
    }]), { status: 200 });
  }
  const file = fixtures[p];
  if (file) { const j = JSON.parse(fs.readFileSync(file, "utf8")); return new Response(JSON.stringify(j.json), { status: j.status }); }
  return new Response('{"message":"nope"}', { status: 404 });
};
globalThis.fetch = fetchWithFixtures;

(async () => {
  // NrkClient: catalog, details and error mapping - none of it throws
  // (letters and minIntervalMs are an internal test seam, not public API: they only keep this smoke test fast)
  const ai = new pkg.NrkClient({ letters: "f", minIntervalMs: 0 });
  const listing = await ai.listCatalog({ letters: "f" });
  assert.ok(listing.ok && listing.data.items.length === 1 && listing.data.items[0].id === "P1" && listing.data.failed.length === 0);
  const one = await ai.getProgram("${ids.availableProgram}");
  assert.ok(one.ok && typeof one.data.description === "string");
  const missing = await ai.getSeries({ seriesId: "finnes-ikke" });
  assert.ok(!missing.ok && missing.error.code === "not_found");
  const bad = await ai.listCatalog({ letters: "1" });
  assert.ok(!bad.ok && bad.error.code === "invalid_input");
  console.log("smoke test passed");
})().catch((e) => { console.error(e); process.exit(1); });
`,
    );
    const smoke = run("node smoke.js", app);
    check(smoke.status === 0, "CommonJS require: NrkClient and its error handling work with nothing else installed");
    if (smoke.status !== 0) console.log((smoke.stdout + smoke.stderr).split("\n").map((l) => "    " + l).join("\n"));

    fs.writeFileSync(
        path.join(app, "smoke.mjs"),
        `import { NrkClient } from "narko-klient";
if (typeof NrkClient !== "function") process.exit(1);
console.log("esm import ok");`,
    );
    const esm = run("node smoke.mjs", app);
    check(esm.status === 0, "ESM import of the named exports works");

    const bundle = fs.readFileSync(path.join(app, "node_modules/narko-klient/dist/index.js"), "utf8");
    // the build folds the version into a constant; the User-Agent template reads it at runtime
    const versionConstant = new RegExp("VERSION\\s*=\\s*" + JSON.stringify(installed.version));
    check(
        versionConstant.test(bundle) && bundle.includes("narko-klient/${VERSION} (+https://github.com/"),
        `User-Agent carries the package version ${installed.version}`,
    );
    check(!bundle.includes("narko-klient/dev"), "no development placeholder in the build");

    // 4. types
    console.log("Types");
    fs.writeFileSync(
        path.join(app, "check.ts"),
        `import { NrkClient } from "narko-klient";
import type { Result, Program, NrkError, Playback, ListCatalogInput } from "narko-klient";

export const main = async (): Promise<void> => {
  const ai = new NrkClient();
  const input: ListCatalogInput = { letters: "abc" };
  const found = await ai.listCatalog(input);
  if (found.ok) {
    const count: number = found.data.items.length;
    const title: string = found.data.items[0]?.title ?? "";
    const failedLetters: string[] = found.data.failed.map((f) => f.letter);
    void [count, title, failedLetters];
  } else {
    const code: NrkError["code"] = found.error.code;
    void code;
  }
  const program: Result<Program> = await ai.getProgram("MKTF73000514");
  if (program.ok) {
    const people: string[] = program.data.contributors.map((c) => c.name);
    const description: string | null = program.data.description;
    void [people, description];
  }
  const playback: Result<Playback> = await ai.getPlayback("MKTF73000514");
  if (playback.ok) {
    const url: string = playback.data.streamUrl;
    const tracks: string[] = playback.data.subtitles.map((t) => t.url);
    const seconds: number | null = playback.data.durationSeconds;
    void [url, tracks, seconds];
  } else if (playback.error.code === "not_playable") {
    const forTheViewer: string = playback.error.message;
    void forTheViewer;
  }

  // @ts-expect-error the client takes no options
  new NrkClient({ nope: 1 });
  // @ts-expect-error not even the internal test seams are part of the public types
  new NrkClient({ minIntervalMs: 0 });
  // @ts-expect-error letters must be a string
  await ai.listCatalog({ letters: 5 });
  // @ts-expect-error there is no search or cache any more
  ai.searchCatalog({ query: "natur" });
};
`,
    );
    const tscBin = `"${path.join(root, "node_modules/.bin", process.platform === "win32" ? "tsc.cmd" : "tsc")}"`;
    for (const resolution of ["nodenext", "bundler"]) {
        const module = resolution === "nodenext" ? "nodenext" : "esnext";
        const result = run(
            `${tscBin} --noEmit --strict --skipLibCheck false --target es2022 --lib es2022 ` +
                `--module ${module} --moduleResolution ${resolution} --types "" check.ts`,
            app,
        );
        check(result.status === 0, `strict type-check passes with moduleResolution ${resolution} (skipLibCheck off)`);
        if (result.status !== 0) console.log((result.stdout + result.stderr).split("\n").map((l) => "    " + l).join("\n"));
    }

    // an ESM consumer (a .mts file is always a module under nodenext)
    fs.copyFileSync(path.join(app, "check.ts"), path.join(app, "check.mts"));
    const esmTypes = run(
        `${tscBin} --noEmit --strict --skipLibCheck false --target es2022 --lib es2022 ` +
            `--module nodenext --moduleResolution nodenext --types "" check.mts`,
        app,
    );
    check(esmTypes.status === 0, "strict type-check passes for an ESM consumer (nodenext, .mts)");
    if (esmTypes.status !== 0) console.log((esmTypes.stdout + esmTypes.stderr).split("\n").map((l) => "    " + l).join("\n"));
} catch (e) {
    problems.push(e.message);
    console.error(e.message);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

if (problems.length > 0) {
    console.error(`\nverify:package FAILED (${problems.length} problem${problems.length > 1 ? "s" : ""})`);
    process.exit(1);
}
console.log("\nverify:package passed");
