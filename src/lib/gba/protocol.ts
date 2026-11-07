import type { BuildIssue, Entry, RomHeader } from "./rom";

export type WorkerRequest =
  | { type: "load"; buffer: ArrayBuffer; tbl?: string }
  | { type: "setTbl"; tbl?: string }
  | { type: "wrapCheck"; tag: string; items: { id: string; text: string }[]; viFont?: boolean }
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
  | {
      type: "wrapChecked";
      tag: string;
      /** translations that cannot be laid out in their message box (same check the build runs) */
      bad: { id: string; text: string; message: string }[];
    }
  | { type: "error"; message: string };
