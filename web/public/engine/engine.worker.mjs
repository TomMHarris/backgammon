// Web Worker that runs GNU Backgammon's engine (WebAssembly) off the main
// thread, so the page never freezes while gnubg thinks.
//
// This file is plain JavaScript served as-is (not bundled by Next.js) from
// public/engine/, next to manifest.json and the content-hashed engine files. The typed TypeScript wrapper
// that talks to it is web/src/engine/client.ts.
//
// Protocol (main thread -> worker):  { id, fn, req }
//   fn  = name of a C API function, e.g. "gnubg_api_evaluate"
//   req = request object (sent to the engine as JSON)
// Worker -> main thread:
//   { type: "progress", loaded, total, file }   while loading data files
//   { type: "ready", version }                   engine initialised
//   { type: "init-error", error }                initialisation failed
//   { type: "result", id, result }               reply to a request (result.ok false = engine error)
//   { type: "error", id, error }                 the call itself failed (crash, unknown fn)
//
// Requests are handled strictly one at a time, in arrival order (the engine
// is single-threaded and keeps internal caches; see NOTES.md).

// The engine's file names contain a content hash (see web/scripts/copy-engine.mjs);
// manifest.json says which files are current, so it is loaded first.

const DATA_DIR = "/gnubg-data";
let Module = null;

async function fetchBytes(url, onChunk) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url}: HTTP ${response.status}`);
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    onChunk(buf.length);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Check a downloaded data file against the size and SHA-256 in manifest.json.
// gnubg treats a damaged bearoff database as "missing" and silently falls back
// to approximations, so a truncated download must stop here, loudly.
async function verify(f, bytes) {
  if (bytes.length !== f.size) {
    throw new Error(`download of ${f.path} is incomplete (${bytes.length} of ${f.size} bytes); please reload`);
  }
  if (f.sha256 && self.crypto && self.crypto.subtle) {
    const digest = new Uint8Array(await self.crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== f.sha256) throw new Error(`download of ${f.path} is corrupted (checksum mismatch); please reload`);
  }
}

async function initialise() {
  const base = new URL("./", import.meta.url);
  // no-cache: always revalidate the manifest, so a new deployment is picked up.
  const manifest = await (await fetch(new URL("manifest.json", base), { cache: "no-cache" })).json();
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  let loaded = 0;
  const report = (file) => self.postMessage({ type: "progress", loaded, total, file });

  // Start the engine download/compile and the data downloads together.
  const wasmUrl = new URL(manifest.wasm, base).href;
  const { default: createGnubgModule } = await import(new URL(manifest.module, base).href);
  const modulePromise = createGnubgModule({
    print: () => {},
    printErr: () => {},
    // The .wasm file has a hashed name, so tell the loader where it is.
    locateFile: (file) => (file.endsWith(".wasm") ? wasmUrl : new URL(file, base).href),
  });
  const files = await Promise.all(
    manifest.files.map(async (f) => {
      const bytes = await fetchBytes(new URL(f.url, base), (n) => {
        loaded += n;
        report(f.path);
      });
      await verify(f, bytes);
      return { path: f.path, bytes };
    })
  );
  Module = await modulePromise;

  Module.FS.mkdirTree(`${DATA_DIR}/met`);
  for (const f of files) Module.FS.writeFile(`${DATA_DIR}/${f.path}`, f.bytes);

  const init = JSON.parse(Module.ccall("gnubg_api_init", "string", ["string"], [DATA_DIR]));
  if (!init.ok) throw new Error(init.error || "gnubg initialisation failed");
  return init.version;
}

const ready = initialise().then(
  (version) => {
    self.postMessage({ type: "ready", version });
    return true;
  },
  (err) => {
    self.postMessage({ type: "init-error", error: String(err && err.message ? err.message : err) });
    return false;
  }
);

// Process messages strictly in order: chain each request on the previous one.
let queue = ready;
self.onmessage = (event) => {
  const { id, fn, req } = event.data;
  queue = queue.then((ok) => {
    if (!ok) {
      self.postMessage({ type: "error", id, error: "engine failed to initialise" });
      return ok;
    }
    try {
      if (typeof fn !== "string" || !fn.startsWith("gnubg_api_") || typeof Module["_" + fn] !== "function") {
        throw new Error(`unknown engine function: ${fn}`);
      }
      const text = Module.ccall(fn, "string", ["string"], [JSON.stringify(req ?? {})]);
      self.postMessage({ type: "result", id, result: JSON.parse(text) });
    } catch (err) {
      self.postMessage({ type: "error", id, error: String(err && err.message ? err.message : err) });
    }
    return ok;
  });
};
