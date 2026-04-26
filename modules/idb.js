// Minimal IndexedDB key-value wrapper. ~30 lines, no external dependency.
// Three async methods: get(key), set(key, val), del(key). Returns Promises.
// One database, one object store named 'kv'. Keys are arbitrary strings.

const DB_NAME = 'dragonlog';
const STORE   = 'kv';
let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

function withStore(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error);
  }));
}

export const get = key      => withStore('readonly',  s => s.get(key));
export const set = (key, v) => withStore('readwrite', s => s.put(v, key));
export const del = key      => withStore('readwrite', s => s.delete(key));
