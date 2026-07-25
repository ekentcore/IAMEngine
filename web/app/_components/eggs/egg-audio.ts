"use client";

// The easter-egg synth — plays the sequences in lib/eggs/sounds.ts through one shared
// AudioContext. No audio assets anywhere: oscillators and filtered white noise only.
// Every call site is a user gesture (a typed word or a click), which is what keeps the
// context resumable under browser autoplay policy. Failure is always silent: an egg must
// never break because audio couldn't start.
//
// Kill switch: localStorage["egg-sounds"] = "off" mutes everything (checked per play).
import type { EggSound } from "@/lib/eggs/sounds";

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  try {
    if (typeof window === "undefined") return null;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function eggSoundsOff(): boolean {
  try {
    return localStorage.getItem("egg-sounds") === "off";
  } catch {
    return false;
  }
}

const MASTER = 0.22;

/** Schedule one pass of the sound into `out` starting at absolute context time t0. */
function schedule(c: AudioContext, s: EggSound, t0: number, out: AudioNode) {
  for (const n of s.notes) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.setValueAtTime(n.freq, t0 + n.at);
    if (n.bendTo !== undefined) osc.frequency.exponentialRampToValueAtTime(n.bendTo, t0 + n.at + n.dur);
    g.gain.setValueAtTime((n.gain ?? 0.25) * MASTER, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(g);
    g.connect(out);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.05);
  }
  for (const n of s.noise ?? []) {
    const len = Math.ceil(c.sampleRate * n.dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.setValueAtTime((n.gain ?? 0.2) * MASTER, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    let head: AudioNode = src;
    if (n.band !== undefined) {
      const f = c.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = n.band;
      f.Q.value = 0.9;
      src.connect(f);
      head = f;
    }
    head.connect(g);
    g.connect(out);
    src.start(t0 + n.at);
  }
}

/** Fast-fade a bus and disconnect it — cuts scheduled tails without a click. */
function silence(c: AudioContext, bus: GainNode) {
  try {
    bus.gain.cancelScheduledValues(c.currentTime);
    bus.gain.setValueAtTime(bus.gain.value, c.currentTime);
    bus.gain.linearRampToValueAtTime(0, c.currentTime + 0.08);
    setTimeout(() => {
      try {
        bus.disconnect();
      } catch {}
    }, 150);
  } catch {}
}

/**
 * Play a one-shot. Returns a stop function (safe to call any time), shaped so a component can
 * write `useEffect(() => playEggSound(SOUND), [])` and the tail dies with the egg.
 */
export function playEggSound(s: EggSound): () => void {
  if (eggSoundsOff()) return () => {};
  const c = context();
  if (!c) return () => {};
  try {
    const bus = c.createGain();
    bus.connect(c.destination);
    schedule(c, s, c.currentTime + 0.02, bus);
    return () => silence(c, bus);
  } catch {
    return () => {};
  }
}

/** Play a looping sound until the returned stop function is called. */
export function startEggLoop(s: EggSound): () => void {
  if (eggSoundsOff()) return () => {};
  const c = context();
  if (!c) return () => {};
  const dur = (s.loopDur ?? 4) * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  try {
    const bus = c.createGain();
    bus.connect(c.destination);
    schedule(c, s, c.currentTime + 0.02, bus);
    timer = setInterval(() => {
      try {
        schedule(c, s, c.currentTime + 0.02, bus);
      } catch {}
    }, dur);
    return () => {
      if (timer) clearInterval(timer);
      silence(c, bus);
    };
  } catch {
    if (timer) clearInterval(timer);
    return () => {};
  }
}
