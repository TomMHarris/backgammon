# Regression check for the (resolved) "history-dependent 1-ulp" difference (NOTES.md, Phase 1):
# native and wasm must print identical results for the same SEQ. Native side.
# Run:  SEQ=0,1 HOME=$(mktemp -d) engine/native/build/strict/gnubg -t -r -q -P engine/data -p tests/repro/seq.py
# SEQ is a comma list of cubeful flags (0/1); each entry is one 2-ply evaluation of the opening.
import gnubg, os
b = gnubg.positionfromid('4HPwATDgc/ABMA')
ci = gnubg.cubeinfo(1, -1, 0, 0, (0, 0), 0, 0)
# gnubg.cubeinfo() takes 'beavers' from the current game's beaver count (0);
# desktop gnubg (and our API) use the global setting nBeavers = 3. Match it.
ci['beavers'] = 3
for cf in [int(x) for x in os.environ['SEQ'].split(',')]:
    r = gnubg.evaluate(b, ci, gnubg.evalcontext(cf, 2, 1, 1, 0.0))
    print('native seq=%s cubeful=%d' % (os.environ['SEQ'], cf), ' '.join('%.17g' % x for x in r))
