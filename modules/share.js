// Stateless session sharing via URL-encoded payload.
//   - Compact representation:  parallel arrays + scaled integers (~2x smaller)
//   - Gzip via CompressionStream (~5x smaller; Chrome 80+, Safari 16.4+, FF 113+)
//   - URL-safe base64 (-, _ instead of +, /; no padding)
//   - Modern TextEncoder/TextDecoder rather than the deprecated unescape trick
//
// A 1-hour session (~720 timeline points) typically encodes to <5 KB.

// ---- Compact timeline ----
// Convert array-of-objects to parallel arrays of small integers for max
// compressibility. Times in seconds (4-digit), speeds and DPS scaled ×100,
// check/bounce scaled ×100. Values are clamped to integers.
function compactTimeline(tl) {
  const N = tl.length;
  const t      = new Array(N);
  const spm    = new Array(N);
  const speed  = new Array(N);
  const dps    = new Array(N);
  const check  = new Array(N);
  const bounce = new Array(N);
  for (let i = 0; i < N; i++) {
    const p = tl[i];
    t[i]      = Math.round((p.t      || 0) / 1000);
    spm[i]    = (p.spm    || 0) | 0;
    speed[i]  = Math.round((p.speed  || 0) * 100);
    dps[i]    = Math.round((p.dps    || 0) * 100);
    check[i]  = Math.round((p.check  || 0) * 100);
    bounce[i] = Math.round((p.bounce || 0) * 100);
  }
  return { t, spm, speed, dps, check, bounce };
}
function expandTimeline(c) {
  const N = c.t.length;
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = {
      t:      c.t[i] * 1000,
      spm:    c.spm[i],
      speed:  (c.speed[i]  || 0) / 100,
      dps:    (c.dps[i]    || 0) / 100,
      check:  (c.check[i]  || 0) / 100,
      bounce: (c.bounce[i] || 0) / 100,
    };
  }
  return out;
}

// ---- URL-safe base64 ----
function bytesToBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(b64u) {
  let s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---- Gzip via CompressionStream ----
async function gzip(str) {
  const stream = new Blob([new TextEncoder().encode(str)]).stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

// ---- Public API ----
// Encode a session (with timeline) into a short URL-safe string.
export async function encodeSession(session) {
  const compact = {
    d:  session.date,
    s:  session.durationSec,
    m:  session.distanceM,
    r:  session.avgSpm,
    v:  session.avgSpeedMS,
    p:  session.avgDps,
    c:  session.avgCheck,
    b:  session.avgBounce,
    n:  session.profileName,
    tl: session.timeline?.length > 1 ? compactTimeline(session.timeline) : null,
  };
  const json = JSON.stringify(compact);
  const bytes = await gzip(json);
  return bytesToBase64Url(bytes);
}

// Decode a URL-safe string back into a normal session object.
export async function decodeSession(encoded) {
  const bytes = base64UrlToBytes(encoded);
  const json  = await gunzip(bytes);
  const c     = JSON.parse(json);
  return {
    date:        c.d,
    durationSec: c.s,
    distanceM:   c.m,
    avgSpm:      c.r,
    avgSpeedMS:  c.v,
    avgDps:      c.p,
    avgCheck:    c.c || 0,
    avgBounce:   c.b || 0,
    profileName: c.n,
    timeline:    c.tl ? expandTimeline(c.tl) : [],
    distMode:    'shared',
    isShared:    true,
  };
}
