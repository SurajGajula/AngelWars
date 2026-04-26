/**
 * IndexedDB: sprite blobs only (devtools uploads). Character data lives in data/*.json.
 */
const DB_NAME = "VibeJamSpriteDev";
const DB_VERSION = 3;
const STORE_SPRITES = "sprites";

/** @type {Map<string, string>} */
const objectUrlCache = new Map();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SPRITES)) {
        db.createObjectStore(STORE_SPRITES, { keyPath: "id" });
      }
    };
  });
}

function revokeAllCached() {
  for (const url of objectUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  objectUrlCache.clear();
}

/**
 * @param {string[]} ids
 */
export async function loadSpriteUrlsForIds(ids) {
  revokeAllCached();
  const db = await openDb();
  const unique = [...new Set(ids)];
  await Promise.all(
    unique.map(
      (id) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_SPRITES, "readonly");
          const req = tx.objectStore(STORE_SPRITES).get(id);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const row = req.result;
            if (row && row.blob instanceof Blob) {
              objectUrlCache.set(id, URL.createObjectURL(row.blob));
            }
            resolve();
          };
        })
    )
  );
}

/** @param {string} id */
export function getCachedSpriteUrl(id) {
  return objectUrlCache.get(id) || null;
}

/** Re-read one id from IndexedDB (e.g. after devtools upload). */
export async function reloadSpriteId(id) {
  const old = objectUrlCache.get(id);
  if (old) URL.revokeObjectURL(old);
  objectUrlCache.delete(id);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, "readonly");
    const req = tx.objectStore(STORE_SPRITES).get(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const row = req.result;
      if (row && row.blob instanceof Blob) {
        objectUrlCache.set(id, URL.createObjectURL(row.blob));
      }
      resolve();
    };
  });
}

/**
 * @param {string} id
 * @param {File} file
 */
export async function saveSprite(id, file) {
  const db = await openDb();
  const row = {
    id,
    blob: file,
    mimeType: file.type || "application/octet-stream",
    updatedAt: Date.now(),
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_SPRITES).put(row);
  });
}

/** @param {string} id */
export async function clearSprite(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_SPRITES).delete(id);
  });
  const old = objectUrlCache.get(id);
  if (old) URL.revokeObjectURL(old);
  objectUrlCache.delete(id);
}

/** @returns {Promise<string[]>} */
export async function listStoredSpriteIds() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, "readonly");
    const req = tx.objectStore(STORE_SPRITES).getAllKeys();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(/** @type {string[]} */ (req.result));
  });
}
