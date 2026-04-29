// Real-time pack sync via Firebase Realtime Database.
// Paddlers broadcast stats; coaches watch the pack and send commands.
//
// Security model:
//   - Room IDs must be ≥ 8 chars (enforced by database.rules.json) so a
//     guessed short string can't write to anyone's room.
//   - Coaches generate a random 4-char suffix on join (e.g. VANC → VANC-7K4M);
//     the resulting token is the shared secret distributed via QR / link.
//   - Commands self-expire after 4s in the DB and the receiver also ignores
//     anything older than 10s, so a paddler joining mid-rest doesn't get
//     auto-START-ed by a stale value.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js';
import {
  getDatabase, ref, set, onValue, push, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js';

const firebaseConfig = {
  apiKey:            'AIzaSyDvcHa6TOxAGVIYaegGoWjrYLXcTAza7p8',
  authDomain:        'dragonlog-259f1.firebaseapp.com',
  databaseURL:       'https://dragonlog-259f1-default-rtdb.firebaseio.com',
  projectId:         'dragonlog-259f1',
  storageBucket:     'dragonlog-259f1.firebasestorage.app',
  messagingSenderId: '505428687424',
  appId:             '1:505428687424:web:3f39a3d5b0f163efddbda5',
};

const COMMAND_TTL_MS = 10000;   // receiver discards anything older than this
const COMMAND_CLEAR_MS = 4000;  // sender wipes the value after this

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

let userRef       = null;
let commandUnsub  = null;
let packUnsub     = null;
let lastCommandTs = 0;

// Generate an 8+ char token from a base name. "VANC" → "VANC-7K4M".
// Bare base name without a hyphen gets a random suffix; otherwise returned as-is
// (paddlers paste the full token unchanged).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/1, O/0
export function buildRoomToken(baseName) {
  const clean = (baseName || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (clean.includes('-')) return clean;          // already a full token
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  const base = clean || 'ROOM';
  return `${base}-${suffix}`;
}

export async function joinRoom(roomId, name, role, onCommand) {
  if (!roomId || roomId.length < 8) {
    throw new Error('Room ID must be at least 8 characters.');
  }
  const roomPath = `rooms/${roomId}`;

  // Listen for coach commands. Filter stale + already-seen.
  commandUnsub = onValue(ref(db, `${roomPath}/command`), (snap) => {
    const cmd = snap.val();
    if (!cmd || !cmd.ts) return;
    if (cmd.ts <= lastCommandTs) return;
    if (Date.now() - cmd.ts > COMMAND_TTL_MS) return;
    lastCommandTs = cmd.ts;
    onCommand(cmd);
  });

  if (role === 'paddler') {
    userRef = push(ref(db, `${roomPath}/paddlers`));
    onDisconnect(userRef).remove();
    await set(userRef, { name, spm: 0, pace: '—', check: '—', lastUpdate: serverTimestamp() });
  }

  return {
    sendCommand: async (type, data = {}) => {
      const cmdRef = ref(db, `${roomPath}/command`);
      await set(cmdRef, { type, data, ts: Date.now() });
      setTimeout(() => set(cmdRef, null).catch(() => {}), COMMAND_CLEAR_MS);
    },

    updateStats: (stats) => {
      if (!userRef) return;
      set(userRef, { name, ...stats, lastUpdate: serverTimestamp() });
    },

    watchPack: (callback) => {
      packUnsub = onValue(ref(db, `${roomPath}/paddlers`), (snap) =>
        callback(snap.val() || {})
      );
    },

    leave: () => {
      if (commandUnsub) { commandUnsub(); commandUnsub = null; }
      if (packUnsub)    { packUnsub();    packUnsub    = null; }
      if (userRef)      { set(userRef, null).catch(() => {}); userRef = null; }
      lastCommandTs = 0;
    },
  };
}
