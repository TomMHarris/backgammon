// Copy the built engine (engine/dist) and gnubg's data files (engine/data)
// into web/public/engine/, where the browser loads them from. Runs before
// "npm run dev" and "npm run build". The copies are git-ignored; the source
// of truth is engine/.
//
// Caching: every engine/data file is copied to public/engine/v/<hash>-<name>,
// where <hash> is the start of its SHA-256. A file's URL therefore changes
// exactly when its content changes, so the host can tell browsers to cache
// these files forever (see vercel.json). Only manifest.json (which lists the
// current URLs) and the small worker script are re-checked on each visit.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = path.resolve(web, "../engine");
const out = path.join(web, "public/engine");
const versioned = path.join(out, "v");

// Start from a clean versioned directory so stale files never linger.
rmSync(versioned, { recursive: true, force: true });
mkdirSync(versioned, { recursive: true });

/** Copy `src` to v/<hash>-<name>; return its URL relative to public/engine/. */
function copyHashed(src, name) {
  const sha256 = createHash("sha256").update(readFileSync(src)).digest("hex");
  const file = `${sha256.slice(0, 12)}-${name.replaceAll("/", "_")}`;
  cpSync(src, path.join(versioned, file));
  // size + sha256 let the worker verify every download (a truncated bearoff
  // database would otherwise make gnubg silently fall back to approximations).
  return { url: `v/${file}`, size: statSync(src).size, sha256 };
}

const mets = readdirSync(path.join(engine, "data/met")).filter((f) => f.endsWith(".xml") || f.endsWith(".dtd"));
const dataFiles = ["gnubg.wd", "gnubg_os0.bd", "gnubg_ts0.bd", ...mets.map((f) => `met/${f}`)];

const manifest = {
  // The Emscripten loader and its WebAssembly binary.
  module: copyHashed(path.join(engine, "dist/gnubg.mjs"), "gnubg.mjs").url,
  wasm: copyHashed(path.join(engine, "dist/gnubg.wasm"), "gnubg.wasm").url,
  // gnubg's data files: `path` is where gnubg expects them in its data directory.
  files: dataFiles.map((f) => ({ path: f, ...copyHashed(path.join(engine, "data", f), f) })),
};
writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

// Remove copies left by the earlier, unversioned layout of this script.
for (const old of ["gnubg.mjs", "gnubg.wasm", "data"]) rmSync(path.join(out, old), { recursive: true, force: true });

// The licence, served at /LICENSE.txt and linked from the About page.
cpSync(path.resolve(web, "../LICENSE"), path.join(web, "public/LICENSE.txt"));

console.log(`copy-engine: engine + ${dataFiles.length} data files -> public/engine/v/ (content-hashed)`);

// The analysis page's "Try a sample match": a 7-point match between two
// noisy gnubg players (tests/corpus/matches, made by native gnubg).
const samples = path.join(web, "public/samples");
mkdirSync(samples, { recursive: true });
cpSync(path.resolve(web, "../tests/corpus/matches/selfplay-7pt.sgf"), path.join(samples, "selfplay-7pt.sgf"));
console.log("copy-engine: sample match -> public/samples/selfplay-7pt.sgf");
