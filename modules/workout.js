// Workout data model + localStorage persistence.

const WORKOUT_KEY = 'dragonlog_workouts';

export function loadWorkouts() {
  try {
    const raw = localStorage.getItem(WORKOUT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function saveWorkouts(list) {
  try { localStorage.setItem(WORKOUT_KEY, JSON.stringify(list)); }
  catch (e) { console.error('Failed to save workouts:', e); throw e; }
}

export function upsertWorkout(w) {
  const list = loadWorkouts();
  const i = list.findIndex(x => x.id === w.id);
  if (i >= 0) list[i] = w; else list.unshift(w);
  saveWorkouts(list);
}

export function deleteWorkout(id) {
  saveWorkouts(loadWorkouts().filter(w => w.id !== id));
}

export function newWorkout(name = 'New Workout') {
  return { id: Date.now(), name, intervals: [] };
}

// type: 'work' | 'rest' | 'warmup' | 'cooldown'
export function newInterval(type = 'work', ps = 6, durationSec = 120) {
  return { id: (Date.now() + Math.random() * 1e6) | 0, type, ps, durationSec };
}

export function intervalDisplay(iv) {
  if (iv.type === 'rest')     return 'REST';
  if (iv.type === 'warmup')   return `WARM UP · PS${iv.ps}`;
  if (iv.type === 'cooldown') return `COOL DOWN · PS${iv.ps}`;
  return `PS${iv.ps} · ${iv.ps * 10}%`;
}

export function fmtDur(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function totalWorkoutSec(w) {
  return w.intervals.reduce((a, iv) => a + iv.durationSec, 0);
}
