// modules/audio.js
const VOICES_DIR = './voices/';
// REPLACEMENT: Use one single Audio element for everything
const singletonPlayer = new Audio();
singletonPlayer.preload = 'auto';

let queueToken = null;

// This MUST be called from a user gesture (Start or Enable button)
export function unlockAudio() {
  singletonPlayer.src = VOICES_DIR + '1.mp3'; // point to any small file
  singletonPlayer.muted = true;
  singletonPlayer.play().then(() => {
    singletonPlayer.pause();
    singletonPlayer.muted = false;
    console.log("iOS Audio Unlocked");
  }).catch(e => console.warn("Audio unlock failed:", e));
}

export function stop() {
  queueToken = null;
  try { 
    singletonPlayer.pause(); 
    singletonPlayer.currentTime = 0; 
  } catch {}
}

// Play a single clip by swapping the source of the blessed player
export function play(name) {
  queueToken = null; // stop any running queue
  singletonPlayer.src = VOICES_DIR + name + '.mp3';
  return singletonPlayer.play().catch(e => console.warn('Audio play failed:', name, e.message));
}

// Sequential playback using the same element
export async function playQueue(...names) {
  const myToken = Symbol('queue');
  queueToken = myToken;
  
  for (const name of names) {
    if (queueToken !== myToken) return;
    
    await new Promise(resolve => {
      singletonPlayer.src = VOICES_DIR + name + '.mp3';
      const onEnd = () => {
        singletonPlayer.removeEventListener('ended', onEnd);
        resolve();
      };
      singletonPlayer.addEventListener('ended', onEnd);
      singletonPlayer.play().catch(e => {
        console.warn('Queue play failed:', name, e.message);
        resolve();
      });
    });
  }
}

// Keep your helper functions
export function intervalClip(iv) {
  if (iv.type === 'rest') return 'rest';
  if (iv.type === 'cooldown') return 'cooldown';
  if (iv.type === 'warmup') return `warmup-ps${iv.ps}`;
  return `ps${iv.ps}-go`;
}

export function nextIntervalClip(iv) {
  if (iv.type === 'rest') return 'next-rest';
  if (iv.type === 'cooldown') return 'next-cooldown';
  if (iv.type === 'warmup') return `next-warmup-ps${iv.ps}`;
  return `next-ps${iv.ps}`;
}