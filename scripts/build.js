#!/usr/bin/env node
/**
 * Builds the publishable package into dist/.
 *
 *   npm run build
 *
 * - dist/index.js   one CommonJS file
 * - dist/*.d.ts     only the declarations reachable from index.d.ts
 *
 * The package has no dependencies. The build fails if any third-party code ended up in
 * the bundle, or if a consumer would need a package at runtime or for the types.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
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
        target: "node20",
        define: { __NRK_KLIENT_VERSION__: JSON.stringify(pkg.version) },
        format: "cjs",
        minifyWhitespace: true,
        minifySyntax: true, // identifiers are kept so stack traces stay readable
        legalComments: "none",
        metafile: true,
        logLevel: "warning",
    });
    const bundled = Object.keys(Object.values(result.metafile.outputs)[0].inputs);
    const thirdParty = bundled.filter((file) => file.includes("node_modules"));
    if (thirdParty.length > 0) fail("third-party code was bundled: " + thirdParty.slice(0, 5).join(", "));

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

    // 4. Nothing may depend on any package
    for (const file of walk(dist).filter((f) => f.endsWith(".d.ts"))) {
        const text = fs.readFileSync(file, "utf8");
        if (/@internal|Validator<|from\s+["']\.\/validate["']/.test(text)) {
            fail(`${path.relative(root, file)} exposes internal validation code`);
        }
        const bare = [...text.matchAll(/from\s+["']([^."'][^"']*)["']/g)].map((m) => m[1]);
        if (bare.length > 0) fail(`${path.relative(root, file)} imports packages: ${bare.join(", ")}`);
    }
    const js = fs.readFileSync(path.join(dist, "index.js"), "utf8");
    const requires = [...js.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    const packages = requires.filter((r) => !r.startsWith("node:") && !r.startsWith("."));
    if (packages.length > 0) fail("index.js requires packages at runtime: " + [...new Set(packages)].join(", "));

    // 5. Report
    const files = walk(dist).map((f) => [path.relative(root, f), fs.statSync(f).size]);
    console.log("\nBuilt dist/:");
    for (const [name, size] of files) console.log("  " + name.padEnd(40) + kb(size));
    console.log(`\n  ${bundled.length} source files bundled, no third-party code`);
    console.log("  no runtime dependencies, no package imports in the declarations");
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
