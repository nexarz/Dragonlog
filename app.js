// DRAGON//LOG — dragonboat training tracker
// Main entry point: wires modules together and owns the UI layer.

import {
  createState, loadPrefs, savePrefs, getActiveProfile,
  loadSessions, saveSessions, addSession, clearSessions,
  DEFAULT_PROFILES, SCHEMA_VERSION,
} from './modules/state.js';
import {
  computeSpm, computeSpeedMS, fuse, updateDpsSamples,
} from './modules/fusion.js';
import {
  needsMotionPermission, requestMotionPermission,
  createStrokeDetector, createGpsWatcher, acquireWakeLock,
} from './modules/sensors.js';
import {
  fmtTime, fmtSpeed, fmtDist, fmtDps, fmtPace500, escapeHtml,
} from './modules/format.js';

const APP_VERSION = '1.0.0';
const $ = id => document.getElementById(id);

// ---------- State ----------
const state = createState();
const prefs = loadPrefs();
let wakeLock = null;
let liveShakeReading = 0;

// ---------- Sensors ----------
const strokeDetector = createStrokeDetector({
  getSensitivity: () => prefs.sensitivity,
  getMinInterval: () => prefs.minInterval,
  onStroke: (t) => {
    if (!state.running || state.paused) return;
    state.strokes.push(t);
    if (navigator.vibrate) navigator.vibrate(12);
  },
  onLiveReading: (delta) => {
    liveShakeReading = delta;
  },
});

const gps = createGpsWatcher({
  onUpdate: (entry) => {
    if (!state.running || state.paused) return;
    state.gpsDistance += entry.distanceDelta;
    state.lastGpsAt = entry.t;
    state.positions.push(entry);
  },
  onStatus: (status) => {
    const map = {
      live: 'GPS LIVE', searching: 'GPS SEARCHING',
      error: 'GPS ERROR', off: 'GPS OFF', unavailable: 'GPS UNAVAIL',
    };
    $('gpsStatus').textContent = map[status] || 'GPS —';
    const dot = $('gpsDot');
    dot.classList.toggle('live', status === 'live');
    dot.classList.toggle('err', status === 'error' || status === 'unavailable');
  },
});

// ---------- Permissions bootstrap ----------
async function ensurePermissions() {
  if (needsMotionPermission()) {
    const res = await requestMotionPermission();
    if (res !== 'granted') {
      alert('Motion permission denied. Stroke detection will not work.');
    }
  }
  if (navigator.geolocation) {
    // Prompt for location early
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, { enableHighAccuracy: true });
  }
  strokeDetector.attach();
  $('permsPrompt').style.display = 'none';
  window.__permsGranted = true;
}

if (needsMotionPermission()) {
  $('permsPrompt').style.display = 'block';
} else {
  strokeDetector.attach();
}
$('requestPerms').addEventListener('click', ensurePermissions);

