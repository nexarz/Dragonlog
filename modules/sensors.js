// Sensor wrappers: GPS (geolocation) and accelerometer (devicemotion).
// Exposes small event-emitter-style APIs to keep the rest of the app decoupled.

import { haversine } from './fusion.js';

// ---------- Permissions ----------

export function needsMotionPermission() {
  return typeof DeviceMotionEvent !== 'undefined' &&
         typeof DeviceMotionEvent.requestPermission === 'function';
}

export async function requestMotionPermission() {
  if (!needsMotionPermission()) return 'granted';
  try {
    const res = await DeviceMotionEvent.requestPermission();
    return res;
  } catch (e) {
    console.warn('Motion permission error:', e);
    return 'denied';
  }
}

// ---------- Stroke detector ----------
// Detects paddle strokes from devicemotion via a simple peak detector
// on the high-pass-filtered acceleration magnitude.

export function createStrokeDetector({
  getSensitivity,    // () => number
  getMinInterval,    // () => ms
  onStroke,          // (timestamp) => void
  onLiveReading,     // (delta) => void  (for settings/debug)
  onMotion,          // (ev) => void     (raw event for downstream processing)
}) {
  let smoothedMag = 0;
  let peakCandidate = 0;
  let lastStrokeTime = 0;
  let attached = false;

  function handleMotion(ev) {
    onMotion?.(ev);
    const a = ev.accelerationIncludingGravity || ev.acceleration;
    if (!a) return;
    const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
    smoothedMag = smoothedMag * 0.92 + mag * 0.08;
    const delta = Math.abs(mag - smoothedMag);
    onLiveReading?.(delta);

    const sensitivity = getSensitivity();
    const minInterval = getMinInterval();
    const now = Date.now();

    if (delta > sensitivity && delta > peakCandidate) {
      peakCandidate = delta;
    }
    if (delta < sensitivity * 0.5 && peakCandidate > sensitivity) {
      if (now - lastStrokeTime > minInterval) {
        lastStrokeTime = now;
        onStroke?.(now);
      }
      peakCandidate = 0;
    }
  }

  return {
    attach() {
      if (attached) return;
      window.addEventListener('devicemotion', handleMotion);
      attached = true;
    },
    detach() {
      if (!attached) return;
      window.removeEventListener('devicemotion', handleMotion);
      attached = false;
    },
  };
}

// ---------- GPS watcher ----------

export function createGpsWatcher({
  onUpdate,       // (entry) => void  (entry: {t, lat, lon, speed, accuracy, distanceDelta})
  onStatus,       // (status) => void  ('live' | 'searching' | 'error' | 'off' | 'unavailable')
}) {
  let watchId = null;
  let lastEntry = null;

  function start() {
    if (!navigator.geolocation) {
      onStatus?.('unavailable');
      return;
    }
    onStatus?.('searching');
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        onStatus?.('live');
        const entry = {
          t: Date.now(),
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          speed: p.coords.speed,
          accuracy: p.coords.accuracy,
        };
        let distanceDelta = 0;
        if (lastEntry) {
          const d = haversine(lastEntry.lat, lastEntry.lon, entry.lat, entry.lon);
          // reject GPS jitter: big jumps or low-accuracy fixes
          if (d < 50 && (entry.accuracy == null || entry.accuracy < 30)) {
            distanceDelta = d;
          }
        }
        entry.distanceDelta = distanceDelta;
        lastEntry = entry;
        onUpdate?.(entry);
      },
      (err) => {
        console.warn('GPS error:', err);
        onStatus?.('error');
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }

  function stop() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    lastEntry = null;
    onStatus?.('off');
  }

  return { start, stop };
}

// ---------- Wake lock ----------

export async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      return await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    console.warn('Wake lock failed:', e);
  }
  return null;
}
