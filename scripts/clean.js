#!/usr/bin/env node
/**
 * Removes generated files.
 *
 *   npm run clean            dist/ (the package) and build/ (compiled tests)
 *   npm run clean:all        the above, plus .cache/ (recorded HTTP responses for the live tests)
 *   node scripts/clean.js --dry-run [--all]    only list what would be removed
 *
 * .cache/ is left alone by default: NRK rate-limits, so refilling it takes a while.
 * Plain node instead of rimraf, so it works the same on Windows, macOS and Linux.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const targets = ["dist", "build", ...(args.has("--all") ? [".cache"] : [])];

const sizeOf = (p) => {
    let bytes = 0;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, entry.name);
        bytes += entry.isDirectory() ? sizeOf(full) : fs.statSync(full).size;
    }
    return bytes;
};

let removed = 0;
for (const name of targets) {
    const target = path.join(root, name);
    // never touch anything outside the repository
    if (path.relative(root, target).startsWith("..")) throw new Error("refusing to remove " + target);
    if (!fs.existsSync(target)) continue;
    const kb = (sizeOf(target) / 1024).toFixed(0);
    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    console.log(`${dryRun ? "would remove" : "removed"} ${name}/ (${kb} KB)`);
    removed++;
}
if (removed === 0) console.log("nothing to clean");
