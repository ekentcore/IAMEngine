// Synthesized easter-egg sounds — pure data, no Web Audio here, so node:test can validate every
// sequence (sounds.test.ts). The player lives in app/_components/eggs/egg-audio.ts. Nothing in
// this file is a recording or a copyrighted melody: each is an original synth gesture in the
// spirit of its reference (two low staccato hits, a descending slide, DTMF + noise, …).

export type EggNote = {
  /** Seconds from the start of the sound. */
  at: number;
  freq: number;
  /** Seconds; the gain envelope decays to silence across it. */
  dur: number;
  type?: OscillatorType;
  /** Peak gain relative to the master (default 0.25). */
  gain?: number;
  /** Glide the pitch to this frequency across dur. */
  bendTo?: number;
};

export type EggNoise = {
  at: number;
  dur: number;
  gain?: number;
  /** Center of a bandpass filter over the white noise; omit for full-band hiss. */
  band?: number;
};

export type EggSound = {
  notes: EggNote[];
  noise?: EggNoise[];
  /** Present only on looping sounds: seconds before the sequence repeats. */
  loopDur?: number;
};

const sq = "square" as const;
const saw = "sawtooth" as const;
const tri = "triangle" as const;

/** The 404 rejection: three emphatic "uh, uh, uh" thumps, then a referee-whistle chirp. */
const nope: EggSound = {
  notes: [
    { at: 0.0, freq: 130, bendTo: 74, dur: 0.2, type: saw, gain: 0.5 },
    { at: 0.36, freq: 130, bendTo: 74, dur: 0.2, type: saw, gain: 0.5 },
    { at: 0.72, freq: 130, bendTo: 66, dur: 0.32, type: saw, gain: 0.55 },
    // Two close sines beat against each other for the warble of a whistle.
    { at: 1.25, freq: 2350, bendTo: 2050, dur: 0.5, gain: 0.1 },
    { at: 1.25, freq: 2410, bendTo: 2110, dur: 0.5, gain: 0.1 },
  ],
};

/** Two low staccato hits, second one lower — the courtroom door slam. */
const dundun: EggSound = {
  notes: [
    { at: 0.0, freq: 98, dur: 0.32, type: saw, gain: 0.55 },
    { at: 0.0, freq: 196, dur: 0.32, type: tri, gain: 0.3 },
    { at: 0.5, freq: 87, dur: 1.1, type: saw, gain: 0.55 },
    { at: 0.5, freq: 175, dur: 1.1, type: tri, gain: 0.3 },
  ],
};

/** Four descending brass slides — wah, wah, wah, waaah. */
const trombone: EggSound = {
  notes: [
    { at: 0.0, freq: 233, bendTo: 220, dur: 0.38, type: saw, gain: 0.3 },
    { at: 0.46, freq: 208, bendTo: 196, dur: 0.38, type: saw, gain: 0.3 },
    { at: 0.92, freq: 185, bendTo: 175, dur: 0.38, type: saw, gain: 0.3 },
    { at: 1.38, freq: 165, bendTo: 98, dur: 1.6, type: saw, gain: 0.34 },
  ],
};

// DTMF keypad pairs (low row tone + high column tone), used to "dial in" below.
const DTMF: Record<string, [number, number]> = {
  "0": [941, 1336], "1": [697, 1209], "2": [697, 1336], "4": [770, 1209],
  "5": [770, 1336], "6": [770, 1477], "8": [852, 1336],
};

function dtmf(digits: string, start: number, step: number): EggNote[] {
  return digits.split("").flatMap((d, i) => {
    const [lo, hi] = DTMF[d];
    const at = start + i * step;
    return [
      { at, freq: lo, dur: 0.09, gain: 0.16 },
      { at, freq: hi, dur: 0.09, gain: 0.16 },
    ];
  });
}

/** The whole 1997 ritual: dial, carrier, answer, the screech, and a triumphant connect chord. */
const dialup: EggSound = {
  notes: [
    ...dtmf("5560456", 0, 0.13),
    { at: 1.15, freq: 2100, dur: 0.5, gain: 0.14 },
    { at: 1.75, freq: 1300, dur: 0.3, gain: 0.14 },
    { at: 2.1, freq: 980, bendTo: 1650, dur: 0.5, type: sq, gain: 0.08 },
    // Connected: a small rising major chord.
    { at: 3.55, freq: 440, dur: 0.5, type: tri, gain: 0.22 },
    { at: 3.62, freq: 554, dur: 0.5, type: tri, gain: 0.22 },
    { at: 3.69, freq: 659, dur: 0.55, type: tri, gain: 0.22 },
  ],
  noise: [
    { at: 2.1, dur: 1.3, gain: 0.16, band: 1800 },
  ],
};

/** Coin block: the classic two-note chirp shape (B5 into a long E6). */
const coin: EggSound = {
  notes: [
    { at: 0.0, freq: 988, dur: 0.09, type: sq, gain: 0.16 },
    { at: 0.09, freq: 1319, dur: 0.5, type: sq, gain: 0.16 },
  ],
};

/** Three airhorn blasts, short-short-long, each with the upward smear. */
const airhorn: EggSound = {
  notes: [
    { at: 0.0, freq: 415, bendTo: 466, dur: 0.2, type: saw, gain: 0.34 },
    { at: 0.0, freq: 830, bendTo: 932, dur: 0.2, type: saw, gain: 0.12 },
    { at: 0.3, freq: 415, bendTo: 466, dur: 0.2, type: saw, gain: 0.34 },
    { at: 0.3, freq: 830, bendTo: 932, dur: 0.2, type: saw, gain: 0.12 },
    { at: 0.6, freq: 415, bendTo: 470, dur: 0.9, type: saw, gain: 0.36 },
    { at: 0.6, freq: 830, bendTo: 940, dur: 0.9, type: saw, gain: 0.13 },
  ],
};

/** One springy boing — pitch whips up and dies. */
const boing: EggSound = {
  notes: [{ at: 0.0, freq: 140, bendTo: 640, dur: 0.35, gain: 0.3 }],
};

/** Gentle Cmaj7 → Fmaj7 arpeggio on repeat — the tasteful end of hold music. */
const holdmusic: EggSound = {
  loopDur: 6.4,
  notes: [
    { at: 0.0, freq: 130.8, dur: 1.6, type: tri, gain: 0.1 },
    { at: 0.0, freq: 261.6, dur: 0.6, gain: 0.12 },
    { at: 0.4, freq: 329.6, dur: 0.6, gain: 0.12 },
    { at: 0.8, freq: 392.0, dur: 0.6, gain: 0.12 },
    { at: 1.2, freq: 493.9, dur: 0.6, gain: 0.12 },
    { at: 1.6, freq: 659.3, dur: 1.0, gain: 0.1 },
    { at: 3.2, freq: 174.6, dur: 1.6, type: tri, gain: 0.1 },
    { at: 3.2, freq: 349.2, dur: 0.6, gain: 0.12 },
    { at: 3.6, freq: 440.0, dur: 0.6, gain: 0.12 },
    { at: 4.0, freq: 523.3, dur: 0.6, gain: 0.12 },
    { at: 4.4, freq: 659.3, dur: 0.6, gain: 0.12 },
    { at: 4.8, freq: 880.0, dur: 1.2, gain: 0.1 },
  ],
};

export const EGG_SOUNDS = {
  nope,
  dundun,
  trombone,
  dialup,
  coin,
  airhorn,
  boing,
  holdmusic,
} as const;

export type EggSoundName = keyof typeof EGG_SOUNDS;
