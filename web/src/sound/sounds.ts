// Small synthesised sound effects (Web Audio API; no audio files).
//
//   configureSound({ enabled: true, volume: 0.35 });
//   unlockAudio();          // call from a user gesture (click / key press)
//   playSound("place");
//
// Browsers only allow audio after a user gesture, so the AudioContext is
// created lazily by unlockAudio(), which the app calls on the first pointer or
// key press. Every function swallows errors: no sound is ever worth an
// exception. The sounds are short, soft "wooden" knocks and clicks built
// from filtered noise and decaying sine tones.

export type SoundName = "dice" | "place" | "hit" | "bearoff" | "cube" | "take" | "pass" | "win" | "lose" | "warn" | "undo";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let enabled = true;
let volume = 0.35;

export function configureSound(opts: { enabled: boolean; volume: number }) {
  enabled = opts.enabled;
  volume = Math.max(0, Math.min(1, opts.volume));
  try {
    if (master && ctx) master.gain.setValueAtTime(volume, ctx.currentTime);
  } catch {
    /* ignore */
  }
}

/** Create (or resume) the audio context. Call from a user gesture. */
export function unlockAudio() {
  try {
    if (!ctx) {
      const AC: typeof AudioContext | undefined =
        typeof window !== "undefined"
          ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      // One second of white noise, reused by every noise burst.
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  } catch {
    ctx = null;
  }
}

// ---- building blocks --------------------------------------------------------

/** A burst of band-passed noise: the "click" part of a knock. */
function burst(t: number, { freq, q = 1, dur = 0.04, gain = 0.5 }: { freq: number; q?: number; dur?: number; gain?: number }) {
  if (!ctx || !master || !noise) return;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5, dur + 0.02);
}

/** A decaying sine with a slight pitch drop: the "body" of a knock or a marimba-like note. */
function tone(
  t: number,
  { freq, to, dur = 0.12, gain = 0.4, type = "sine" }: { freq: number; to?: number; dur?: number; gain?: number; type?: OscillatorType }
) {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** A soft mallet note: fundamental plus a quieter, faster-decaying overtone. */
function mallet(t: number, freq: number, gain = 0.3, dur = 0.35) {
  tone(t, { freq, dur, gain });
  tone(t, { freq: freq * 4, dur: dur / 4, gain: gain * 0.25 });
}

const knock = (t: number, pitch = 1, gain = 1) => {
  tone(t, { freq: 210 * pitch, to: 120 * pitch, dur: 0.07, gain: 0.45 * gain });
  burst(t, { freq: 1700 * pitch, q: 1.4, dur: 0.035, gain: 0.35 * gain });
};

// ---- the sounds -------------------------------------------------------------

const SOUNDS: Record<SoundName, (t: number) => void> = {
  // dice rattling in a cup and landing: a few quick clicks
  dice: (t) => {
    const n = 5;
    for (let k = 0; k < n; k++) {
      const at = t + k * 0.035 + Math.random() * 0.015;
      burst(at, { freq: 2600 + Math.random() * 1600, q: 2.5, dur: 0.025, gain: 0.22 + 0.06 * Math.random() });
    }
    knock(t + n * 0.035 + 0.02, 1.5, 0.45);
  },
  place: (t) => knock(t, 1, 0.8),
  hit: (t) => {
    knock(t, 1.15, 1);
    burst(t + 0.05, { freq: 3200, q: 3, dur: 0.03, gain: 0.25 });
    knock(t + 0.07, 0.8, 0.55);
  },
  bearoff: (t) => {
    knock(t, 1.4, 0.55);
    tone(t + 0.02, { freq: 520, to: 700, dur: 0.12, gain: 0.08 });
  },
  cube: (t) => {
    tone(t, { freq: 140, to: 90, dur: 0.12, gain: 0.5 });
    burst(t, { freq: 900, q: 1, dur: 0.05, gain: 0.3 });
    knock(t + 0.09, 0.9, 0.5);
  },
  take: (t) => {
    mallet(t, 523.25, 0.18, 0.22);
    mallet(t + 0.09, 783.99, 0.16, 0.25);
  },
  pass: (t) => {
    mallet(t, 659.25, 0.16, 0.22);
    mallet(t + 0.09, 440, 0.16, 0.25);
  },
  win: (t) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => mallet(t + k * 0.09, f, 0.18, 0.5));
  },
  lose: (t) => {
    [440, 369.99, 293.66].forEach((f, k) => mallet(t + k * 0.12, f, 0.15, 0.5));
  },
  warn: (t) => {
    tone(t, { freq: 392, dur: 0.14, gain: 0.08, type: "triangle" });
    tone(t + 0.12, { freq: 329.63, dur: 0.18, gain: 0.08, type: "triangle" });
  },
  undo: (t) => burst(t, { freq: 1200, q: 2, dur: 0.03, gain: 0.18 }),
};

export function playSound(name: SoundName, delay = 0) {
  if (!enabled || volume <= 0) return;
  try {
    if (!ctx) return; // not unlocked by a gesture yet
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    SOUNDS[name](ctx.currentTime + 0.005 + delay);
  } catch {
    /* audio unavailable: stay silent */
  }
}
