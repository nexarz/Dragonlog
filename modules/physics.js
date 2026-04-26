// Per-stroke boat physics: stern check (surge axis) + vertical bounce (heave axis).
// Assumes phone is mounted flat on the deck, screen up, top of phone toward bow.
// Device axes under that orientation:
//   Y = surge (forward/back); +Y is forward toward bow
//   Z = heave (up/down);      +Z is upward
// Gravity is removed via a slow low-pass filter so we keep only the AC component
// of acceleration. This makes the metrics robust to small mounting variation.

export function createPhysicsTracker() {
  let surgeBuffer = [];   // Y samples between two detected strokes (one cycle)
  let heaveBuffer = [];
  let lpY = 0, lpZ = 0;   // low-pass filter state (estimate of gravity)
  let primed = false;

  // Session aggregates
  let totalCycles  = 0;
  let sumCheck     = 0;
  let sumBounce    = 0;
  // Recent windows for "live" display
  const RECENT_N   = 8;
  const recentCheck  = [];
  const recentBounce = [];

  function reset() {
    surgeBuffer = []; heaveBuffer = [];
    lpY = 0; lpZ = 0; primed = false;
    totalCycles = 0; sumCheck = 0; sumBounce = 0;
    recentCheck.length = 0; recentBounce.length = 0;
  }

  function addSample(ev) {
    const a = ev.accelerationIncludingGravity || ev.acceleration;
    if (!a) return;
    const ay = a.y || 0;
    const az = a.z || 0;
    if (!primed) { lpY = ay; lpZ = az; primed = true; }
    // Slow low-pass filter ≈ gravity vector estimate
    lpY = lpY * 0.98 + ay * 0.02;
    lpZ = lpZ * 0.98 + az * 0.02;
    surgeBuffer.push(ay - lpY);
    heaveBuffer.push(az - lpZ);
    // Hard cap to keep memory bounded between unusually long strokes
    if (surgeBuffer.length > 600) {
      surgeBuffer.shift(); heaveBuffer.shift();
    }
  }

  function onStroke() {
    // Need a previous cycle's worth of samples to score
    if (surgeBuffer.length >= 8) {
      let minY = Infinity, maxZ = -Infinity, minZ = Infinity;
      for (let i = 0; i < surgeBuffer.length; i++) {
        if (surgeBuffer[i] < minY) minY = surgeBuffer[i];
        const z = heaveBuffer[i];
        if (z > maxZ) maxZ = z;
        if (z < minZ) minZ = z;
      }
      const check  = -minY;        // magnitude of deepest backward spike (m/s²)
      const bounce = maxZ - minZ;  // peak-to-peak vertical amplitude (m/s²)

      totalCycles++;
      sumCheck  += check;
      sumBounce += bounce;
      recentCheck.push(check);
      recentBounce.push(bounce);
      if (recentCheck.length  > RECENT_N) recentCheck.shift();
      if (recentBounce.length > RECENT_N) recentBounce.shift();
    }
    surgeBuffer = []; heaveBuffer = [];
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b) / arr.length : 0;

  return {
    addSample, onStroke, reset,
    get totalCycles() { return totalCycles; },
    get avgCheck()    { return totalCycles > 0 ? sumCheck  / totalCycles : 0; },
    get avgBounce()   { return totalCycles > 0 ? sumBounce / totalCycles : 0; },
    get liveCheck()   { return avg(recentCheck); },
    get liveBounce()  { return avg(recentBounce); },
  };
}
