// Real-time pack sync via Firebase Realtime Database.
// Paddlers broadcast stats; coaches watch the pack and send commands.
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

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

let userRef        = null;
let commandUnsub   = null;
let packUnsub      = null;
let lastCommandTs  = 0;   // de-dupe replayed commands

export async function joinRoom(roomId, name, role, onCommand) {
  const roomPath = `rooms/${roomId}`;

  // Listen for coach commands
  commandUnsub = onValue(ref(db, `${roomPath}/command`), (snap) => {
    const cmd = snap.val();
    if (!cmd || cmd.ts <= lastCommandTs) return;
    lastCommandTs = cmd.ts;
    onCommand(cmd);
  });

  if (role === 'paddler') {
    userRef = push(ref(db, `${roomPath}/paddlers`));
    onDisconnect(userRef).remove();
    await set(userRef, { name, spm: 0, pace: '—', check: '—', lastUpdate: serverTimestamp() });
  }

  return {
    sendCommand: (type, data = {}) =>
      set(ref(db, `${roomPath}/command`), { type, data, ts: Date.now() }),

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
      if (commandUnsub) commandUnsub();
      if (packUnsub)    packUnsub();
      if (userRef)      set(userRef, null);
      userRef = null;
    },
  };
}
