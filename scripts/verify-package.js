#!/usr/bin/env node
/**
 * Checks the package the way a user gets it:
 *
 *   npm run build && npm run verify:package
 *
 * 1. `npm pack`, and check what ends up in the tarball
 * 2. install the tarball into an empty project (no zod there) and run it
 * 3. type-check a small TypeScript program against the installed package
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nrk-klient-verify-"));
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
    check(names.includes("dist/THIRD_PARTY_LICENSES.md"), "third-party license notice is present");
    console.log(`  ${(info.size / 1024).toFixed(1)} KB packed, ${(info.unpackedSize / 1024).toFixed(1)} KB unpacked`);
    const tarball = path.join(tmp, info.filename);

    // 2. install into an empty project
    console.log("Install in an empty project");
    const app = path.join(tmp, "app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "consumer", private: true }));
    const install = run(`npm install "${tarball}" --no-audit --no-fund --ignore-scripts`, app);
    if (install.status !== 0) throw new Error("npm install failed:\n" + install.stderr);
    const installed = JSON.parse(fs.readFileSync(path.join(app, "node_modules/nrk-klient/package.json"), "utf8"));
    check(!installed.dependencies && !installed.peerDependencies, "package declares no dependencies or peer dependencies");
    check(!fs.existsSync(path.join(app, "node_modules/zod")), "zod is not installed for the consumer");
    const installedPackages = fs.readdirSync(path.join(app, "node_modules")).filter((n) => !n.startsWith("."));
    check(installedPackages.join() === "nrk-klient", "nothing else was installed (found: " + installedPackages.join(", ") + ")");

    // 3. run it, with fetch replaced by recorded answers
    console.log("Runtime");
    const ids = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/ids.json"), "utf8")).curated;
    const raw = (name) => path.join(root, "test/fixtures/raw", name).replace(/\\/g, "/");
    fs.writeFileSync(
        path.join(app, "smoke.js"),
        `
const fs = require("node:fs");
const assert = require("node:assert/strict");
const pkg = require("nrk-klient");

assert.deepEqual(Object.keys(pkg).sort(), ["AiClient", "NRK", "NrkHttpError"]);

const fixtures = {
  "/tv/catalog/programs/${ids.availableProgram}": ${JSON.stringify(raw(`tv__catalog__programs__${ids.availableProgram}.json`))},
  "/playback/metadata/program/${ids.availableProgram}": ${JSON.stringify(raw(`playback__metadata__program__${ids.availableProgram}.json`))},
};
globalThis.fetch = async (url) => {
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

(async () => {
  // NRK: real recorded program page through the bundled zod schemas
  const program = await pkg.NRK.getProgramById("${ids.availableProgram}");
  assert.equal(program.id, "${ids.availableProgram}");
  assert.ok(program.title.length > 0 && program.durationInSeconds > 0);

  // NRK: errors are NrkHttpError, from the same class that the package exports
  await assert.rejects(pkg.NRK.getSeriesType("finnes-ikke"), (e) => e instanceof pkg.NrkHttpError && e.status === 404);

  // AiClient: search, details, and error mapping - none of it throws
  const ai = new pkg.AiClient({ letters: "f", minIntervalMs: 0 });
  const found = await ai.searchCatalog({ query: "fotball" });
  assert.ok(found.ok && found.data.items[0].id === "P1" && found.data.total === 1);
  const one = await ai.getProgram("${ids.availableProgram}");
  assert.ok(one.ok && typeof one.data.description === "string");
  const missing = await ai.getSeries({ seriesId: "finnes-ikke" });
  assert.ok(!missing.ok && missing.error.code === "not_found");
  const bad = await ai.searchCatalog({ limit: 0 });
  assert.ok(!bad.ok && bad.error.code === "invalid_input");
  console.log("smoke test passed");
})().catch((e) => { console.error(e); process.exit(1); });
`,
    );
    const smoke = run("node smoke.js", app);
    check(smoke.status === 0, "CommonJS require: NRK, AiClient and error handling work without zod installed");
    if (smoke.status !== 0) console.log((smoke.stdout + smoke.stderr).split("\n").map((l) => "    " + l).join("\n"));

    fs.writeFileSync(
        path.join(app, "smoke.mjs"),
        `import { NRK, AiClient, NrkHttpError } from "nrk-klient";
if (typeof NRK.getProgramById !== "function" || typeof AiClient !== "function" || typeof NrkHttpError !== "function") process.exit(1);
console.log("esm import ok");`,
    );
    const esm = run("node smoke.mjs", app);
    check(esm.status === 0, "ESM import of the named exports works");

    // 4. types
    console.log("Types");
    fs.writeFileSync(
        path.join(app, "check.ts"),
        `import { AiClient, NRK, NrkHttpError } from "nrk-klient";
import type { AiResult, AiProgram, AiError, ProgramById, SearchCatalogInput } from "nrk-klient";

export const main = async (): Promise<void> => {
  const ai = new AiClient({ minIntervalMs: 0 });
  const input: SearchCatalogInput = { query: "natur", type: "series", limit: 5 };
  const found = await ai.searchCatalog(input);
  if (found.ok) {
    const total: number = found.data.total;
    const title: string = found.data.items[0]?.title ?? "";
    void [total, title];
  } else {
    const code: AiError["code"] = found.error.code;
    void code;
  }
  const program: AiResult<AiProgram> = await ai.getProgram("MKTF73000514");
  if (program.ok) {
    const people: string[] = program.data.contributors.map((c) => c.name);
    const description: string | null = program.data.description;
    void [people, description];
  }
  const p: ProgramById = await NRK.getProgramById("MKTF73000514");
  const e: unknown = new NrkHttpError(500, "u", null);
  void [p.title, e];

  // @ts-expect-error unknown option
  new AiClient({ nope: 1 });
  // @ts-expect-error limit must be a number
  await ai.searchCatalog({ limit: "5" });
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
