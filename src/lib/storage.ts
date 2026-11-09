// Tiny IndexedDB key-value store for translation projects.
// localStorage caps at ~5 MB; a full game's translations can exceed that.
const DB = "rom-lingo";
const STORE = "projects";
const ROMS = "roms";
const LAST_ROM = "last"; // legacy single-slot ROM

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
  /** shown in the game list without having to reopen the ROM */
  meta?: { title: string; code: string; fileName: string; total: number; romKind?: "file" | "handle"; /** PNG data URL of the game's mascot sprite */ thumb?: string };
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

/** Legacy: the single ROM slot used before games were stored per key. */
export async function clearLegacyRom(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROMS, "readwrite");
      tx.objectStore(ROMS).delete(LAST_ROM);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* nothing to clear */
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

// ---- every ROM the user has opened, so the game list can switch between them

/**
 * A ROM is kept under its project key either as the file itself (any browser) or, where the File
 * System Access API exists, as a handle to the file on disk: a few bytes instead of ~16 MB.
 * The `permission` methods are missing from the DOM typings.
 */
export type RomHandle = FileSystemFileHandle & {
  queryPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
};

const isHandle = (v: unknown): v is RomHandle =>
  !!v && typeof v === "object" && !(v instanceof Blob) && typeof (v as RomHandle).getFile === "function";

async function putRom(key: string, value: Blob | RomHandle): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROMS, "readwrite");
      tx.objectStore(ROMS).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* quota / handles not storable: the game stays listed but must be re-imported to open */
  }
}

/** Keep the ROM file itself under its project key. Stays on this device. */
export const saveRom = (key: string, file: File) => putRom(key, file);
/** Keep only a link to the ROM on disk; the file is read again on open. */
export const saveRomHandle = (key: string, handle: RomHandle) => putRom(key, handle);

async function getRomValue(key: string): Promise<unknown> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(ROMS).objectStore(ROMS).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export type RomRead = { state: "ok"; file: File; kind: "file" | "handle" } | { state: "permission" } | { state: "missing" };

/**
 * Read a stored ROM. A handle needs read permission again after the browser restarts;
 * `request` asks for it, which only works inside a user gesture (otherwise → "permission").
 */
export async function readRom(key: string, request: boolean): Promise<RomRead> {
  const v = await getRomValue(key);
  if (v instanceof Blob) return { state: "ok", file: v as File, kind: "file" };
  if (!isHandle(v)) return { state: "missing" };
  try {
    let perm: PermissionState = (await v.queryPermission?.({ mode: "read" })) ?? "granted";
    if (perm !== "granted" && request) {
      try {
        perm = (await v.requestPermission?.({ mode: "read" })) ?? "denied";
      } catch {
        perm = "prompt"; // no user gesture
      }
    }
    if (perm !== "granted") return { state: "permission" };
    return { state: "ok", file: await v.getFile(), kind: "handle" };
  } catch {
    return { state: "missing" }; // moved, renamed or deleted
  }
}

export type GameSummary = {
  key: string;
  title: string;
  code: string;
  /** translated strings / all strings (total is 0 until the project is saved with meta) */
  done: number;
  total: number;
  updatedAt: number;
  thumb?: string;
  /** ok = readable, permission = a handle that needs the user to allow access again, missing = nothing stored */
  rom: "ok" | "permission" | "missing";
};

/** Every saved project, newest first. */
export async function listProjects(): Promise<GameSummary[]> {
  try {
    const db = await open();
    const tx = db.transaction([STORE, ROMS]);
    const projects = await new Promise<[string, Project][]>((resolve, reject) => {
      const out: [string, Project][] = [];
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push([String(c.key), c.value as Project]);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    const romKeys = await new Promise<Set<string>>((resolve, reject) => {
      const req = tx.objectStore(ROMS).getAllKeys();
      req.onsuccess = () => resolve(new Set(req.result.map(String)));
      req.onerror = () => reject(req.error);
    });
    const romState = async (key: string, p: Project): Promise<GameSummary["rom"]> => {
      if (!romKeys.has(key)) return "missing";
      if (p.meta?.romKind !== "handle") return "ok";
      const v = await getRomValue(key);
      if (!isHandle(v)) return "missing";
      return ((await v.queryPermission?.({ mode: "read" })) ?? "granted") === "granted" ? "ok" : "permission";
    };
    const roms = await Promise.all(projects.map(([key, p]) => romState(key, p)));
    return projects
      .map(([key, p], i) => ({
        key,
        title: p.meta?.title ?? key.split("-")[0],
        code: p.meta?.code ?? key.split("-")[0],
        done: Object.keys(p.translations).length,
        total: p.meta?.total ?? 0,
        updatedAt: p.updatedAt,
        rom: roms[i],
        thumb: p.meta?.thumb,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Forget a game: its translations and the stored ROM. */
export async function deleteProject(key: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, ROMS], "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.objectStore(ROMS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* nothing to delete */
  }
}
