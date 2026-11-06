import type { BuildIssue, Entry, RomHeader } from "./rom";

export type WorkerRequest =
  | { type: "load"; buffer: ArrayBuffer; tbl?: string }
  | { type: "setTbl"; tbl?: string }
  | { type: "build"; translations: Record<string, string>; /** draw Vietnamese glyphs into the ROM font */ viFont?: boolean };

export type WorkerResponse =
  | { type: "header"; header: RomHeader; /** a Vietnamese font profile exists for this ROM */ viFont: boolean }
  | { type: "entries"; entries: Entry[]; ms: number }
  | {
      type: "built";
      rom: ArrayBuffer;
      bps: ArrayBuffer;
      written: number;
      relocated: number;
      fontApplied: boolean;
      issues: BuildIssue[];
    }
  | { type: "error"; message: string };
