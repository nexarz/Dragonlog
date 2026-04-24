// Pure math and fusion logic. No DOM. No side effects beyond arguments.

const EARTH_R = 6371000;

export function haversine(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

// Stroke rate from recent stroke timestamps. Uses last 10s window.
export function computeSpm(strokeTimes, now = Date.now(), windowMs = 10000) {
  const cutoff = now - windowMs;
  const recent = strokeTimes.filter(t => t >= cutoff);
  if (recent.length < 2) return 0;
  const span = (recent[recent.length - 1] - recent[0]) / 1000;
  if (span < 1) return 0;
  return Math.round(((recent.length - 1) / span) * 60);
}

// Current speed from recent GPS positions. Uses last 3s window.
export function computeSpeedMS(positions, now = Date.now(), windowMs = 3000) {
  const recent = positions.filter(p => now - p.t < windowMs);
  if (recent.length < 2) return 0;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const d = haversine(a.lat, a.lon, b.lat, b.lon);
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return 0;
  return d / dt;
}

// Fuse GPS and stroke-based distance into the display value.
// Inputs:
//   ctx: {
//     mode: 'fused'|'gps'|'stroke',
//     gpsDistance, strokeCount, effectiveDps,
//     lastGpsAt, now, freezeSnapshot
//   }
// Returns: { fusedDistance, strokeDistance, source, newFreezeSnapshot }
export function fuse(ctx) {
  const strokeDistance = ctx.strokeCount * ctx.effectiveDps;
  const gpsFresh = ctx.lastGpsAt > 0 && (ctx.now - ctx.lastGpsAt) < 5000;

  if (ctx.mode === 'gps') {
    return {
      fusedDistance: ctx.gpsDistance,
      strokeDistance,
      source: gpsFresh ? 'GPS' : 'GPS•LOST',
      newFreezeSnapshot: null,
    };
  }
  if (ctx.mode === 'stroke') {
    return {
      fusedDistance: strokeDistance,
      strokeDistance,
      source: 'STROKE',
      newFreezeSnapshot: null,
    };
  }

  // fused
  if (gpsFresh) {
    return {
      fusedDistance: ctx.gpsDistance,
      strokeDistance,
      source: 'GPS',
      newFreezeSnapshot: null, // reset
    };
  }
  // GPS not fresh: freeze + estimate from strokes
  const snapshot = ctx.freezeSnapshot || {
    strokesAtFreeze: ctx.strokeCount,
    gpsDistAtFreeze: ctx.gpsDistance,
  };
  const extraStrokes = ctx.strokeCount - snapshot.strokesAtFreeze;
  const fusedDistance = snapshot.gpsDistAtFreeze + extraStrokes * ctx.effectiveDps;
  return {
    fusedDistance,
    strokeDistance,
    source: extraStrokes > 0 ? 'STROKE•FALLBACK' : 'GPS•LOST',
    newFreezeSnapshot: snapshot,
  };
}

// Auto-recalibrate DPS from GPS truth. Returns updated samples and sessionDps.
export function updateDpsSamples(state, { strokeCount, gpsDistance, gpsFresh, sampleInterval = 20 }) {
  if (!gpsFresh || strokeCount < 10) {
    return { samples: state.samples, sessionDps: state.sessionDps };
  }
  const samples = state.samples.slice();
  const last = samples[samples.length - 1];
  let sessionDps = state.sessionDps;
  if (!last || (strokeCount - last.strokes) >= sampleInterval) {
    samples.push({ strokes: strokeCount, gpsD: gpsDistance });
    if (samples.length > 10) samples.shift();
    const oldest = samples[0];
    const dStrokes = strokeCount - oldest.strokes;
    const dDist = gpsDistance - oldest.gpsD;
    if (dStrokes > 0 && dDist > 5) {
      sessionDps = dDist / dStrokes;
    }
  }
  return { samples, sessionDps };
}
