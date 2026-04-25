// Workout playback engine: interval timing, voice cues, performance monitoring.
// Voice is played from pre-recorded audio clips (modules/audio.js) for a
// consistent custom voice on every device.

import { computeSpm } from './fusion.js';
import * as audio from './audio.js';

// ---- Player factory ----
export function createPlayer() {
  let workout       = null;
  let currentIdx    = -1;
  let intervalStart = 0;  // wall clock ms when current interval began (adjusted for pauses)
  let active        = false;
  let pauseStart    = 0;

  // Per-interval performance baseline
  let baselineSpm        = null;
  let baselineSpmSamples = [];
  let lastSpmAlertMs     = 0;
  let lastDpsAlertMs     = 0;

  const announced = new Set();   // keys like "2_10", "2_cd5" to prevent double-firing

  function resetIntervalState() {
    baselineSpm        = null;
    baselineSpmSamples = [];
    lastSpmAlertMs     = 0;
    lastDpsAlertMs     = 0;
  }

  return {
    get loaded()     { return workout !== null; },
    get active()     { return active; },
    get workout()    { return workout; },
    get currentIdx() { return currentIdx; },

    load(w) {
      audio.stop();
      workout = w; currentIdx = -1; active = false; pauseStart = 0;
      announced.clear(); resetIntervalState();
      audio.play('workout-loaded');
    },

    unload() {
      audio.stop();
      workout = null; currentIdx = -1; active = false;
    },

    start() {
      if (!workout?.intervals.length) return;
      active        = true;
      currentIdx    = 0;
      intervalStart = Date.now();
      pauseStart    = 0;
      announced.clear(); resetIntervalState();
      audio.play(audio.intervalClip(workout.intervals[0]));
    },

    pause() {
      if (active && !pauseStart) pauseStart = Date.now();
    },

    resume() {
      if (pauseStart) {
        intervalStart += Date.now() - pauseStart;
        pauseStart = 0;
      }
    },

    stop() {
      audio.stop();
      active = false; currentIdx = -1; pauseStart = 0;
    },

    // Call from render loop every ~100ms while session is running and not paused.
    tick(state, profileDps) {
      if (!active || currentIdx < 0 || !workout) return null;
      const iv = workout.intervals[currentIdx];
      if (!iv) { active = false; return null; }

      const now       = Date.now();
      const elapsed   = now - intervalStart;
      const remaining = iv.durationSec * 1000 - elapsed;
      const k         = currentIdx;

      // 10-second cue: announce + preview next interval
      if (remaining <= 10500 && remaining > 9500 && !announced.has(`${k}_10`)) {
        announced.add(`${k}_10`);
        const next = workout.intervals[currentIdx + 1];
        if (next) audio.playQueue('10sec', audio.nextIntervalClip(next));
        else      audio.playQueue('10sec', 'final-push');
      }
      // 5-4-3-2-1 verbal countdown
      for (let s = 5; s >= 1; s--) {
        const ck = `${k}_cd${s}`;
        if (remaining <= s * 1000 && !announced.has(ck)) {
          announced.add(ck);
          audio.play(String(s));
          break;
        }
      }

      // --- Interval complete ---
      if (remaining <= 0) {
        const nextIdx = currentIdx + 1;
        if (nextIdx >= workout.intervals.length) {
          active = false;
          audio.play('workout-complete');
          return { type: 'complete', currentIdx, totalIntervals: workout.intervals.length };
        }
        currentIdx    = nextIdx;
        intervalStart = now;
        resetIntervalState();
        audio.play(audio.intervalClip(workout.intervals[currentIdx]));
        return {
          type: 'next', currentIdx,
          totalIntervals:  workout.intervals.length,
          currentInterval: workout.intervals[currentIdx],
          nextInterval:    workout.intervals[currentIdx + 1] || null,
          remainingMs:     workout.intervals[currentIdx].durationSec * 1000,
          alert: null,
        };
      }

      // --- Performance monitoring (work + warmup only) ---
      let alert = null;
      if (iv.type === 'work' || iv.type === 'warmup') {
        const spm    = computeSpm(state.strokes);
        const elSec  = elapsed / 1000;

        if (elSec < 25 && spm > 5) {
          baselineSpmSamples.push(spm);
        } else if (baselineSpm === null && baselineSpmSamples.length >= 3) {
          baselineSpm = baselineSpmSamples.reduce((a, b) => a + b) / baselineSpmSamples.length;
        }

        if (baselineSpm !== null && spm > 5) {
          const drop = (baselineSpm - spm) / baselineSpm;
          if (drop > 0.15 && now - lastSpmAlertMs > 18000) {
            lastSpmAlertMs = now;
            audio.play('alert-spm');
            alert = 'spm';
          }
        }

        if (!alert && state.strokes.length > 15 && profileDps > 0 && state.fusedDistance > 0) {
          const liveDps = state.fusedDistance / state.strokes.length;
          const dpsDrop = (profileDps - liveDps) / profileDps;
          if (dpsDrop > 0.12 && now - lastDpsAlertMs > 25000) {
            lastDpsAlertMs = now;
            audio.play('alert-dps');
            alert = 'dps';
          }
        }
      }

      return {
        type: 'tick', alert, currentIdx,
        totalIntervals:  workout.intervals.length,
        currentInterval: iv,
        nextInterval:    workout.intervals[currentIdx + 1] || null,
        remainingMs:     Math.max(0, remaining),
      };
    },
  };
}

// Re-export speak as a no-op kept for any external callers (none currently)
export function speak() {}
