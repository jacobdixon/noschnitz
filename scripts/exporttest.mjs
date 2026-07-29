#!/usr/bin/env node
/* ============================================================================
   Namespace-import tests.

   The sibling of the gap `no-undef` exists for (see eslint.config.js). That
   rule catches a free identifier that resolves to nothing; this catches a
   *member* that resolves to nothing:

     src/TableScreen.jsx called `api.renameSeat(...)`, but src/api.js exports
     that function as `setName`. Rename in the seat controls threw
     `TypeError: api.renameSeat is not a function` and the name never changed.

   Lint cannot see it — `api` is a perfectly defined binding, and ESLint does
   not follow the import to check what's on it. The build *does* notice
   ("renameSeat is not exported by src/api.js") but only as a warning, so it
   scrolls past in a build that exits 0. The seat route itself is covered by
   tabletest; nothing was comparing the client's calls against the client's
   own API surface.

   So: for every `import * as NS from "./local.js"`, load the target module and
   assert every `NS.member` in the file is actually exported. No bundler, no
   browser, a few milliseconds.

   Usage: node scripts/exporttest.mjs
   ========================================================================= */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DIRS = ["src", "api", "scripts"];

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const sources = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(js|jsx|mjs)$/.test(entry)) out.push(path);
  }
  return out;
};

// A namespace import of a relative module: captures the local name and the
// specifier. Matched against comment-stripped source, so the example in this
// file's own header doesn't register as a real import.
const NS_IMPORT = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'](\.[^"']+)["']/g;

/* Comments out, so prose about the code isn't read as code. The `:` guard
   keeps "https://…" in a string from eating the rest of its line. */
const strip = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?<!:)\/\/[^\n]*/g, " ");

/* Every `api.foo` read in the file. The lookbehind rejects `./api.js` inside
   the import specifier itself — that is the module's path, not a member of
   it. Excludes `api.foo = ...`: assigning onto a namespace object is not a
   read of an existing export (and throws in ESM anyway). */
const members = (code, ns) => {
  const found = new Set();
  const re = new RegExp(`(?<![\\w$./"'])${ns}\\.([A-Za-z_$][\\w$]*)\\s*(=[^=])?`, "g");
  for (const m of code.matchAll(re)) if (!m[2]) found.add(m[1]);
  return found;
};

let checkedImports = 0;

for (const file of DIRS.flatMap((d) => sources(join(ROOT, d)))) {
  const code = strip(readFileSync(file, "utf8"));
  for (const [, ns, spec] of code.matchAll(NS_IMPORT)) {
    const target = resolve(dirname(file), spec);
    // .jsx can't be loaded by node; those modules are components, not API
    // surfaces, and none are namespace-imported today.
    if (!/\.(js|mjs)$/.test(target)) continue;

    let exports;
    try {
      exports = await import(pathToFileURL(target).href);
    } catch (err) {
      failures.push(`${relative(ROOT, file)} imports ${spec} — could not load it: ${err.message}`);
      continue;
    }

    checkedImports++;
    const where = relative(ROOT, file);
    const what = relative(ROOT, target);
    for (const name of members(code, ns)) {
      check(
        `${where}: ${ns}.${name}`,
        name in exports,
        `not exported by ${what} (exports: ${Object.keys(exports).sort().join(", ")})`,
      );
    }
  }
}

/* A guard that silently stops looking is the failure mode here: if the import
   regex or the directory list drifts, everything "passes". */
check("found namespace imports to check", checkedImports > 0, `checked ${checkedImports}`);

console.log(`\nexporttest: ${passed} passed, ${failures.length} failed (${checkedImports} namespace imports)`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