// ---------- Session control ----------
async function startSession() {
  if (needsMotionPermission() && !window.__permsGranted) {
    await ensurePermissions();
  }
  Object.assign(state, createState(), { running: true, startTime: Date.now() });
  gps.start();
  wakeLock = await acquireWakeLock();
  toggleControls('running');
  renderSplits();
}
function pauseSession() {
  state.paused = true;
  state.pausedAt = Date.now();
  toggleControls('paused');
}
function resumeSession() {
  if (state.pausedAt) {
    state.pausedTotal += Date.now() - state.pausedAt;
    state.pausedAt = 0;
  }
  state.paused = false;
  toggleControls('running');
}
function stopSession() {
  if (!state.running) return;
  const final = buildSession();
  state.running = false;
  state.paused = false;
  gps.stop();
  if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
  toggleControls('idle');
  if (final.durationSec > 5) {
    try {
      addSession(final);
    } catch (e) {
      alert('Could not save session — storage full? Try exporting and clearing old sessions.');
    }
  }
}
function addSplit() {
  const ms = elapsedMs();
  const splitTimeMs = ms - state.lastSplitTime;
  const splitDist = state.fusedDistance - state.lastSplitDist;
  const splitStrokes = state.strokes.length - state.lastSplitStrokes;
  const spmAvg = splitTimeMs > 0 ? Math.round(splitStrokes / (splitTimeMs / 60000)) : 0;
  state.splits.push({
    n: state.splits.length + 1,
    timeMs: splitTimeMs,
    distM: splitDist,
    spm: spmAvg,
  });
  state.lastSplitTime = ms;
  state.lastSplitDist = state.fusedDistance;
  state.lastSplitStrokes = state.strokes.length;
  renderSplits();
  if (navigator.vibrate) navigator.vibrate([30, 20, 30]);
}
function elapsedMs() {
  if (!state.running) return 0;
  const now = state.paused ? state.pausedAt : Date.now();
  return now - state.startTime - state.pausedTotal;
}
function toggleControls(mode) {
  $('trainControls').style.display   = mode === 'idle' ? 'flex' : 'none';
  $('runningControls').style.display = mode === 'running' ? 'flex' : 'none';
  $('pausedControls').style.display  = mode === 'paused' ? 'flex' : 'none';
}
function buildSession() {
  const durMs = elapsedMs();
  const prof = getActiveProfile(prefs);
  return {
    id: Date.now(),
    date: new Date().toISOString(),
    durationSec: Math.round(durMs / 1000),
    distanceM: Math.round(state.fusedDistance),
    gpsDistanceM: Math.round(state.gpsDistance),
    strokeDistanceM: Math.round(state.strokeDistance),
    strokes: state.strokes.length,
    avgSpm: durMs > 0 ? Math.round(state.strokes.length / (durMs / 60000)) : 0,
    avgSpeedMS: durMs > 0 ? state.fusedDistance / (durMs / 1000) : 0,
    avgDps: state.strokes.length > 0 ? state.fusedDistance / state.strokes.length : 0,
    profileId: prof.id,
    profileName: prof.name,
    distMode: prefs.distMode,
    splits: state.splits,
    track: state.positions.map(p => ({ t: p.t, lat: p.lat, lon: p.lon })),
  };
}

// ---------- Fusion update (called each render tick) ----------
function updateFusion() {
  const prof = getActiveProfile(prefs);
  const effectiveDps = state.sessionDps != null ? state.sessionDps : prof.dps;
  const now = Date.now();

  const result = fuse({
    mode: prefs.distMode,
    gpsDistance: state.gpsDistance,
    strokeCount: state.strokes.length,
    effectiveDps,
    lastGpsAt: state.lastGpsAt,
    now,
    freezeSnapshot: state.freezeSnapshot,
  });
  state.fusedDistance = result.fusedDistance;
  state.strokeDistance = result.strokeDistance;
  state.distanceSource = result.source;
  state.freezeSnapshot = result.newFreezeSnapshot;

  if (prefs.autoRecal) {
    const gpsFresh = state.lastGpsAt > 0 && (now - state.lastGpsAt) < 5000;
    const recal = updateDpsSamples(
      { samples: state.dpsCalibSamples, sessionDps: state.sessionDps },
      { strokeCount: state.strokes.length, gpsDistance: state.gpsDistance, gpsFresh },
    );
    state.dpsCalibSamples = recal.samples;
    state.sessionDps = recal.sessionDps;
  }
}

// ---------- Render loop ----------
function render() {
  if (state.running) updateFusion();

  const ms = elapsedMs();
  $('timer').innerHTML = state.running
    ? fmtTime(ms, true).replace(/\.(\d)$/, '<span class="ms">.$1</span>')
    : '00:00<span class="ms">.0</span>';

  const spm = computeSpm(state.strokes);
  $('spm').textContent = spm;
  $('strokeCount').textContent = `${state.strokes.length} strokes`;

  const speedMS = computeSpeedMS(state.positions);
  $('speed').textContent = fmtSpeed(speedMS, prefs.units);
  $('pace').textContent = fmtPace500(speedMS);
  $('distance').textContent = fmtDist(state.fusedDistance, prefs.units);

  const avgMS = ms > 0 ? state.fusedDistance / (ms / 1000) : 0;
  $('avgSpeed').textContent = fmtSpeed(avgMS, prefs.units);

  const prof = getActiveProfile(prefs);
  const liveDps = state.sessionDps != null ? state.sessionDps
                 : (prof && prof.calibrated ? prof.dps : null);
  $('dpsLive').textContent = liveDps != null ? fmtDps(liveDps, prefs.units) : '—';
  $('dpsSource').textContent = state.running
    ? `src: ${state.distanceSource.toLowerCase()}`
    : (prof ? `profile: ${prof.name.toLowerCase()}` : 'no profile');

  $('liveShake').textContent = liveShakeReading.toFixed(2);

  // SPM history sample
  if (state.running && !state.paused) {
    const now = Date.now();
    const last = state.spmHistory[state.spmHistory.length - 1];
    if (!last || now - last.t > 1000) {
      state.spmHistory.push({ t: now, spm });
      if (state.spmHistory.length > 60) state.spmHistory.shift();
    }
  }
  renderSpark();
}
function renderSpark() {
  const svg = $('sparkSpm');
  const w = 300, h = 80;
  const pts = state.spmHistory;
  if (pts.length < 2) {
    svg.innerHTML = '<text x="150" y="44" text-anchor="middle" fill="#4a5254" font-family="JetBrains Mono" font-size="10" letter-spacing="2">WAITING FOR DATA</text>';
    return;
  }
  const max = Math.max(...pts.map(p => p.spm), 60);
  const xStep = w / Math.max(pts.length - 1, 1);
  let d = '';
  pts.forEach((p, i) => {
    const x = i * xStep;
    const y = h - ((p.spm) / (max || 1)) * (h - 10) - 5;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  });
  const area = d + `L${w},${h}L0,${h}Z`;
  svg.innerHTML = `
    <defs>
      <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ff3c28" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#ff3c28" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#g1)"/>
    <path d="${d}" fill="none" stroke="#ff3c28" stroke-width="1.5" stroke-linejoin="round"/>
  `;
}

