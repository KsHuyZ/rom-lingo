/// <reference lib="webworker" />
// All heavy ROM work happens here so the UI never freezes.
import { buildCharMap, parseTbl, type CharMap } from "./charmap";
import { buildRom, createBps, extractAll, readHeader, type Entry } from "./rom";
import { applyFont, measureWidths } from "./font-patch";
import { makeMeasure, wrapDialogue, WrapError } from "./wrap";
import { VI_PROFILES, viSlots, viTargetCharMap, type ViProfile } from "./vi-profile";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let rom: Uint8Array | null = null;
let entries: Entry[] = [];
let cm: CharMap = buildCharMap();
let viProfile: ViProfile | null = null;

const findProfile = (h: ReturnType<typeof readHeader>) =>
  VI_PROFILES.find((p) => p.gameCode === h.code && h.version === 0 && h.size === 16 * 1024 * 1024) ?? null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

function extract() {
  const t0 = performance.now();
  entries = extractAll(rom!, cm);
  post({ type: "entries", entries, ms: Math.round(performance.now() - t0) });
}


type Wrapper = {
  p: ViProfile;
  slots: Map<string, number> | null;
  target: CharMap;
  m: ReturnType<typeof makeMeasure>;
  m0: ReturnType<typeof makeMeasure>;
  inScript: (o: number) => boolean;
  byId: Map<string, Entry>;
};

/** Pixel measures for laying dialogue out in the message box; null when the ROM has no profile. */
function makeWrapper(viFont: boolean): Wrapper | null {
  if (!rom || !viProfile) return null;
  const p = viProfile;
  let slots: Map<string, number> | null = null;
  let target = cm;
  if (viFont) {
    slots = viSlots(cm, p);
    target = viTargetCharMap(p, slots);
  }
  const spec = p.fonts[0];
  const widths = slots ? measureWidths(rom, p.fonts, cm, slots) : rom.slice(spec.widths, spec.widths + 256);
  return {
    p,
    slots,
    target,
    m: makeMeasure(widths, target, p.tagWidths),
    m0: makeMeasure(widths, target, {}),
    inScript: (o) => p.scrollRegions.some(([a, b]) => o >= a && o < b),
    byId: new Map(entries.map((e) => [e.id, e])),
  };
}

/** Wrapped text, null when not dialogue / empty, or the WrapError that blocks it. */
function wrapEntry(w: Wrapper, id: string, tr: string): string | null | WrapError {
  const e = w.byId.get(id);
  if (!e || e.kind !== "dialogue" || !tr.trim()) return null;
  try {
    return wrapDialogue(e.text, tr, w.p.box, w.m, w.m0, w.inScript(e.offset));
  } catch (err) {
    if (err instanceof WrapError) return err;
    throw err;
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "load": {
        rom = new Uint8Array(msg.buffer);
        cm = buildCharMap(msg.tbl ? parseTbl(msg.tbl) : undefined);
        const header = readHeader(rom);
        viProfile = findProfile(header);
        post({ type: "header", header, viFont: viProfile !== null });
        extract();
        break;
      }
      case "setTbl": {
        cm = buildCharMap(msg.tbl ? parseTbl(msg.tbl) : undefined);
        if (rom) extract();
        break;
      }
      case "wrapCheck": {
        const w = rom ? makeWrapper(!!msg.viFont) : null;
        const bad: { id: string; text: string; message: string }[] = [];
        if (w) {
          for (const it of msg.items) {
            const text = msg.viFont ? it.text.normalize("NFC") : it.text;
            const r = wrapEntry(w, it.id, text);
            if (r !== null && typeof r !== "string") bad.push({ id: it.id, text: it.text, message: r.message });
          }
        }
        post({ type: "wrapChecked", tag: msg.tag, bad });
        break;
      }
      case "build": {
        if (!rom) throw new Error("Chưa nạp ROM");
        if (msg.viFont && !viProfile) throw new Error("Chưa hỗ trợ font có dấu cho ROM này");
        const w = makeWrapper(!!msg.viFont);
        const target = w?.target ?? cm;
        let translations = msg.translations;
        if (msg.viFont) {
          // typed/pasted text may be NFD; the charmap holds precomposed letters
          translations = Object.fromEntries(Object.entries(translations).map(([k, v]) => [k, v.normalize("NFC")]));
        }
        // Re-wrap dialogue to the message box by pixel width. A line that cannot fit is
        // reported and left in English, like Vietrom's "wrap" skip.
        const wrapIssues: { id: string; message: string }[] = [];
        if (w) {
          translations = { ...translations };
          for (const [id, tr] of Object.entries(translations)) {
            const r = wrapEntry(w, id, tr);
            if (r === null) continue;
            if (typeof r === "string") translations[id] = r;
            else {
              wrapIssues.push({ id, message: r.message });
              delete translations[id];
            }
          }
        }
        const res = buildRom(rom, entries, translations, target);
        res.issues.push(...wrapIssues);
        // like Vietrom: the font is only touched when at least one line was written
        const fontApplied = !!w?.slots && res.written > 0;
        if (fontApplied) applyFont(res.rom, rom, viProfile!.fonts, cm, w!.slots!);
        const bps = createBps(rom, res.rom);
        post(
          {
            type: "built",
            rom: res.rom.buffer as ArrayBuffer,
            bps: bps.buffer as ArrayBuffer,
            written: res.written,
            relocated: res.relocated,
            fontApplied,
            issues: res.issues,
          },
          [res.rom.buffer as ArrayBuffer, bps.buffer as ArrayBuffer],
        );
        break;
      }
    }
  } catch (e) {
    post({ type: "error", message: (e as Error).message });
  }
};
