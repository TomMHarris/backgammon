// Copy the built engine (engine/dist) and gnubg's data files (engine/data)
// into web/public/engine/, where the browser loads them from. Runs before
// "npm run dev" and "npm run build". The copies are git-ignored; the source
// of truth is engine/.
import { cpSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = path.resolve(web, "../engine");
const out = path.join(web, "public/engine");
mkdirSync(path.join(out, "data/met"), { recursive: true });

for (const f of ["gnubg.mjs", "gnubg.wasm"]) cpSync(path.join(engine, "dist", f), path.join(out, f));
for (const f of ["gnubg.wd", "gnubg_os0.bd", "gnubg_ts0.bd"]) cpSync(path.join(engine, "data", f), path.join(out, "data", f));
const mets = readdirSync(path.join(engine, "data/met")).filter((f) => f.endsWith(".xml") || f.endsWith(".dtd"));
for (const f of mets) cpSync(path.join(engine, "data/met", f), path.join(out, "data/met", f));
// manifest.json tells the worker which data files to load and how big they
// are (for the loading progress bar).
const dataFiles = ["gnubg.wd", "gnubg_os0.bd", "gnubg_ts0.bd", ...mets.map((f) => `met/${f}`)];
const manifest = {
  files: dataFiles.map((f) => ({ path: f, size: statSync(path.join(out, "data", f)).size })),
};
writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`copy-engine: engine + ${dataFiles.length} data files -> public/engine/`);
