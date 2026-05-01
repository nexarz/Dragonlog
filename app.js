// DRAGON//LOG — dragonboat training tracker
// Main entry point: wires modules together and owns the UI layer.
import * as audio from './modules/audio.js';
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
import {
  loadWorkouts, upsertWorkout, deleteWorkout,
  newWorkout, newInterval, intervalDisplay, fmtDur, totalWorkoutSec,
} from './modules/workout.js';
import { createPlayer } from './modules/player.js';
import { createPhysicsTracker } from './modules/physics.js';
import { encodeSession, decodeSession } from './modules/share.js';
import { joinRoom, buildRoomToken } from './modules/live.js';

const APP_VERSION = '1.1.0';
const $ = id => document.getElementById(id);

// ---------- State ----------
const state = createState();
const prefs = loadPrefs();
let wakeLock = null;
let liveShakeReading = 0;

// ---------- Workout Player + Physics ----------
const player = createPlayer();
const physics = createPhysicsTracker();
let currentViewedSessionId = null;   // for share button
let playerStatus  = null;
let alertHideTimer = null;
let currentEditWorkout = null;  // workout open in builder

// ---------- Live / Pack mode ----------
let liveSession  = null;
let liveRole     = null;
let activeRoomId = null;
let liveBroadcastTick = 0;

