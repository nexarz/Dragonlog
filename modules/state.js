// State management: live session state + persistent prefs/sessions with schema versioning.

const PREF_KEY     = 'dragonlog_prefs';
const SESSIONS_KEY = 'dragonlog_sessions';

export const SCHEMA_VERSION = 1;

export const DEFAULT_PROFILES = [
  { id: 'oc1',      name: 'OC1',       dps: 2.4, calibrated: false },
  { id: 'fullcrew', name: 'Full Crew', dps: 3.0, calibrated: false },
];

export const DEFAULT_PREFS = {
  schemaVersion: SCHEMA_VERSION,
  units: 'metric',
  sensitivity: 1.8,
  minInterval: 300,
  distMode: 'fused',
  autoRecal: 1,
  activeProfileId: 'oc1',
  profiles: DEFAULT_PROFILES,
};

// Live (non-persistent) session state. Mutable, centralized.
export function createState() {
  return {
    running: false,
    paused: false,
    startTime: 0,
    pausedAt: 0,
    pausedTotal: 0,
    strokes: [],          // stroke timestamps (ms)
    positions: [],        // GPS fixes
    gpsDistance: 0,
    strokeDistance: 0,
    fusedDistance: 0,
    splits: [],
    lastSplitTime: 0,
    lastSplitDist: 0,
    lastSplitStrokes: 0,
    spmHistory: [],
    lastGpsAt: 0,
    gpsHealthy: false,
    distanceSource: '—',
    sessionDps: null,
    dpsCalibSamples: [],
    freezeSnapshot: null,
    calibrating: false,
  };
}

// ----- PREFS -----

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return structuredClone(DEFAULT_PREFS);
    const parsed = JSON.parse(raw);
    return migratePrefs(parsed);
  } catch (e) {
    console.warn('Failed to load prefs, using defaults:', e);
    return structuredClone(DEFAULT_PREFS);
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.error('Failed to save prefs:', e);
  }
}

function migratePrefs(data) {
  const v = data.schemaVersion || 0;
  let d = { ...DEFAULT_PREFS, ...data };
  // Future migrations go here:
  //   if (v < 2) { ... }
  //   if (v < 3) { ... }
  if (!Array.isArray(d.profiles) || d.profiles.length === 0) {
    d.profiles = structuredClone(DEFAULT_PROFILES);
  }
  d.schemaVersion = SCHEMA_VERSION;
  return d;
}

export function getActiveProfile(prefs) {
  return prefs.profiles.find(p => p.id === prefs.activeProfileId) || prefs.profiles[0];
}

// ----- SESSIONS -----

export function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(migrateSession).filter(Boolean);
  } catch (e) {
    console.warn('Failed to load sessions:', e);
    return [];
  }
}

export function saveSessions(sessions) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch (e) {
    // Quota errors are the most likely culprit — surface to caller
    console.error('Failed to save sessions:', e);
    throw e;
  }
}

export function addSession(session) {
  const arr = loadSessions();
  arr.unshift({ ...session, schemaVersion: SCHEMA_VERSION });
  saveSessions(arr);
  return arr;
}

export function clearSessions() {
  localStorage.removeItem(SESSIONS_KEY);
}

function migrateSession(s) {
  if (!s || typeof s !== 'object') return null;
  // Future migrations go here:
  //   if ((s.schemaVersion ?? 0) < 2) { ... }
  return { schemaVersion: SCHEMA_VERSION, ...s };
}

// Polyfill structuredClone for older browsers that might still be around.
if (typeof structuredClone === 'undefined') {
  globalThis.structuredClone = obj => JSON.parse(JSON.stringify(obj));
}
