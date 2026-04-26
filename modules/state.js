// State management: live session state + persistent prefs/sessions with schema versioning.

import { get as idbGet, set as idbSet, del as idbDel } from './idb.js';

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
  sensitivity: 0.5,
  minInterval: 700,
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
    timeline: [],         // 5s snapshots for the History detail scrubber
    lastTimelineAt: 0,
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

// ----- SESSIONS (IndexedDB, async) -----
// IndexedDB gives us hundreds of MB and an async API that won't block the
// main thread when serialising long sessions. On first read we silently
// migrate any pre-existing localStorage data into IDB and clean up.

export async function loadSessions() {
  try {
    let sessions = await idbGet(SESSIONS_KEY);
    if (sessions === undefined) {
      const rawLocal = localStorage.getItem(SESSIONS_KEY);
      if (rawLocal) {
        try {
          const parsed = JSON.parse(rawLocal);
          sessions = Array.isArray(parsed) ? parsed : [];
        } catch { sessions = []; }
        await idbSet(SESSIONS_KEY, sessions);
        localStorage.removeItem(SESSIONS_KEY);
        console.log('Migrated', sessions.length, 'sessions from localStorage to IndexedDB');
      } else {
        sessions = [];
      }
    }
    if (!Array.isArray(sessions)) return [];
    return sessions.map(migrateSession).filter(Boolean);
  } catch (e) {
    console.warn('Failed to load sessions:', e);
    return [];
  }
}

export async function saveSessions(sessions) {
  try {
    await idbSet(SESSIONS_KEY, sessions);
  } catch (e) {
    console.error('Failed to save sessions to IndexedDB:', e);
    throw e;
  }
}

export async function addSession(session) {
  const arr = await loadSessions();
  arr.unshift({ ...session, schemaVersion: SCHEMA_VERSION });
  await saveSessions(arr);
  return arr;
}

export async function clearSessions() {
  await idbDel(SESSIONS_KEY);
  localStorage.removeItem(SESSIONS_KEY);   // belt + braces in case migration was skipped
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