// ---------- Splits ----------
function renderSplits() {
  const container = $('splitsList');
  if (!state.splits.length) {
    container.innerHTML = '<div class="splits-empty">Tap LAP during a session to mark splits</div>';
    return;
  }
  container.innerHTML = state.splits.map(s => {
    const pace = s.distM > 0 ? fmtPace500(s.distM / (s.timeMs / 1000)) : '—';
    return `<div class="split-row">
      <div class="n">${s.n}</div>
      <div>${fmtTime(s.timeMs, false)}</div>
      <div>${fmtDist(s.distM, prefs.units)}${prefs.units === 'metric' ? 'm' : 'yd'}</div>
      <div>${pace}</div>
      <div>${s.spm}</div>
    </div>`;
  }).join('');
}

// ---------- History ----------
function renderHistory() {
  const list = $('historyList');
  const sessions = loadSessions();
  if (!sessions.length) {
    list.innerHTML = `<div class="empty">
      <h2>No Sessions Yet</h2>
      <p>Start your first training to see history here.</p>
    </div>`;
    return;
  }
  list.innerHTML = sessions.map(s => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
                    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const durStr = fmtTime(s.durationSec * 1000, false);
    const profileBadge = s.profileName
      ? `<span class="session-profile-badge">· ${escapeHtml(s.profileName.toUpperCase())}</span>`
      : '';
    return `<div class="session-card">
      <div class="session-date">${dateStr}${profileBadge}</div>
      <div class="session-stats">
        <div class="session-stat"><div class="l">TIME</div><div class="v">${durStr}</div></div>
        <div class="session-stat"><div class="l">DIST</div><div class="v">${fmtDist(s.distanceM, prefs.units)}</div></div>
        <div class="session-stat"><div class="l">AVG SPM</div><div class="v">${s.avgSpm}</div></div>
        <div class="session-stat"><div class="l">AVG SPD</div><div class="v">${fmtSpeed(s.avgSpeedMS, prefs.units)}</div></div>
      </div>
    </div>`;
  }).join('');
}

