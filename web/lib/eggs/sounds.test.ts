import { test } from "node:test";
import assert from "node:assert/strict";
import { EGG_SOUNDS, type EggSound } from "./sounds";

function events(s: EggSound) {
  return [...s.notes, ...(s.noise ?? [])];
}

test("every sound has at least one event", () => {
  for (const [name, s] of Object.entries(EGG_SOUNDS)) {
    assert.ok(events(s).length > 0, name);
  }
});

test("every event is schedulable: non-negative start, positive duration and pitch", () => {
  for (const [name, s] of Object.entries(EGG_SOUNDS)) {
    for (const n of s.notes) {
      assert.ok(n.at >= 0 && n.dur > 0 && n.freq > 0, `${name} note @${n.at}`);
      if (n.bendTo !== undefined) assert.ok(n.bendTo > 0, `${name} bendTo @${n.at}`);
      // Exponential decay envelopes need a strictly positive peak; >1 would clip past master.
      if (n.gain !== undefined) assert.ok(n.gain > 0 && n.gain <= 1, `${name} gain @${n.at}`);
      // Human-audible band, and low enough that exponentialRamp never crosses zero.
      assert.ok(n.freq >= 20 && n.freq <= 8000, `${name} freq ${n.freq}`);
    }
    for (const n of s.noise ?? []) {
      assert.ok(n.at >= 0 && n.dur > 0, `${name} noise @${n.at}`);
      if (n.gain !== undefined) assert.ok(n.gain > 0 && n.gain <= 1, `${name} noise gain`);
    }
  }
});

test("one-shots stay short; loops cover their whole sequence", () => {
  for (const [name, s] of Object.entries(EGG_SOUNDS)) {
    const end = Math.max(...events(s).map((n) => n.at + n.dur));
    if (s.loopDur !== undefined) {
      // A loop shorter than its own events would double-schedule overlapping copies.
      assert.ok(s.loopDur >= end, `${name} loopDur ${s.loopDur} < sequence end ${end}`);
    } else {
      // One-shot eggs are punchlines, not soundtracks.
      assert.ok(end <= 5, `${name} runs ${end}s — too long for a one-shot`);
    }
  }
});