// ---------- Sensors ----------
const strokeDetector = createStrokeDetector({
  getSensitivity: () => prefs.sensitivity,
  getMinInterval: () => prefs.minInterval,
  onStroke: (t) => {
    if (!state.running || state.paused) return;
    state.strokes.push(t);
    physics.onStroke();
    if (navigator.vibrate) navigator.vibrate(12);
  },
  onMotion: (ev) => {
    if (state.running && !state.paused) physics.addSample(ev);
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
  audio.unlockAudio();
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
async function startSession({ remote = false } = {}) {
  audio.unlockAudio();
  if (needsMotionPermission() && !window.__permsGranted) {
    await ensurePermissions();
  }
  Object.assign(state, createState(), { running: true, startTime: Date.now() });
  physics.reset();
  sparkDirty = true;
  gps.start();
  wakeLock = await acquireWakeLock();
  toggleControls('running');
  if (player.loaded) player.start();
  // Coach's local tap broadcasts to the pack
  if (!remote && liveSession && liveRole === 'coach') {
    const data = player.loaded ? { workout: player.workout } : {};
    liveSession.sendCommand('START', data);
  }
}
function pauseSession() {
  state.paused = true;
  state.pausedAt = Date.now();
  player.pause();
  toggleControls('paused');
}
function resumeSession() {
  if (state.pausedAt) {
    state.pausedTotal += Date.now() - state.pausedAt;
    state.pausedAt = 0;
  }
  state.paused = false;
  player.resume();
  toggleControls('running');
}
async function stopSession({ remote = false } = {}) {
  if (!state.running) return;
  const final = buildSession();
  state.running = false;
  state.paused = false;
  gps.stop();
  player.stop();
  if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
  toggleControls('idle');
  renderWorkoutPlayer();
  if (!remote && liveSession && liveRole === 'coach') {
    liveSession.sendCommand('STOP');
  }
  if (final.durationSec > 5) {
    try {
      await addSession(final);
    } catch (e) {
      alert('Could not save session — storage error. Try exporting and clearing old sessions.');
    }
  }
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
    avgCheck:  physics.avgCheck,
    avgBounce: physics.avgBounce,
    profileId: prof.id,
    profileName: prof.name,
    distMode: prefs.distMode,
    splits: state.splits,
    timeline: state.timeline,
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

// ---------- Workout player render ----------
function renderWorkoutPlayer() {
  const el = $('workoutPlayer');
  if (!player.loaded) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.className = 'workout-player';
  const w = player.workout;

  if (!state.running || !player.active) {
    const totalMin = Math.round(totalWorkoutSec(w) / 60);
    el.innerHTML = `
      <div class="wp-header">
        <div class="wp-name">${escapeHtml(w.name.toUpperCase())}</div>
        <button class="btn btn-ghost btn-compact" id="unloadBtn">UNLOAD</button>
      </div>
      <div class="wp-ready">${w.intervals.length} INTERVALS · ~${totalMin} MIN · READY</div>`;
    $('unloadBtn').addEventListener('click', () => {
      player.unload(); renderWorkoutPlayer();
    });
    return;
  }

  if (!playerStatus || playerStatus.type === 'complete') {
    el.style.display = 'none'; return;
  }

  const { currentInterval, nextInterval, remainingMs, totalIntervals, currentIdx } = playerStatus;
  const pct   = Math.round(((currentIdx + 1) / totalIntervals) * 100);
  const remS  = Math.ceil(remainingMs / 1000);
  const remM  = Math.floor(remS / 60);
  const remSS = String(remS % 60).padStart(2, '0');

  el.innerHTML = `
    <div class="wp-header">
      <div class="wp-name">${escapeHtml(w.name.toUpperCase())}</div>
      <div class="wp-progress">
        <div class="wp-progress-bar"><div class="wp-progress-fill" style="width:${pct}%"></div></div>
        <div class="wp-counter">${currentIdx + 1}/${totalIntervals}</div>
      </div>
    </div>
    <div class="wp-body">
      <div class="wp-current">
        <div class="wp-label">CURRENT</div>
        <div class="wp-interval-name">${intervalDisplay(currentInterval)}</div>
        <div class="wp-countdown">${remM}:${remSS}</div>
      </div>
      <div class="wp-next">
        ${nextInterval
          ? `<div class="wp-label">NEXT</div>
             <div class="wp-next-name">${intervalDisplay(nextInterval)}</div>
             <div class="wp-next-dur">${fmtDur(nextInterval.durationSec)}</div>`
          : `<div class="wp-label">FINAL INTERVAL</div>`}
      </div>
    </div>`;
}

function showWorkoutAlert(type) {
  const el = $('workoutAlertBanner');
  el.textContent = type === 'spm'
    ? '⚡ INCREASE STROKE RATE'
    : '⚡ DRIVE HARDER — MAINTAIN DPS';
  el.style.display = '';
  clearTimeout(alertHideTimer);
  alertHideTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ---------- DOM delta helpers ----------
// Touching the DOM is the slowest thing the render loop does. Cache last-written
// values so we only update nodes whose content actually changed.
const domCache = {};
function setText(id, value) {
  const v = String(value);
  if (domCache[id] !== v) {
    document.getElementById(id).textContent = v;
    domCache[id] = v;
  }
}
function setHTML(id, value) {
  if (domCache[id] !== value) {
    document.getElementById(id).innerHTML = value;
    domCache[id] = value;
  }
}
let sparkDirty = true;   // re-render sparkline only when spmHistory mutates

// ---------- Render loop ----------
function render() {
  if (state.running) updateFusion();

  // Tick workout player
  if (state.running && !state.paused && player.active) {
    const prof       = getActiveProfile(prefs);
    const effectDps  = state.sessionDps != null ? state.sessionDps : prof.dps;
    playerStatus = player.tick(state, effectDps);
    if (playerStatus?.alert) showWorkoutAlert(playerStatus.alert);
    if (playerStatus?.type === 'complete') {
      setTimeout(() => { if (state.running) stopSession(); }, 3500);
    }
  }

  const ms = elapsedMs();
  setHTML('timer', state.running
    ? fmtTime(ms, true).replace(/\.(\d)$/, '<span class="ms">.$1</span>')
    : '00:00<span class="ms">.0</span>');

  const spm = computeSpm(state.strokes);
  setText('spm', spm);
  setText('strokeCount', `${state.strokes.length} strokes`);

  const speedMS = computeSpeedMS(state.positions);
  setText('pace', fmtPace500(speedMS));
  setText('distance', fmtDist(state.fusedDistance, prefs.units));

  const avgMS = ms > 0 ? state.fusedDistance / (ms / 1000) : 0;
  setText('avgPace', fmtPace500(avgMS));

  const prof = getActiveProfile(prefs);
  const liveDps = state.sessionDps != null ? state.sessionDps
                 : (prof && prof.calibrated ? prof.dps : null);
  setText('dpsLive', liveDps != null ? fmtDps(liveDps, prefs.units) : '—');
  setText('dpsSource', state.running
    ? `src: ${state.distanceSource.toLowerCase()}`
    : (prof ? `profile: ${prof.name.toLowerCase()}` : 'no profile'));

  setText('liveShake', liveShakeReading.toFixed(2));

  setText('checkLive',  physics.totalCycles > 0 ? physics.liveCheck.toFixed(2)  : '—');
  setText('bounceLive', physics.totalCycles > 0 ? physics.liveBounce.toFixed(2) : '—');

  // 5-second timeline snapshot for the history scrubber
  if (state.running && !state.paused && Date.now() - state.lastTimelineAt >= 5000) {
    state.timeline.push({
      t: ms,
      spm,
      speed: speedMS,
      dps: liveDps || 0,
      check: physics.liveCheck || 0,
      bounce: physics.liveBounce || 0,
    });
    state.lastTimelineAt = Date.now();
  }

  // Broadcast live stats to pack room every 2s (paddler only)
  if (liveSession && liveRole === 'paddler' && state.running && !state.paused) {
    const now = Date.now();
    if (now - liveBroadcastTick >= 2000) {
      liveBroadcastTick = now;
      liveSession.updateStats({
        spm,
        pace: fmtPace500(speedMS),
        check: physics.totalCycles > 0 ? physics.liveCheck.toFixed(2) : '—',
      });
    }
  }

  // SPM history sample (1 Hz) — only mark spark dirty when a new point lands
  if (state.running && !state.paused) {
    const now = Date.now();
    const last = state.spmHistory[state.spmHistory.length - 1];
    if (!last || now - last.t > 1000) {
      state.spmHistory.push({ t: now, spm });
      if (state.spmHistory.length > 60) state.spmHistory.shift();
      sparkDirty = true;
    }
  }
  if (sparkDirty) { renderSpark(); sparkDirty = false; }
  renderWorkoutPlayer();
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


// ---------- Swipe-to-delete state ----------
let openSwipeWrap      = null;
let pointerDrag        = null;   // { id, startX, startY, startOffset, wrap, card, dir }
let suppressClickUntil = 0;

function openSwipe(wrap) {
  if (openSwipeWrap && openSwipeWrap !== wrap) closeSwipe(openSwipeWrap);
  const card = wrap.querySelector('.session-card');
  if (card) card.style.transform = 'translateX(-100px)';
  wrap.classList.add('swipe-open');
  openSwipeWrap = wrap;
}
function closeSwipe(wrap) {
  if (!wrap) return;
  const card = wrap.querySelector('.session-card');
  if (card) card.style.transform = '';
  wrap.classList.remove('swipe-open');
  if (openSwipeWrap === wrap) openSwipeWrap = null;
}
async function deleteSessionById(id) {
  if (!confirm('Delete this session?')) return;
  const sessions = await loadSessions();
  const filtered = sessions.filter(s => s.id !== id);
  await saveSessions(filtered);
  $('sessionCount').textContent = filtered.length;
  renderHistory();
}

// ---------- History ----------
async function renderHistory() {
  const list = $('historyList');
  const sessions = await loadSessions();
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
    return `<div class="session-card-wrap">
      <button class="session-card-delete" data-action="delete-session" data-id="${s.id}" aria-label="Delete session">DELETE</button>
      <div class="session-card" data-id="${s.id}">
        <div class="session-date">${dateStr}${profileBadge}</div>
        <div class="session-stats">
          <div class="session-stat"><div class="l">TIME</div><div class="v">${durStr}</div></div>
          <div class="session-stat"><div class="l">DIST</div><div class="v">${fmtDist(s.distanceM, prefs.units)}</div></div>
          <div class="session-stat"><div class="l">AVG SPM</div><div class="v">${s.avgSpm}</div></div>
          <div class="session-stat"><div class="l">AVG SPD</div><div class="v">${fmtSpeed(s.avgSpeedMS, prefs.units)}</div></div>
        </div>
      </div>
    </div>`;
  }).join('');
  // After re-render, no swipes are open
  openSwipeWrap = null;

}

// ---------- Timeline scrubber (history detail) ----------
function renderTouchTimeline(timeline) {
  if (!timeline || timeline.length < 2) return '';
  const last = timeline[timeline.length - 1];
  const W = 300, H = 40;

  function svgFor(values, label, color) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    const range = max - min || 1;
    const xStep = W / Math.max(values.length - 1, 1);
    let d = '';
    for (let i = 0; i < values.length; i++) {
      const x = i * xStep;
      const y = H - ((values[i] - min) / range) * (H - 8) - 4;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    return `<svg class="tl-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <text x="6" y="13" fill="${color}" opacity=".55"
            font-family="JetBrains Mono" font-weight="700" font-size="9" letter-spacing="2">${label}</text>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
  }

  const spms    = timeline.map(p => p.spm   || 0);
  const speeds  = timeline.map(p => p.speed || 0);
  const dpses   = timeline.map(p => p.dps   || 0);

  const C_SPM   = '#ff3c28';
  const C_SPEED = '#2ecc71';
  const C_DPS   = '#ffb800';

  return `
    <h3 class="history-detail-subheading">SESSION TIMELINE</h3>
    <div class="timeline-container">
      <div class="tl-readout">
        <div class="tl-time" id="tlTime">${fmtTime(last.t, false)}</div>
        <div class="tl-stats">
          <span id="tlSpm"  style="color:${C_SPM}">${last.spm} SPM</span>
          <span id="tlPace" style="color:${C_SPEED}">${fmtPace500(last.speed || 0)}</span>
          <span id="tlDps"  style="color:${C_DPS}">${(last.dps || 0).toFixed(2)}</span>
        </div>
      </div>
      <div class="tl-charts">
        ${svgFor(spms,   'SPM',   C_SPM)}
        ${svgFor(speeds, 'SPEED', C_SPEED)}
        ${svgFor(dpses,  'DPS',   C_DPS)}
        <div class="tl-crosshair"      id="tlCrosshair"></div>
        <div class="tl-touch-surface"  id="tlTouchSurface"></div>
      </div>
    </div>`;
}

function initTimelineScrubber(timeline) {
  const surface   = $('tlTouchSurface');
  const crosshair = $('tlCrosshair');
  const tEl   = $('tlTime');
  const spmEl = $('tlSpm');
  const pcEl  = $('tlPace');
  const dpsEl = $('tlDps');
  if (!surface || !crosshair) return;

  function update(clientX) {
    const rect = surface.getBoundingClientRect();
    let x = clientX - rect.left;
    if (x < 0) x = 0;
    if (x > rect.width) x = rect.width;
    crosshair.style.transform = `translateX(${x}px)`;
    crosshair.style.opacity = '1';
    const pct = rect.width > 0 ? x / rect.width : 0;
    const idx = Math.min(timeline.length - 1, Math.max(0, Math.round(pct * (timeline.length - 1))));
    const p = timeline[idx];
    tEl.textContent   = fmtTime(p.t, false);
    spmEl.textContent = `${p.spm} SPM`;
    pcEl.textContent  = fmtPace500(p.speed || 0);
    dpsEl.textContent = (p.dps || 0).toFixed(2);
  }

  function fadeOut() { crosshair.style.opacity = '0'; }

  let dragging = false;

  surface.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches[0]) update(e.touches[0].clientX);
  }, { passive: false });
  surface.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches[0]) update(e.touches[0].clientX);
  }, { passive: false });
  surface.addEventListener('touchend',    fadeOut);
  surface.addEventListener('touchcancel', fadeOut);

  surface.addEventListener('mousedown', e => { dragging = true;  update(e.clientX); });
  surface.addEventListener('mousemove', e => { if (dragging) update(e.clientX); });
  surface.addEventListener('mouseup',    () => { dragging = false; fadeOut(); });
  surface.addEventListener('mouseleave', () => { dragging = false; fadeOut(); });
}

// Render a session received via shared URL (no IndexedDB lookup)
function renderSharedSession(session) {
  currentViewedSessionId = null;
  // Hide SHARE button — recipient can re-share by copying URL from address bar
  $('shareSessionBtn').style.display = 'none';

  const d = new Date(session.date);
  const dateStr = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) +
                  ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const durStr  = fmtTime(session.durationSec * 1000, false);
  const avgDps  = session.avgDps > 0 ? fmtDps(session.avgDps, prefs.units) : '—';
  const pace    = session.avgSpeedMS > 0 ? fmtPace500(session.avgSpeedMS) : '—';
  const dpsUnit = prefs.units === 'metric' ? 'm' : 'yd';

  $('historyDetailContent').innerHTML = `
    <div class="shared-banner">SHARED SESSION · VIEW ONLY</div>
    <div class="setup">
      <h3>${dateStr}</h3>
      <div class="setup-row"><div class="setup-label">Profile</div><div class="setup-val">${escapeHtml(session.profileName || 'Unknown')}</div></div>
      <div class="setup-row"><div class="setup-label">Duration</div><div class="setup-val">${durStr}</div></div>
      <div class="setup-row"><div class="setup-label">Distance</div><div class="setup-val">${fmtDist(session.distanceM, prefs.units)} ${dpsUnit}</div></div>
      <div class="setup-row"><div class="setup-label">Avg Stroke Rate</div><div class="setup-val">${session.avgSpm} SPM</div></div>
      <div class="setup-row"><div class="setup-label">Avg Pace /500m</div><div class="setup-val">${pace}</div></div>
      <div class="setup-row"><div class="setup-label">Distance per Stroke</div><div class="setup-val">${avgDps} ${dpsUnit}</div></div>
      ${session.avgCheck > 0 ? `<div class="setup-row"><div class="setup-label">Avg Stern Check</div><div class="setup-val">${session.avgCheck.toFixed(2)} m/s²</div></div>` : ''}
      ${session.avgBounce > 0 ? `<div class="setup-row"><div class="setup-label">Avg Bounce</div><div class="setup-val">${session.avgBounce.toFixed(2)} m/s²</div></div>` : ''}
    </div>
    ${session.timeline && session.timeline.length > 2 ? renderTouchTimeline(session.timeline) : ''}
  `;

  if (session.timeline && session.timeline.length > 2) {
    initTimelineScrubber(session.timeline);
  }

  // Switch to History tab manually — calling .click() would fire the tab
  // handler, which resets historyDetailView to hidden.
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelector('[data-tab="history"]').classList.add('active');
  $('view-history').classList.add('active');
  document.querySelectorAll('.controls').forEach(c => { c.style.display = 'none'; });

  $('historyList').style.display = 'none';
  $('historyDetailView').style.display = 'block';
}

async function openSessionDetail(id) {
  const sessions = await loadSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) return;
  currentViewedSessionId = id;
  $('shareSessionBtn').style.display = '';

  const d = new Date(session.date);
  const dateStr = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) +
                  ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const durStr = fmtTime(session.durationSec * 1000, false);
  const avgDps = session.avgDps > 0 ? fmtDps(session.avgDps, prefs.units) : '—';
  const pace   = session.avgSpeedMS > 0 ? fmtPace500(session.avgSpeedMS) : '—';
  const dpsUnit = prefs.units === 'metric' ? 'm' : 'yd';

  $('historyDetailContent').innerHTML = `
    <div class="setup">
      <h3>${dateStr}</h3>
      <div class="setup-row">
        <div class="setup-label">Profile</div>
        <div class="setup-val">${escapeHtml(session.profileName || 'Unknown')}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Duration</div>
        <div class="setup-val">${durStr}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Distance</div>
        <div class="setup-val">${fmtDist(session.distanceM, prefs.units)} ${dpsUnit}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Total Strokes</div>
        <div class="setup-val">${session.strokes}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Avg Stroke Rate</div>
        <div class="setup-val">${session.avgSpm} SPM</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Avg Speed</div>
        <div class="setup-val">${fmtSpeed(session.avgSpeedMS, prefs.units)}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Avg Pace /500m</div>
        <div class="setup-val">${pace}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Distance per Stroke</div>
        <div class="setup-val">${avgDps} ${dpsUnit}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Avg Stern Check</div>
        <div class="setup-val">${session.avgCheck > 0 ? session.avgCheck.toFixed(2) + ' m/s²' : '—'}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Avg Bounce</div>
        <div class="setup-val">${session.avgBounce > 0 ? session.avgBounce.toFixed(2) + ' m/s²' : '—'}</div>
      </div>
      <div class="setup-row">
        <div class="setup-label">Distance Source</div>
        <div class="setup-val">${escapeHtml(session.distMode || 'fused')}</div>
      </div>
    </div>
    ${session.timeline && session.timeline.length > 2 ? renderTouchTimeline(session.timeline) : ''}
  `;

  if (session.timeline && session.timeline.length > 2) {
    initTimelineScrubber(session.timeline);
  }

  $('historyList').style.display = 'none';
  $('historyDetailView').style.display = 'block';
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
  // Single delegated listener for profile-row buttons
  $('profileList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    onProfileAction(btn.dataset.action, btn.dataset.id);
  });

  $('sensitivity').value = prefs.sensitivity;
  $('sensVal').textContent = prefs.sensitivity.toFixed(2);
  $('minInterval').value = prefs.minInterval;
  $('units').value = prefs.units;
  $('distMode').value = prefs.distMode;
  $('autoRecal').value = String(prefs.autoRecal);
  $('appVersion').textContent = APP_VERSION;

  $('sensitivity').addEventListener('input', e => {
    prefs.sensitivity = parseFloat(e.target.value);
    $('sensVal').textContent = prefs.sensitivity.toFixed(2);
    savePrefs(prefs);
  });
  $('minInterval').addEventListener('change', e => {
    prefs.minInterval = parseInt(e.target.value, 10) || 700;
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
  $('exportBtn').addEventListener('click', async () => {
    const data = await loadSessions();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dragonlog_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  $('clearBtn').addEventListener('click', async () => {
    if (confirm('Delete all saved sessions? This cannot be undone.')) {
      await clearSessions();
      $('sessionCount').textContent = '0';
      renderHistory();
    }
  });
}
function updateUnitLabels() {
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
      // Bottom controls (CALIBRATE/START etc.) only make sense on Train tab
      const onTrain = btn.dataset.tab === 'train';
      document.querySelectorAll('.controls').forEach(c => {
        c.style.display = onTrain ? '' : 'none';
      });
      if (onTrain) {
        // Re-apply correct controls based on session state
        toggleControls(state.running ? (state.paused ? 'paused' : 'running') : 'idle');
      }
      if (btn.dataset.tab === 'history') {
        // Always start in list view, not detail
        $('historyDetailView').style.display = 'none';
        $('historyList').style.display = '';
        renderHistory();
      }
      if (btn.dataset.tab === 'plan') renderWorkoutList();
      if (btn.dataset.tab === 'settings') {
        loadSessions().then(s => { $('sessionCount').textContent = s.length; });
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

// ---------- Plan tab ----------
function renderWorkoutList() {
  const container = $('workoutListItems');
  const workouts  = loadWorkouts();
  if (!workouts.length) {
    container.innerHTML = `<div class="empty">
      <h2>No Workouts Yet</h2>
      <p>Build your first structured workout to get started.</p>
    </div>`;
    return;
  }
  container.innerHTML = workouts.map(w => {
    const totalMin = Math.round(totalWorkoutSec(w) / 60);
    const chips = w.intervals.map(iv =>
      `<span class="iv-chip ${iv.type}">${intervalDisplay(iv)}</span>`
    ).join('');
    return `<div class="workout-card">
      <div class="workout-card-name">${escapeHtml(w.name)}</div>
      <div class="workout-card-meta">${w.intervals.length} INTERVALS · ~${totalMin} MIN</div>
      <div class="workout-card-chips">${chips}</div>
      <div class="workout-card-actions">
        <button class="btn btn-primary"  data-action="load" data-id="${w.id}">LOAD</button>
        <button class="btn btn-ghost"    data-action="edit" data-id="${w.id}">EDIT</button>
        <button class="btn btn-ghost danger-btn" data-action="del"  data-id="${w.id}">DEL</button>
      </div>
    </div>`;
  }).join('');
}

function onWorkoutAction(action, idStr) {
  const id = parseInt(idStr, 10);
  const workouts = loadWorkouts();
  const w = workouts.find(x => x.id === id);
  if (action === 'load') {
    if (!w) return;
    if (state.running) {
      alert('Stop the current session before loading a different workout.');
      return;
    }
    player.load(w);
    // Switch to Train tab
    document.querySelector('[data-tab="train"]').click();
  } else if (action === 'edit') {
    if (!w) return;
    openBuilder(JSON.parse(JSON.stringify(w)));
  } else if (action === 'del') {
    if (!w || !confirm(`Delete "${w.name}"?`)) return;
    deleteWorkout(id);
    renderWorkoutList();
  }
}

function openBuilder(workout) {
  currentEditWorkout = workout || newWorkout();
  $('builderTitle').textContent    = workout ? 'EDIT WORKOUT' : 'NEW WORKOUT';
  $('workoutNameInput').value      = currentEditWorkout.name;
  $('workoutListView').style.display    = 'none';
  $('workoutBuilderView').style.display = '';
  renderBuilderIntervals();
}

function closeBuilder() {
  currentEditWorkout = null;
  $('workoutListView').style.display    = '';
  $('workoutBuilderView').style.display = 'none';
}

function renderBuilderIntervals() {
  const list = $('builderIntervalList');
  if (!currentEditWorkout.intervals.length) {
    list.innerHTML = '<div class="splits-empty">No intervals yet — tap + Add Interval below</div>';
    return;
  }
  list.innerHTML = currentEditWorkout.intervals.map((iv, i) => {
    const isRest = iv.type === 'rest' || iv.type === 'cooldown';
    const minVal = Math.floor(iv.durationSec / 60);
    const secVal = iv.durationSec % 60;
    return `<div class="interval-row" data-idx="${i}">
      <div class="iv-num">${i + 1}</div>
      <select class="iv-type-select" data-field="type">
        <option value="work"     ${iv.type === 'work'     ? 'selected' : ''}>WORK</option>
        <option value="rest"     ${iv.type === 'rest'     ? 'selected' : ''}>REST</option>
        <option value="warmup"   ${iv.type === 'warmup'   ? 'selected' : ''}>WARMUP</option>
        <option value="cooldown" ${iv.type === 'cooldown' ? 'selected' : ''}>COOLDOWN</option>
      </select>
      <div class="iv-ps-wrap" ${isRest ? 'style="visibility:hidden"' : ''}>
        <span class="iv-ps-label">PS</span>
        <input class="iv-ps" type="number" inputmode="numeric" pattern="[0-9]*" min="1" max="10" value="${iv.ps}" data-field="ps">
      </div>
      <div class="iv-dur-wrap">
        <input class="iv-min" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="99" value="${minVal}" data-field="min">
        <span class="iv-dur-sep">:</span>
        <input class="iv-sec" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="59" step="5" value="${String(secVal).padStart(2,'0')}" data-field="sec">
      </div>
      <button class="btn btn-ghost btn-compact danger-btn iv-del" data-field="del">✕</button>
    </div>`;
  }).join('');
}

function initPlanControls() {
  // Single delegated listener for workout cards (no per-render attachment churn)
  $('workoutListItems').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    onWorkoutAction(btn.dataset.action, btn.dataset.id);
  });

  // Delegated listeners for the interval builder rows
  const ivList = $('builderIntervalList');
  ivList.addEventListener('change', e => {
    if (!currentEditWorkout) return;
    const row = e.target.closest('.interval-row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    const field = e.target.dataset.field;
    if (!field) return;
    const iv = currentEditWorkout.intervals[idx];
    if (!iv) return;
    if (field === 'type') {
      iv.type = e.target.value;
      renderBuilderIntervals();
    } else if (field === 'ps') {
      iv.ps = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 6));
    } else if (field === 'min') {
      const sec = iv.durationSec % 60;
      iv.durationSec = Math.max(0, parseInt(e.target.value, 10) || 0) * 60 + sec;
    } else if (field === 'sec') {
      const min = Math.floor(iv.durationSec / 60);
      iv.durationSec = min * 60 + Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0));
    }
  });
  ivList.addEventListener('click', e => {
    if (!currentEditWorkout) return;
    const del = e.target.closest('[data-field="del"]');
    if (!del) return;
    const row = del.closest('.interval-row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    currentEditWorkout.intervals.splice(idx, 1);
    renderBuilderIntervals();
  });

  $('newWorkoutBtn').addEventListener('click', () => openBuilder(null));
  $('addIntervalBtn').addEventListener('click', () => {
    if (!currentEditWorkout) return;
    currentEditWorkout.intervals.push(newInterval('work', 6, 120));
    renderBuilderIntervals();
  });
  $('builderCancelBtn').addEventListener('click', closeBuilder);
  $('builderSaveBtn').addEventListener('click', () => {
    if (!currentEditWorkout) return;
    const name = $('workoutNameInput').value.trim();
    if (!name) { alert('Please enter a workout name.'); return; }
    currentEditWorkout.name = name;
    if (!currentEditWorkout.intervals.length) {
      alert('Add at least one interval before saving.'); return;
    }
    upsertWorkout(currentEditWorkout);
    closeBuilder();
    renderWorkoutList();
  });
}

// ---------- Info modal ----------
const METRIC_INFO = {
  check: {
    title: 'STERN CHECK',
    body: `
      <div class="info-section">
        <div class="info-heading">What it measures</div>
        <p>Backward kick on the boat between strokes. Lower means smoother glide; higher means the crew is pulling the hull back before the next catch.</p>
      </div>
      <div class="info-section">
        <div class="info-heading">Why it happens</div>
        <p>Rushing the recovery, throwing weight forward, or driving before the blade is fully buried.</p>
      </div>
      <div class="info-section">
        <div class="info-heading">How to improve</div>
        <ul>
          <li><strong>Smooth recovery</strong> — float forward, don't snap.</li>
          <li><strong>Bury before pull</strong> — fully anchor the blade.</li>
          <li><strong>Top arm high</strong> — spear forward and down.</li>
          <li><strong>Hit the catch together</strong> as a crew.</li>
        </ul>
      </div>`,
  },
  bounce: {
    title: 'VERTICAL BOUNCE',
    body: `
      <div class="info-section">
        <div class="info-heading">What it measures</div>
        <p>How much the hull moves up and down. Vertical motion is wasted energy that should be driving the boat forward.</p>
      </div>
      <div class="info-section">
        <div class="info-heading">Why it happens</div>
        <p>Bobbing — dropping head and shoulders into the catch — or digging at the back of the stroke and lifting water.</p>
      </div>
      <div class="info-section">
        <div class="info-heading">How to improve</div>
        <ul>
          <li><strong>Heads level</strong> — reach from core rotation, not bowing.</li>
          <li><strong>Drive horizontal</strong> — push through legs, not down.</li>
          <li><strong>Clean exit at the hip</strong> — slice the blade out.</li>
          <li><strong>Stay tall</strong> through the back half of the stroke.</li>
        </ul>
      </div>`,
  },
};

function initInfoModal() {
  const modal = $('infoModal');
  document.querySelectorAll('.info-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const info = METRIC_INFO[btn.dataset.info];
      if (!info) return;
      $('infoTitle').textContent = info.title;
      $('infoContent').innerHTML = info.body;
      modal.classList.add('active');
    });
  });
  $('infoCloseBtn').addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('active');
  });
}

// ---------- Live / Pack mode ----------
function renderCoachGrid(paddlers) {
  const grid = $('paddlerGrid');
  const entries = Object.values(paddlers);
  if (!entries.length) {
    grid.innerHTML = '<p class="setup-note">Waiting for paddlers…</p>';
    return;
  }
  grid.innerHTML = entries.map(p => `
    <div class="paddler-card">
      <div class="p-name">${escapeHtml(p.name || '?')}</div>
      <div class="p-main">${p.spm ?? '—'} <small>SPM</small></div>
      <div class="p-sub">${escapeHtml(String(p.pace ?? '—'))} &nbsp;|&nbsp; Check: ${escapeHtml(String(p.check ?? '—'))}</div>
    </div>
  `).join('');
}

function showLiveConnected(roomId, role) {
  $('liveSetup').style.display = 'none';
  $('liveConnected').style.display = 'block';
  $('activeRoomName').textContent = roomId.toUpperCase();
  $('activeRoleName').textContent = role === 'coach' ? 'Coach' : 'Paddler';
  $('coachPanel').style.display = role === 'coach' ? 'block' : 'none';
  const chip = $('packChip');
  chip.textContent = `${role === 'coach' ? '◆' : '●'} ${roomId.toUpperCase()}`;
  chip.classList.toggle('coach', role === 'coach');
  chip.style.display = '';
}

function showLiveDisconnected() {
  $('liveSetup').style.display = 'block';
  $('liveConnected').style.display = 'none';
  $('packChip').style.display = 'none';
}

function showJoinPackModal(roomId, role) {
  $('joinPackRoom').textContent = roomId;
  $('joinPackRole').textContent = role.toUpperCase();
  $('joinPackModal').classList.add('active');
}
function hideJoinPackModal() {
  $('joinPackModal').classList.remove('active');
  // Strip the params so a refresh doesn't re-prompt
  if (location.search.includes('room=')) {
    history.replaceState({}, document.title, location.pathname);
  }
}

function initLiveControls() {
  // Pre-fill the name field with the active profile so it's visible & editable
  const activeName = getActiveProfile(prefs)?.name || '';
  $('liveName').value = activeName;

  // Auto-fill from a join link: ?room=VANC-7K4M&role=paddler
  const liveParams = new URLSearchParams(location.search);
  const linkRoom = liveParams.get('room');
  const linkRole = liveParams.get('role');
  if (linkRoom) {
    $('liveRoomId').value = linkRoom.toUpperCase();
    if (linkRole === 'paddler' || linkRole === 'coach') $('liveRole').value = linkRole;
    // Surface a confirmation so the user knows what they're joining
    showJoinPackModal(linkRoom.toUpperCase(), linkRole === 'coach' ? 'coach' : 'paddler');
  }

  $('joinLiveBtn').addEventListener('click', async () => {
    audio.unlockAudio();   // unlock from this user gesture so remote commands can play audio
    const inputId = $('liveRoomId').value.trim().toUpperCase();
    const role    = $('liveRole').value;
    const name    = $('liveName').value.trim() || getActiveProfile(prefs).name;
    if (!inputId) { alert('Enter a Room ID'); return; }

    // Coach generates a random suffix for short bare names; paddlers must
    // type the full token exactly so they pick up the suffix.
    let roomId = inputId;
    if (role === 'coach' && !inputId.includes('-')) {
      roomId = buildRoomToken(inputId);
    }
    if (roomId.length < 8) {
      alert('Room ID is too short — must be at least 8 characters. Coaches can type a short name and the app will add a random code.');
      return;
    }

    $('joinLiveBtn').disabled = true;
    $('joinLiveBtn').textContent = 'CONNECTING…';
    try {
      liveSession = await joinRoom(roomId, name, role, (cmd) => {
        if (cmd.type === 'START' && !state.running) {
          if (cmd.data?.workout) player.load(cmd.data.workout);
          document.querySelector('[data-tab="train"]').click();
          startSession({ remote: true });
        }
        if (cmd.type === 'STOP'  &&  state.running) stopSession({ remote: true });
        if (cmd.type === 'LOAD_WORKOUT' && cmd.data?.workout) {
          player.load(cmd.data.workout);
          document.querySelector('[data-tab="train"]').click();
        }
      });
      liveRole = role;
      activeRoomId = roomId;
      showLiveConnected(roomId, role);
      if (role === 'coach') liveSession.watchPack(renderCoachGrid);
    } catch (e) {
      console.error('Live join failed:', e);
      alert(e.message || 'Could not connect. Check your Room ID and try again.');
    } finally {
      $('joinLiveBtn').disabled = false;
      $('joinLiveBtn').textContent = 'JOIN ROOM';
    }
  });

  $('leaveLiveBtn').addEventListener('click', () => {
    if (liveSession) { liveSession.leave(); liveSession = null; liveRole = null; }
    activeRoomId = null;
    showLiveDisconnected();
  });

  $('copyRoomLinkBtn').addEventListener('click', async () => {
    if (!activeRoomId) return;
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(activeRoomId)}&role=paddler`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join my Dragonlog pack', text: `Room: ${activeRoomId}`, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      const btn = $('copyRoomLinkBtn');
      const orig = btn.textContent;
      btn.textContent = 'COPIED!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch {
      alert(`Share this link:\n\n${url}`);
    }
  });

  $('coachStartBtn').addEventListener('click', () => {
    if (!liveSession) return;
    const data = player.loaded ? { workout: player.workout } : {};
    liveSession.sendCommand('START', data);
  });

  $('coachStopBtn').addEventListener('click', () => {
    if (liveSession) liveSession.sendCommand('STOP');
  });

  $('coachSendWorkoutBtn').addEventListener('click', () => {
    if (!liveSession) return;
    if (!player.loaded) { alert('No workout loaded — go to the Plan tab and load one first.'); return; }
    liveSession.sendCommand('LOAD_WORKOUT', { workout: player.workout });
  });

  $('joinPackCancel').addEventListener('click', hideJoinPackModal);
  $('joinPackConfirm').addEventListener('click', () => {
    hideJoinPackModal();
    document.querySelector('[data-tab="live"]')?.click();
    $('joinLiveBtn').click();
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
initPlanControls();
initInfoModal();
initLiveControls();
$('backToHistoryBtn').addEventListener('click', () => {
  // Clean the share param so the user isn't trapped on the shared session
  if (location.search.includes('s=')) {
    history.replaceState({}, document.title, location.pathname);
  }
  currentViewedSessionId = null;
  $('historyDetailView').style.display = 'none';
  $('historyList').style.display = '';
});

$('shareSessionBtn').addEventListener('click', async () => {
  if (!currentViewedSessionId) return;
  const sessions = await loadSessions();
  const session = sessions.find(s => s.id === currentViewedSessionId);
  if (!session) return;
  let encoded;
  try {
    encoded = await encodeSession(session);
  } catch (e) {
    console.error('Encode failed:', e);
    alert('Could not build a shareable link.');
    return;
  }
  const url = `${location.origin}${location.pathname}?s=${encoded}`;
  console.log(`Share URL length: ${url.length} chars`);
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Dragonlog Session',
        text: 'Check out my pacing and stroke rate timeline:',
        url,
      });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    alert('Link copied to clipboard!');
  } catch {
    alert('Unable to copy link.');
  }
});
// Delegated click handler: delete button > swipe-open card > open detail
$('historyList').addEventListener('click', e => {
  if (Date.now() < suppressClickUntil) return;

  const delBtn = e.target.closest('button[data-action="delete-session"]');
  if (delBtn) {
    deleteSessionById(parseInt(delBtn.dataset.id, 10));
    return;
  }

  const card = e.target.closest('.session-card[data-id]');
  if (!card) return;

  const wrap = card.closest('.session-card-wrap');
  if (wrap && wrap.classList.contains('swipe-open')) {
    closeSwipe(wrap);
    return;
  }
  openSessionDetail(parseInt(card.dataset.id, 10));
});

// Swipe gesture: pointer-based, threshold-snap, vertical-scroll-friendly
const historyListEl = $('historyList');
historyListEl.addEventListener('pointerdown', e => {
  if (e.target.closest('.session-card-delete')) return;     // tap on DELETE — let click handle it
  const wrap = e.target.closest('.session-card-wrap');
  if (!wrap) return;
  const card = wrap.querySelector('.session-card');
  if (!card) return;
  const m = (card.style.transform || '').match(/translateX\((-?\d+(?:\.\d+)?)/);
  pointerDrag = {
    id:           e.pointerId,
    startX:       e.clientX,
    startY:       e.clientY,
    startOffset:  m ? parseFloat(m[1]) : 0,
    wrap, card,
    dir:          null,
  };
  card.style.transition = 'none';
});
historyListEl.addEventListener('pointermove', e => {
  if (!pointerDrag || pointerDrag.id !== e.pointerId) return;
  const dx = e.clientX - pointerDrag.startX;
  const dy = e.clientY - pointerDrag.startY;
  if (pointerDrag.dir === null) {
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      pointerDrag.dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    } else return;
  }
  if (pointerDrag.dir === 'v') return;          // vertical scroll — stay out of the way
  let next = pointerDrag.startOffset + dx;
  if (next > 0) next = 0;
  if (next < -130) next = -130;                 // small rubber band past full reveal
  pointerDrag.card.style.transform = `translateX(${next}px)`;
});
function endPointerDrag(e, cancelled) {
  if (!pointerDrag || pointerDrag.id !== e.pointerId) return;
  const card = pointerDrag.card;
  const wrap = pointerDrag.wrap;
  const dir  = pointerDrag.dir;
  const totalDx = e.clientX - pointerDrag.startX;
  const totalDy = e.clientY - pointerDrag.startY;
  card.style.transition = '';
  if (cancelled || dir === 'v' || (Math.abs(totalDx) < 5 && Math.abs(totalDy) < 5)) {
    // Tap or vertical scroll — restore state, let click handler decide
    if (pointerDrag.startOffset === 0) card.style.transform = '';
    else card.style.transform = `translateX(${pointerDrag.startOffset}px)`;
  } else {
    const m = (card.style.transform || '').match(/translateX\((-?\d+(?:\.\d+)?)/);
    const final = m ? parseFloat(m[1]) : 0;
    if (final < -50) openSwipe(wrap); else closeSwipe(wrap);
    suppressClickUntil = Date.now() + 350;
  }
  pointerDrag = null;
}
historyListEl.addEventListener('pointerup',     e => endPointerDrag(e, false));
historyListEl.addEventListener('pointercancel', e => endPointerDrag(e, true));
updateUnitLabels();
renderProfilePills();
loadSessions().then(s => { $('sessionCount').textContent = s.length; });
registerServiceWorker();

setInterval(render, 100);
render();

// ---------- Magic-link interceptor ----------
// If the URL contains ?s=<encoded>, decode the payload and open it in the
// History detail view. The recipient sees the shared session immediately,
// no IndexedDB required.
(async () => {
  const params = new URLSearchParams(location.search);
  const encoded = params.get('s');
  if (!encoded) return;
  try {
    const session = await decodeSession(encoded);
    renderSharedSession(session);
  } catch (e) {
    console.warn('Failed to decode shared link:', e);
    alert('This shared link is invalid or corrupted.');
  }
})();
