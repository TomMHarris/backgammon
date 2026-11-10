// Load the WebAssembly engine in Node, the same way the browser worker does
// (data files written into Emscripten's in-memory filesystem), and return a
// small helper to call the JSON API.
//
//   import { loadEngine } from "./lib/engine-node.mjs";
//   const engine = await loadEngine();
//   const r = engine.call("gnubg_api_evaluate", { position: "4HPwATDgc/ABMA" });

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function loadEngine({ dist = path.join(ROOT, "engine/dist") } = {}) {
  const { default: createGnubgModule } = await import(path.join(dist, "gnubg.mjs"));
  // gnubg prints a few lines (e.g. a glib warning about the user name) to
  // stderr during init; keep them out of test output.
  const Module = await createGnubgModule({ printErr: () => {} });
  const dataDir = path.join(ROOT, "engine/data");
  Module.FS.mkdirTree("/gnubg-data/met");
  for (const f of ["gnubg.wd", "gnubg_os0.bd", "gnubg_ts0.bd"]) {
    Module.FS.writeFile(`/gnubg-data/${f}`, readFileSync(path.join(dataDir, f)));
  }
  for (const f of readdirSync(path.join(dataDir, "met"))) {
    Module.FS.writeFile(`/gnubg-data/met/${f}`, readFileSync(path.join(dataDir, "met", f)));
  }
  const raw = (fn, arg) => JSON.parse(Module.ccall(fn, "string", ["string"], [arg]));
  const init = raw("gnubg_api_init", "/gnubg-data");
  if (!init.ok) throw new Error(`engine init failed: ${JSON.stringify(init)}`);
  return {
    Module,
    version: init.version,
    /** Call an API function with a request object; returns the parsed reply. */
    call: (fn, req) => raw(fn, JSON.stringify(req)),
  };
}
