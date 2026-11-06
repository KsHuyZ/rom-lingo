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
      case "build": {
        if (!rom) throw new Error("Chưa nạp ROM");
        let target = cm;
        let translations = msg.translations;
        let slots: Map<string, number> | null = null;
        if (msg.viFont) {
          if (!viProfile) throw new Error("Chưa hỗ trợ font có dấu cho ROM này");
          slots = viSlots(cm, viProfile);
          target = viTargetCharMap(viProfile, slots);
          // typed/pasted text may be NFD; the charmap holds precomposed letters
          translations = Object.fromEntries(Object.entries(translations).map(([k, v]) => [k, v.normalize("NFC")]));
        }
        // Re-wrap dialogue to the message box by pixel width. A line that cannot fit is
        // reported and left in English, like Vietrom's "wrap" skip.
        const wrapIssues: { id: string; message: string }[] = [];
        if (viProfile) {
          const p = viProfile;
          const spec = p.fonts[0];
          const widths = slots ? measureWidths(rom, p.fonts, cm, slots) : rom.slice(spec.widths, spec.widths + 256);
          const m = makeMeasure(widths, target, p.tagWidths);
          const m0 = makeMeasure(widths, target, {});
          const inScript = (o: number) => p.scrollRegions.some(([a, b]) => o >= a && o < b);
          const byId = new Map(entries.map((e) => [e.id, e]));
          translations = { ...translations };
          for (const [id, tr] of Object.entries(translations)) {
            const e = byId.get(id);
            if (!e || e.kind !== "dialogue" || !tr.trim()) continue;
            try {
              translations[id] = wrapDialogue(e.text, tr, p.box, m, m0, inScript(e.offset));
            } catch (err) {
              if (!(err instanceof WrapError)) throw err;
              wrapIssues.push({ id, message: err.message });
              delete translations[id];
            }
          }
        }
        const res = buildRom(rom, entries, translations, target);
        res.issues.push(...wrapIssues);
        // like Vietrom: the font is only touched when at least one line was written
        const fontApplied = !!slots && res.written > 0;
        if (fontApplied) applyFont(res.rom, rom, viProfile!.fonts, cm, slots!);
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
