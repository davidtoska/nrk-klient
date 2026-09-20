#!/usr/bin/env node
/**
 * Builds the publishable package into dist/.
 *
 *   npm run build
 *
 * - dist/index.js   one CommonJS file with all dependencies (zod) bundled in
 * - dist/*.d.ts     only the declarations reachable from index.d.ts
 * - dist/THIRD_PARTY_LICENSES.md
 *
 * The build fails if zod (or any other package) would be needed by the consumer.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const fail = (message) => {
    console.error("\nBUILD FAILED: " + message);
    process.exit(1);
};

const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
const kb = (bytes) => (bytes / 1024).toFixed(1) + " KB";

(async () => {
    fs.rmSync(dist, { recursive: true, force: true });

    // 1. JavaScript: everything bundled, nothing external
    const result = await esbuild.build({
        entryPoints: [path.join(root, "src/index.ts")],
        outfile: path.join(dist, "index.js"),
        tsconfig: path.join(root, "tsconfig.build.json"),
        bundle: true,
        platform: "node",
        target: "node18",
        format: "cjs",
        minifyWhitespace: true,
        minifySyntax: true, // identifiers are kept so stack traces stay readable
        legalComments: "none",
        metafile: true,
        logLevel: "warning",
    });
    const outputs = Object.values(result.metafile.outputs);
    const bundled = Object.keys(outputs[0].inputs);
    const zodBytes = Object.entries(outputs[0].inputs)
        .filter(([file]) => file.includes("node_modules/zod/"))
        .reduce((n, [, v]) => n + v.bytesInOutput, 0);

    // 2. Declarations
    const tsc = spawnSync("npx tsc -p tsconfig.build.json", {
        cwd: root,
        stdio: "inherit",
        shell: true,
    });
    if (tsc.status !== 0) fail("tsc could not emit declarations");

    // 3. Keep only declarations reachable from index.d.ts
    const reachable = new Set();
    const visit = (file) => {
        if (reachable.has(file)) return;
        reachable.add(file);
        const text = fs.readFileSync(file, "utf8");
        for (const m of text.matchAll(/(?:from\s+|import\()\s*["'](\.[^"']+)["']/g)) {
            visit(path.resolve(path.dirname(file), m[1]) + ".d.ts");
        }
    };
    visit(path.join(dist, "index.d.ts"));
    for (const file of walk(dist).filter((f) => f.endsWith(".d.ts"))) {
        if (!reachable.has(file)) fs.rmSync(file);
    }

    // 4. Nothing may depend on zod or on any other package
    for (const file of walk(dist).filter((f) => f.endsWith(".d.ts"))) {
        const text = fs.readFileSync(file, "utf8");
        if (/["']zod["']|\bz\.(Zod|input|output|infer)/.test(text)) {
            fail(`${path.relative(root, file)} references zod - it would leak into the consumer's types`);
        }
        const bare = [...text.matchAll(/from\s+["']([^."'][^"']*)["']/g)].map((m) => m[1]);
        if (bare.length > 0) fail(`${path.relative(root, file)} imports packages: ${bare.join(", ")}`);
    }
    const js = fs.readFileSync(path.join(dist, "index.js"), "utf8");
    const requires = [...js.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    const packages = requires.filter((r) => !r.startsWith("node:") && !r.startsWith("."));
    if (packages.length > 0) fail("index.js requires packages at runtime: " + [...new Set(packages)].join(", "));

    // 5. Third-party notice for what is bundled
    const zodPkg = JSON.parse(fs.readFileSync(path.join(root, "node_modules/zod/package.json"), "utf8"));
    const zodLicense = fs.readFileSync(path.join(root, "node_modules/zod/LICENSE"), "utf8").trim();
    fs.writeFileSync(
        path.join(dist, "THIRD_PARTY_LICENSES.md"),
        `# Third-party licenses\n\nThis package bundles the following software.\n\n` +
            `## zod ${zodPkg.version}\n\n${zodPkg.homepage ?? ""}\n\n\`\`\`\n${zodLicense}\n\`\`\`\n`,
    );

    // 6. Report
    const files = walk(dist).map((f) => [path.relative(root, f), fs.statSync(f).size]);
    console.log("\nBuilt dist/ with zod " + zodPkg.version + " bundled in:");
    for (const [name, size] of files) console.log("  " + name.padEnd(40) + kb(size));
    console.log(`\n  ${bundled.length} source files bundled, of which zod is ~${kb(zodBytes)} of the output`);
    console.log("  no runtime dependencies, no zod in the declarations");
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
