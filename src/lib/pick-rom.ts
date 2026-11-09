// Choosing a ROM file. Chrome/Edge give a handle (a link to the file on disk) from the picker and
// from drag & drop; other browsers only give the file itself.
import type { RomHandle } from "~/lib/storage";

export type Picked = { file: File; handle?: RomHandle };

export const hasPicker = () => typeof window !== "undefined" && "showOpenFilePicker" in window;

/** Open the native picker; null when cancelled. Must run inside a click. */
export async function pickRom(): Promise<Picked | null> {
  try {
    const [h] = await (window as unknown as {
      showOpenFilePicker: (o: object) => Promise<RomHandle[]>;
    }).showOpenFilePicker({
      types: [{ description: "ROM GBA", accept: { "application/octet-stream": [".gba", ".bin"] } }],
    });
    return { file: await h.getFile(), handle: h };
  } catch {
    return null;
  }
}

/** The dropped file, with its handle when the browser offers one (asked synchronously: the event dies after). */
export async function droppedRom(dt: DataTransfer): Promise<Picked | null> {
  const file = dt.files?.[0];
  if (!file) return null;
  const item = dt.items?.[0] as
    | (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
    | undefined;
  const pending = item?.getAsFileSystemHandle?.();
  const h = await pending?.catch(() => null);
  return { file, handle: h?.kind === "file" ? (h as RomHandle) : undefined };
}
