// Workout playback engine: interval timing, voice cues, performance monitoring.

import { computeSpm } from './fusion.js';

// ---- Voice ----
let _voice = null, _voicePicked = false;

function pickVoice() {
  if (_voicePicked) return _voice;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  _voicePicked = true;
  // Prefer commanding female voices in priority order
  const PREFERRED = [
    'Google UK English Female',
    'Microsoft Aria Online (Natural) - English (United States)',
    'Microsoft Jenny Online (Natural) - English (United States)',
    'Microsoft Zira - English (United States)',
    'Samantha', 'Karen', 'Victoria', 'Moira', 'Tessa',
  ];
  for (const name of PREFERRED) {
    const v = voices.find(v => v.name === name);
    if (v) return (_voice = v);
  }
  const female = voices.find(v => v.lang.startsWith('en') && /female|woman/i.test(v.name));
  return (_voice = female || voices.find(v => v.lang.startsWith('en')) || voices[0] || null);
}

if ('speechSynthesis' in window) {
  speechSynthesis.addEventListener('voiceschanged', () => { _voicePicked = false; pickVoice(); });
}

export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) utt.voice = v;
  utt.pitch = 0.82;   // lower = more authority
  utt.rate  = 1.08;   // crisp and direct
  utt.volume = 1;
  speechSynthesis.speak(utt);
}

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

  const announced = new Set();   // keys like "2_30", "2_10" to prevent double-firing

  function resetIntervalState() {
    baselineSpm        = null;
    baselineSpmSamples = [];
    lastSpmAlertMs     = 0;
    lastDpsAlertMs     = 0;
  }

  function announceInterval(iv) {
    if      (iv.type === 'rest')     speak('Rest.');
    else if (iv.type === 'warmup')   speak(`Warm up. PS ${iv.ps}.`);
    else if (iv.type === 'cooldown') speak('Cool down.');
    else speak(`PS ${iv.ps}. ${iv.ps * 10} percent. Go.`);
  }

  function ivName(iv) {
    if (iv.type === 'rest')     return 'rest';
    if (iv.type === 'warmup')   return `warm up, PS ${iv.ps}`;
    if (iv.type === 'cooldown') return 'cool down';
    return `PS ${iv.ps}, ${iv.ps * 10} percent`;
  }

  return {
    get loaded()     { return workout !== null; },
    get active()     { return active; },
    get workout()    { return workout; },
    get currentIdx() { return currentIdx; },

    load(w) {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      workout = w; currentIdx = -1; active = false; pauseStart = 0;
      announced.clear(); resetIntervalState();
      // Warm up TTS engine + confirm to user
      speak(`Workout loaded. ${w.name}. Press start when ready.`);
    },

    unload() {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      workout = null; currentIdx = -1; active = false;
    },

    start() {
      if (!workout?.intervals.length) return;
      active        = true;
      currentIdx    = 0;
      intervalStart = Date.now();
      pauseStart    = 0;
      announced.clear(); resetIntervalState();
      announceInterval(workout.intervals[0]);
    },

    pause() {
      if (active && !pauseStart) pauseStart = Date.now();
    },

    resume() {
      if (pauseStart) {
        // Push intervalStart forward by the pause duration so elapsed stays correct
        intervalStart += Date.now() - pauseStart;
        pauseStart = 0;
      }
    },

    stop() {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      active = false; currentIdx = -1; pauseStart = 0;
    },

    // Call from render loop every ~100ms while session is running and not paused.
    // Returns a status object, or null if player is not active.
    tick(state, profileDps) {
      if (!active || currentIdx < 0 || !workout) return null;
      const iv = workout.intervals[currentIdx];
      if (!iv) { active = false; return null; }

      const now       = Date.now();
      const elapsed   = now - intervalStart;
      const remaining = iv.durationSec * 1000 - elapsed;
      const k         = currentIdx;

      // --- Countdown cues ---
      if (remaining <= 30500 && remaining > 29500 && !announced.has(`${k}_30`)) {
        announced.add(`${k}_30`);
        speak('30 seconds.');
      }
      if (remaining <= 10500 && remaining > 9500 && !announced.has(`${k}_10`)) {
        announced.add(`${k}_10`);
        const next = workout.intervals[currentIdx + 1];
        speak(next ? `10 seconds. Next: ${ivName(next)}.` : '10 seconds. Final push.');
      }
      // 5-second verbal countdown: fires as soon as remaining drops below each second mark
      for (let s = 5; s >= 1; s--) {
        const ck = `${k}_cd${s}`;
        if (remaining <= s * 1000 && !announced.has(ck)) {
          announced.add(ck);
          speak(String(s));
          break;
        }
      }

      // --- Interval complete ---
      if (remaining <= 0) {
        const nextIdx = currentIdx + 1;
        if (nextIdx >= workout.intervals.length) {
          active = false;
          speak('Workout complete. Good job, Fah Queue.');
          return { type: 'complete', currentIdx, totalIntervals: workout.intervals.length };
        }
        currentIdx    = nextIdx;
        intervalStart = now;
        resetIntervalState();
        announceInterval(workout.intervals[currentIdx]);
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

        // Build SPM baseline during first 25 s of interval
        if (elSec < 25 && spm > 5) {
          baselineSpmSamples.push(spm);
        } else if (baselineSpm === null && baselineSpmSamples.length >= 3) {
          baselineSpm = baselineSpmSamples.reduce((a, b) => a + b) / baselineSpmSamples.length;
        }

        // SPM drop alert: >15% below baseline, cooldown 18 s
        if (baselineSpm !== null && spm > 5) {
          const drop = (baselineSpm - spm) / baselineSpm;
          if (drop > 0.15 && now - lastSpmAlertMs > 18000) {
            lastSpmAlertMs = now;
            speak('Stroke rate dropping. Increase cadence.');
            alert = 'spm';
          }
        }

        // DPS drop alert: >12% below profile DPS, cooldown 25 s
        if (!alert && state.strokes.length > 15 && profileDps > 0 && state.fusedDistance > 0) {
          const liveDps = state.fusedDistance / state.strokes.length;
          const dpsDrop = (profileDps - liveDps) / profileDps;
          if (dpsDrop > 0.12 && now - lastDpsAlertMs > 25000) {
            lastDpsAlertMs = now;
            speak('Drive through the water. Maintain distance per stroke.');
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
