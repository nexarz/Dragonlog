// Per-stroke boat physics: stern check (surge axis) + vertical bounce (heave axis).
// Assumes phone is mounted flat on the deck, screen up, top of phone toward bow.
// Device axes under that orientation:
//   Y = surge (forward/back); +Y is forward toward bow
//   Z = heave (up/down);      +Z is upward
// Gravity is removed via a slow low-pass filter so we keep only the AC component
// of acceleration. This makes the metrics robust to small mounting variation.
//
// Performance: per-cycle sample storage uses pre-allocated Float32Array buffers
// instead of growing JS arrays — devicemotion fires 60-120 Hz, so push/shift on
// regular arrays causes GC pressure and visible UI hitches.

const CYCLE_MAX = 600;   // hard cap on samples per stroke cycle (≈5 s @ 120 Hz)

export function createPhysicsTracker() {
  const surgeBuf = new Float32Array(CYCLE_MAX);
  const heaveBuf = new Float32Array(CYCLE_MAX);
  let cycleCount = 0;

  let lpY = 0, lpZ = 0;
  let primed = false;

  // Session aggregates
  let totalCycles = 0;
  let sumCheck    = 0;
  let sumBounce   = 0;
  // Recent windows for "live" display
  const RECENT_N     = 8;
  const recentCheck  = new Float32Array(RECENT_N);
  const recentBounce = new Float32Array(RECENT_N);
  let recentFilled   = 0;
  let recentIdx      = 0;

  function reset() {
    cycleCount = 0;
    lpY = 0; lpZ = 0; primed = false;
    totalCycles = 0; sumCheck = 0; sumBounce = 0;
    recentFilled = 0; recentIdx = 0;
  }

  function addSample(ev) {
    const a = ev.accelerationIncludingGravity || ev.acceleration;
    if (!a) return;
    const ay = a.y || 0;
    const az = a.z || 0;
    if (!primed) { lpY = ay; lpZ = az; primed = true; }
    lpY = lpY * 0.98 + ay * 0.02;
    lpZ = lpZ * 0.98 + az * 0.02;
    if (cycleCount < CYCLE_MAX) {
      surgeBuf[cycleCount] = ay - lpY;
      heaveBuf[cycleCount] = az - lpZ;
      cycleCount++;
    }
    // If we hit the cap, drop subsequent samples until next stroke — no GC churn
  }

  function onStroke() {
    if (cycleCount >= 8) {
      let minY = Infinity, maxZ = -Infinity, minZ = Infinity;
      for (let i = 0; i < cycleCount; i++) {
        const y = surgeBuf[i];
        const z = heaveBuf[i];
        if (y < minY) minY = y;
        if (z > maxZ) maxZ = z;
        if (z < minZ) minZ = z;
      }
      const check  = -minY;
      const bounce = maxZ - minZ;
      totalCycles++;
      sumCheck  += check;
      sumBounce += bounce;
      recentCheck[recentIdx]  = check;
      recentBounce[recentIdx] = bounce;
      recentIdx = (recentIdx + 1) % RECENT_N;
      if (recentFilled < RECENT_N) recentFilled++;
    }
    cycleCount = 0;
  }

  function avgRecent(buf) {
    if (recentFilled === 0) return 0;
    let s = 0;
    for (let i = 0; i < recentFilled; i++) s += buf[i];
    return s / recentFilled;
  }

  return {
    addSample, onStroke, reset,
    get totalCycles() { return totalCycles; },
    get avgCheck()    { return totalCycles > 0 ? sumCheck  / totalCycles : 0; },
    get avgBounce()   { return totalCycles > 0 ? sumBounce / totalCycles : 0; },
    get liveCheck()   { return avgRecent(recentCheck); },
    get liveBounce()  { return avgRecent(recentBounce); },
  };
}