// ---------- Profiles ----------
function renderProfilePills() {
  const bar = $('profilePills');
  bar.innerHTML = prefs.profiles.map(p => {
    const active = p.id === prefs.activeProfileId ? ' active' : '';
    const dpsTxt = p.calibrated
      ? `<span class="dps">${fmtDps(p.dps, prefs.units)}${prefs.units === 'metric' ? 'm' : 'yd'}</span>`
      : '<span class="dps">uncal</span>';
    return `<div class="pill${active}" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}${dpsTxt}</div>`;
  }).join('');
  bar.querySelectorAll('.pill').forEach(el => {
    el.addEventListener('click', () => {
      if (state.running) return;
      prefs.activeProfileId = el.dataset.id;
      savePrefs(prefs);
      renderProfilePills();
      renderProfileList();
    });
  });
}
function renderProfileList() {
  const list = $('profileList');
  list.innerHTML = prefs.profiles.map(p => {
    const isActive = p.id === prefs.activeProfileId;
    const status = p.calibrated
      ? `${fmtDps(p.dps, prefs.units)} ${prefs.units === 'metric' ? 'm' : 'yd'}/stroke`
      : 'Not calibrated';
    const statusClass = p.calibrated ? 'cal' : 'uncal';
    const delBtn = prefs.profiles.length > 1
      ? `<button class="btn btn-ghost btn-compact danger-btn" data-action="del" data-id="${escapeHtml(p.id)}">✕</button>`
      : '';
    return `<div class="profile-row">
      <div class="profile-row-main">
        <div class="profile-row-name">${escapeHtml(p.name)}${isActive ? '<span class="profile-row-active">· ACTIVE</span>' : ''}</div>
        <div class="profile-row-status ${statusClass}">${status}</div>
      </div>
      <button class="btn btn-ghost btn-compact" data-action="calib" data-id="${escapeHtml(p.id)}">CALIB</button>
      ${delBtn}
    </div>`;
  }).join('');
  list.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => onProfileAction(btn.dataset.action, btn.dataset.id));
  });
}
function onProfileAction(action, id) {
  if (action === 'calib') {
    prefs.activeProfileId = id;
    savePrefs(prefs);
    renderProfilePills();
    renderProfileList();
    openCalibration();
  } else if (action === 'del') {
    const p = prefs.profiles.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`Delete profile "${p.name}"?`)) return;
    prefs.profiles = prefs.profiles.filter(x => x.id !== id);
    if (prefs.activeProfileId === id) prefs.activeProfileId = prefs.profiles[0].id;
    savePrefs(prefs);
    renderProfilePills();
    renderProfileList();
  }
}

// ---------- Calibration ----------
const calib = { active: false, startTime: 0, distance: 200, resultDps: 0, resultStrokes: 0 };

function openCalibration() {
  const prof = getActiveProfile(prefs);
  $('calibTitle').textContent = `CALIBRATE · ${prof.name.toUpperCase()}`;
  $('calibStep1').style.display = '';
  $('calibStep2').style.display = 'none';
  $('calibStep3').style.display = 'none';
  $('calibModal').classList.add('active');
}
function closeCalibration() {
  $('calibModal').classList.remove('active');
  calib.active = false;
  state.running = false;
  state.calibrating = false;
}

// Live update of calibration step 2
setInterval(() => {
  if (!calib.active) return;
  const dur = Date.now() - calib.startTime;
  $('calibTime').textContent = fmtTime(dur, false);
  $('calibStrokes').textContent = state.strokes.length;
  $('calibSpm').textContent = computeSpm(state.strokes);
}, 200);

// ---------- Service worker / update flow ----------
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    $('offlineStatus').textContent = 'Not supported';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    $('offlineStatus').textContent = 'Ready';
    // check for new versions
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          $('updateToast').style.display = 'flex';
          $('updateBtn').addEventListener('click', () => {
            worker.postMessage({ type: 'SKIP_WAITING' });
            location.reload();
          });
        }
      });
    });
  } catch (e) {
    console.warn('SW registration failed:', e);
    $('offlineStatus').textContent = 'Failed';
  }
}

