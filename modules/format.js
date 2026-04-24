// Pure formatting helpers. No DOM access, no side effects.

export function fmtTime(ms, withTenths) {
  const tot = Math.floor(ms / 100) / 10;
  const m = Math.floor(tot / 60);
  const s = tot - m * 60;
  const whole = Math.floor(s);
  const tenth = Math.floor((s - whole) * 10);
  const mm = String(m).padStart(2, '0');
  const ss = String(whole).padStart(2, '0');
  if (withTenths) return `${mm}:${ss}.${tenth}`;
  return `${mm}:${ss}`;
}

export function fmtSpeed(metersPerSec, units) {
  if (units === 'metric') return (metersPerSec * 3.6).toFixed(1);
  return (metersPerSec * 2.23694).toFixed(1);
}

export function fmtDist(meters, units) {
  if (units === 'metric') return Math.round(meters);
  return Math.round(meters * 1.09361);
}

export function fmtDps(metersPerStroke, units) {
  if (units === 'metric') return metersPerStroke.toFixed(2);
  return (metersPerStroke * 1.09361).toFixed(2);
}

export function fmtPace500(metersPerSec) {
  if (metersPerSec < 0.2) return '—';
  const sec = 500 / metersPerSec;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
