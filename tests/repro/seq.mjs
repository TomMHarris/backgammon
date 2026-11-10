// Same as seq.py, for the WebAssembly build.
// Run:  SEQ=0,1 node tests/repro/seq.mjs "$PWD"
const root = process.argv[2];
const { default: c } = await import(root + "/engine/dist/gnubg.mjs"); const fs = await import("node:fs");
const M = await c(); M.FS.mkdirTree("/d/met");
for (const f of ["gnubg.wd","gnubg_os0.bd","gnubg_ts0.bd"]) M.FS.writeFile("/d/"+f, fs.readFileSync(root+"/engine/data/"+f));
for (const f of fs.readdirSync(root+"/engine/data/met")) M.FS.writeFile("/d/met/"+f, fs.readFileSync(root+"/engine/data/met/"+f));
M.ccall("gnubg_api_init","string",["string"],["/d"]);
for (const cf of process.env.SEQ.split(",").map(Number)) {
  const r = JSON.parse(M.ccall("gnubg_api_evaluate","string",["string"],[JSON.stringify({position:"4HPwATDgc/ABMA", eval:{plies:2, cubeful: !!cf, prune:true, deterministic:true, noise:0}})]));
  console.log(`wasm   seq=${process.env.SEQ} cubeful=${cf}`, [r.probs.win, r.probs.winGammon, r.probs.winBackgammon, r.probs.loseGammon, r.probs.loseBackgammon, r.cubelessEquity].map(x=>x.toPrecision(17)).join(" "));
}
