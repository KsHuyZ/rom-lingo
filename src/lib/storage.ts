// Tiny IndexedDB key-value store for translation projects.
// localStorage caps at ~5 MB; a full game's translations can exceed that.
const DB = "rom-lingo";
const STORE = "projects";
const ROMS = "roms";
const LAST_ROM = "last";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(ROMS)) db.createObjectStore(ROMS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export type Project = {
  translations: Record<string, string>;
  tbl?: string;
  /** ids whose current translation came from AI and was not edited since */
  aiIds?: Record<string, true>;
  /** AI output that failed validation: kept as a suggestion, not applied */
  aiFlags?: Record<string, { text: string; issue: string }>;
  updatedAt: number;
};

export async function loadProject(key: string): Promise<Project | undefined> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Project | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function saveProject(key: string, p: Project): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(p, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* private mode / blocked storage: keep working in memory */
  }
}

/** Remember the ROM file itself so a page reload does not ask for it again. Stays on this device. */
export async function saveLastRom(file: File): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROMS, "readwrite");
      tx.objectStore(ROMS).put(file, LAST_ROM);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* quota / private mode: user just re-imports next time */
  }
}

export async function loadLastRom(): Promise<File | undefined> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(ROMS).objectStore(ROMS).get(LAST_ROM);
      req.onsuccess = () => resolve(req.result instanceof Blob ? (req.result as File) : undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}
