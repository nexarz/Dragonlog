// Custom voice audio playback. Replaces Web Speech API for consistent
// voice across all devices. Plays pre-recorded clips from /voices.

const VOICES_DIR = './voices/';
const cache = new Map();
let currentAudio = null;
let queueToken = null;

function getAudio(name) {
  if (!cache.has(name)) {
    const a = new Audio(VOICES_DIR + name + '.mp3');
    a.preload = 'auto';
    cache.set(name, a);
  }
  return cache.get(name);
}

export function preload(names) {
  names.forEach(getAudio);
}

export function stop() {
  queueToken = null;
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.currentTime = 0; } catch {}
    currentAudio = null;
  }
}

// Play a single clip, interrupting whatever is currently playing.
export function play(name) {
  stop();
  const a = getAudio(name);
  try { a.currentTime = 0; } catch {}
  currentAudio = a;
  return a.play().catch(e => console.warn('Audio play failed:', name, e.message));
}

// Play a sequence of clips back-to-back. Cancels any previous queue.
export async function playQueue(...names) {
  stop();
  const myToken = Symbol('queue');
  queueToken = myToken;
  for (const name of names) {
    if (queueToken !== myToken) return;          // canceled by another call
    const a = getAudio(name);
    try { a.currentTime = 0; } catch {}
    currentAudio = a;
    await new Promise(resolve => {
      const onEnd = () => { a.removeEventListener('ended', onEnd); resolve(); };
      const onErr = () => { a.removeEventListener('error', onErr); resolve(); };
      a.addEventListener('ended', onEnd);
      a.addEventListener('error', onErr);
      a.play().catch(e => { console.warn('Audio play failed:', name, e.message); resolve(); });
    });
  }
}

// Helper: clip name for an interval (used as the "Go!" announcement)
export function intervalClip(iv) {
  if (iv.type === 'rest')     return 'rest';
  if (iv.type === 'cooldown') return 'cooldown';
  if (iv.type === 'warmup')   return `warmup-ps${iv.ps}`;
  return `ps${iv.ps}-go`;
}

// Helper: clip name for the "Next: ..." preview
export function nextIntervalClip(iv) {
  if (iv.type === 'rest')     return 'next-rest';
  if (iv.type === 'cooldown') return 'next-cooldown';
  if (iv.type === 'warmup')   return `next-warmup-ps${iv.ps}`;
  return `next-ps${iv.ps}`;
}

// All clip names — used by the SW SHELL list and for preloading
export const ALL_CLIPS = (() => {
  const list = [
    '1', '2', '3', '4', '5',
    '10sec', 'final-push',
    'rest', 'cooldown',
    'next-rest', 'next-cooldown',
    'workout-loaded', 'workout-complete',
    'alert-spm', 'alert-dps',
  ];
  for (let i = 1; i <= 10; i++) {
    list.push(`ps${i}-go`, `warmup-ps${i}`, `next-ps${i}`, `next-warmup-ps${i}`);
  }
  return list;
})();
