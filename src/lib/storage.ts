// Tiny IndexedDB key-value store for translation projects.
// localStorage caps at ~5 MB; a full game's translations can exceed that.
const DB = "rom-lingo";
const STORE = "projects";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
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
