#!/usr/bin/env node
/**
 * Runs the compiled tests in one directory with node's test runner.
 *
 *   node scripts/run-tests.js build/test/offline [--test-timeout=900000]
 *
 * Lists the *.test.js files itself, because `node --test "glob"` only expands globs on
 * Node 22 and later, and the shell does not expand them on Windows.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const [dir, ...nodeFlags] = process.argv.slice(2);
if (!dir) {
    console.error("usage: run-tests.js <directory> [node --test flags]");
    process.exit(2);
}
const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => path.join(dir, f));
if (files.length === 0) {
    console.error(`no *.test.js files in ${dir} - run the build first`);
    process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...nodeFlags, ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