// ---------- Wiring: settings controls ----------
function initSettingsControls() {
  $('sensitivity').value = prefs.sensitivity;
  $('sensVal').textContent = prefs.sensitivity.toFixed(1);
  $('minInterval').value = prefs.minInterval;
  $('units').value = prefs.units;
  $('distMode').value = prefs.distMode;
  $('autoRecal').value = String(prefs.autoRecal);
  $('appVersion').textContent = APP_VERSION;

  $('sensitivity').addEventListener('input', e => {
    prefs.sensitivity = parseFloat(e.target.value);
    $('sensVal').textContent = prefs.sensitivity.toFixed(1);
    savePrefs(prefs);
  });
  $('minInterval').addEventListener('change', e => {
    prefs.minInterval = parseInt(e.target.value, 10) || 300;
    savePrefs(prefs);
  });
  $('units').addEventListener('change', e => {
    prefs.units = e.target.value;
    savePrefs(prefs);
    updateUnitLabels();
    render();
  });
  $('distMode').addEventListener('change', e => {
    prefs.distMode = e.target.value;
    savePrefs(prefs);
  });
  $('autoRecal').addEventListener('change', e => {
    prefs.autoRecal = parseInt(e.target.value, 10);
    savePrefs(prefs);
  });
  $('addProfileBtn').addEventListener('click', () => {
    const name = ($('newProfileName').value || '').trim();
    if (!name) return;
    const id = 'p_' + Date.now();
    prefs.profiles.push({ id, name, dps: 2.5, calibrated: false });
    prefs.activeProfileId = id;
    savePrefs(prefs);
    $('newProfileName').value = '';
    renderProfilePills();
    renderProfileList();
  });
  $('exportBtn').addEventListener('click', () => {
    const data = loadSessions();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dragonlog_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  $('clearBtn').addEventListener('click', () => {
    if (confirm('Delete all saved sessions? This cannot be undone.')) {
      clearSessions();
      $('sessionCount').textContent = '0';
      renderHistory();
    }
  });
}
function updateUnitLabels() {
  $('speedUnit').textContent = prefs.units === 'metric' ? 'KM/H' : 'MPH';
  $('distUnit').textContent  = prefs.units === 'metric' ? 'M' : 'YD';
  $('dpsUnit').textContent   = prefs.units === 'metric' ? 'M' : 'YD';
}

// ---------- Wiring: tabs ----------
function initTabs() {
  document.querySelectorAll('nav.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      $('view-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'history') renderHistory();
      if (btn.dataset.tab === 'settings') {
        $('sessionCount').textContent = loadSessions().length;
        renderProfileList();
      }
    });
  });
}

// ---------- Wiring: session buttons ----------
function initSessionControls() {
  $('startBtn').addEventListener('click', startSession);
  $('pauseBtn').addEventListener('click', pauseSession);
  $('resumeBtn').addEventListener('click', resumeSession);
  $('stopBtn').addEventListener('click', stopSession);
  $('stopBtn2').addEventListener('click', stopSession);
  $('lapBtn').addEventListener('click', addSplit);

  // Calibration buttons
  $('calibBtn').addEventListener('click', async () => {
    if (needsMotionPermission() && !window.__permsGranted) {
      await ensurePermissions();
    }
    openCalibration();
  });
  $('calibCancel1').addEventListener('click', closeCalibration);
  $('calibCancel2').addEventListener('click', closeCalibration);
  $('calibStart').addEventListener('click', () => {
    calib.distance = parseFloat($('calibDistance').value) || 200;
    $('calibTargetDist').textContent = `${Math.round(calib.distance)}m`;
    calib.active = true;
    calib.startTime = Date.now();
    // reuse state for stroke counting during calibration
    Object.assign(state, createState(), {
      running: true,
      calibrating: true,
      startTime: Date.now(),
    });
    $('calibStep1').style.display = 'none';
    $('calibStep2').style.display = '';
  });
  $('calibStop').addEventListener('click', () => {
    const strokes = state.strokes.length;
    const dps = strokes > 0 ? calib.distance / strokes : 0;
    calib.resultDps = dps;
    calib.resultStrokes = strokes;
    calib.active = false;
    state.running = false;
    state.calibrating = false;
    $('calibResultDist').textContent = `${Math.round(calib.distance)}m`;
    $('calibResultStrokes').textContent = strokes;
    $('calibResultDps').textContent = dps > 0 ? fmtDps(dps, prefs.units) : '—';
    $('calibStep2').style.display = 'none';
    $('calibStep3').style.display = '';
  });
  $('calibRedo').addEventListener('click', () => {
    $('calibStep3').style.display = 'none';
    $('calibStep1').style.display = '';
  });
  $('calibSave').addEventListener('click', () => {
    if (calib.resultDps > 0 && calib.resultStrokes >= 5) {
      const prof = getActiveProfile(prefs);
      prof.dps = calib.resultDps;
      prof.calibrated = true;
      savePrefs(prefs);
      renderProfilePills();
      renderProfileList();
    } else {
      alert('Not enough strokes detected. Try again — check phone mount and sensitivity.');
      return;
    }
    closeCalibration();
  });
}

// ---------- Re-acquire wake lock when tab becomes visible ----------
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.running && !wakeLock) {
    wakeLock = await acquireWakeLock();
  }
});

// ---------- Boot ----------
initTabs();
initSettingsControls();
initSessionControls();
updateUnitLabels();
renderProfilePills();
$('sessionCount').textContent = loadSessions().length;
registerServiceWorker();

setInterval(render, 100);
render();
