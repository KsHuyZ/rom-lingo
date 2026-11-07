// src/routes/index.tsx
// ROM translation workbench. Everything runs in the browser: the ROM never
// leaves the user's machine. Heavy work lives in a Web Worker.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { seo } from "~/utils/seo";
import { buildCharMap, parseTbl } from "~/lib/gba/charmap";
import { encodeString, longestLine } from "~/lib/gba/text";
import type { BuildIssue, Entry, EntryKind, RomHeader } from "~/lib/gba/rom";
import type { WorkerRequest, WorkerResponse } from "~/lib/gba/protocol";
import { loadLastRom, loadProject, saveLastRom, saveProject } from "~/lib/storage";
import { dialogueLimits, type PlanItem } from "~/lib/job-plan";
import type { ChunkResult } from "~/server/database/schema";
import { looksLikeJunk } from "~/lib/gba/junk";
import { normalizePunct, validate } from "~/server/ai/translate";
import { AiPanel } from "~/components/AiPanel";
import "~/styles/translate.css";

export const Route = createFileRoute("/")({
  head: () =>
    seo({
      title: "Dịch ROM — RomLingo",
      description: "Trích xuất và dịch text ROM Pokémon GBA ngay trên trình duyệt.",
    }),
  component: TranslatePage,
});

const KIND_LABEL: Record<EntryKind, string> = {
  dialogue: "Hội thoại",
  species: "Pokémon",
  move: "Chiêu",
  ability: "Ability",
  item: "Item",
};
const ROW_H = 56;
const LINE_MAX = 36;

const MAX_WRAP_RETRIES = 2;

type Filter = { kind: EntryKind | "all"; q: string; todo: boolean; flagged: boolean; hideJunk: boolean; errors: boolean };
type Step = 1 | 2 | 3;
type AiFlags = Record<string, { text: string; issue: string }>;

function download(data: BlobPart, name: string, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a); // Firefox ignores clicks on detached links
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Last build, kept so the files can be saved again without rebuilding. */
type BuiltFiles = { rom: ArrayBuffer; bps: ArrayBuffer; base: string };

function TranslatePage() {
  const worker = useRef<Worker | null>(null);
  const [header, setHeader] = useState<RomHeader | null>(null);
  const [viSupported, setViSupported] = useState(false);
  const [built, setBuilt] = useState<BuiltFiles | null>(null);
  const [diacritics, setDiacritics] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [tbl, setTbl] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: "all", q: "", todo: false, flagged: false, hideJunk: true, errors: false });
  const [aiIds, setAiIds] = useState<Record<string, true>>({});
  const [aiFlags, setAiFlags] = useState<AiFlags>({});
  const [status, setStatus] = useState("Chọn file ROM (.gba) để bắt đầu.");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [issues, setIssues] = useState<BuildIssue[]>([]);
  // result of the live "does it fit the message box" check for the open line
  const [wrapNote, setWrapNote] = useState<{ id: string; text: string; message: string | null } | null>(null);
  const projectKey = header ? `${header.code}-${header.crc32.toString(16)}` : null;
  const loadedKey = useRef<string | null>(null);

  // ---- worker lifecycle (client only)
  useEffect(() => {
    const w = new Worker(new URL("../lib/gba/rom.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    return () => w.terminate();
  }, []);

  const send = useCallback((msg: WorkerRequest, transfer: Transferable[] = []) => {
    worker.current?.postMessage(msg, transfer);
  }, []);

  useEffect(() => {
    const w = worker.current;
    if (!w) return;
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      switch (m.type) {
        case "header":
          setHeader(m.header);
          setViSupported(m.viFont);
          setDiacritics(m.viFont); // supported ROMs default to accented output
          break;
        case "entries":
          setEntries(m.entries);
          setBusy(false);
          setStep((s) => (s === 1 && m.entries.length ? 2 : s)); // scan done: go translate
          setStatus(`Tìm thấy ${m.entries.length.toLocaleString()} chuỗi trong ${m.ms} ms.`);
          break;
        case "built": {
          setBusy(false);
          setIssues(m.issues);
          const base = header?.title.trim().replace(/\s+/g, "_") || "rom";
          setBuilt({ rom: m.rom, bps: m.bps, base });
          // one file at a time: browsers block a second automatic download
          download(m.rom, `${base}_vi.gba`);
          setStatus(
            `Đã ghi ${m.written} chuỗi (${m.relocated} chuỗi dời sang vùng mở rộng)` +
              (m.fontApplied ? ", đã nhúng font tiếng Việt" : "") +
              " — nếu chưa thấy file, bấm nút Tải ROM / Tải BPS" +
              (m.issues.length ? `, ${m.issues.length} lỗi.` : "."),
          );
          break;
        }
        case "wrapChecked": {
          if (m.tag.startsWith("edit:")) {
            const id = m.tag.slice(5);
            const b = m.bad.find((x) => x.id === id);
            setWrapNote({ id, text: b?.text ?? "", message: b?.message ?? null });
            break;
          }
          // AI output that cannot be laid out in its box becomes a flagged suggestion
          const cur = translationsRef.current;
          let bad = m.bad.filter((b) => cur[b.id] === b.text);
          if (m.tag === "recheck") {
            // the user's own lines stay as they are: they only get the error badge
            const mine = bad.filter((b) => !aiIdsRef.current[b.id]);
            bad = bad.filter((b) => aiIdsRef.current[b.id]);
            // every line just checked gets a fresh verdict; AI lines that failed are flagged below,
            // so only the user's own failing lines keep an error
            setIssues((prev) => [
              ...prev.filter((i) => !checkedRef.current.has(i.id)),
              ...mine.map((b) => ({ id: b.id, message: b.message })),
            ]);
            const waiting = Object.keys(aiFlagsRef.current).length;
            setStatus(
              (m.bad.length
                ? `${bad.length} câu AI không vừa ô thoại đã chuyển sang "cần xem lại"; ${mine.length} câu bạn tự dịch không vừa ô thoại (lọc "Không vừa ô thoại" để xem).`
                : "Các câu thoại đang có bản dịch đều vừa ô thoại.") +
                (waiting ? ` Chưa tính ${waiting} câu "cần xem lại" (chưa có bản dịch được nhận).` : ""),
            );
          }
          if (!bad.length) break;
          setTranslations((prev) => {
            const next = { ...prev };
            for (const b of bad) if (next[b.id] === b.text) delete next[b.id];
            return next;
          });
          setAiIds((prev) => {
            const next = { ...prev };
            for (const b of bad) delete next[b.id];
            return next;
          });
          setAiFlags((prev) => {
            const next = { ...prev };
            for (const b of bad) next[b.id] = { text: b.text, issue: b.message };
            return next;
          });
          if (m.tag === "ai") {
            // ask the model again (bounded): the layout error is concrete feedback
            setWrapTries((prev) => {
              const next = { ...prev };
              for (const b of bad) next[b.id] = (next[b.id] ?? 0) + 1;
              return next;
            });
            setWrapQueue((prev) => {
              const next = { ...prev };
              for (const b of bad)
                if ((wrapTriesRef.current[b.id] ?? 0) < MAX_WRAP_RETRIES)
                  next[b.id] = {
                    prev: b.text,
                    err: `The translation does not fit the message box: ${b.message}. Condense it (drop filler words, merge clauses, keep every fact).`,
                  };
              return next;
            });
          }
          break;
        }
        case "error":
          setBusy(false);
          setStatus(`Lỗi: ${m.message}`);
          break;
      }
    };
  }, [header]);

  // ---- reopen the last ROM after a reload (kept in IndexedDB on this device)
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true; // no cleanup/cancel: StrictMode re-runs effects, the load must still land
    loadLastRom().then(async (file) => {
      if (!file) return;
      setBusy(true);
      setStatus(`Đang mở lại ${file.name}…`);
      const buf = await file.arrayBuffer();
      worker.current?.postMessage({ type: "load", buffer: buf, tbl: undefined } satisfies WorkerRequest, [buf]);
    });
  }, []);

  // ---- project persistence (IndexedDB)
  useEffect(() => {
    if (!projectKey) return;
    let cancelled = false;
    loadProject(projectKey).then((p) => {
      if (cancelled) return;
      if (p) {
        setTranslations(p.translations);
        setAiIds(p.aiIds ?? {});
        setAiFlags(p.aiFlags ?? {});
        if (p.tbl && p.tbl !== tbl) {
          setTbl(p.tbl);
          setBusy(true);
          send({ type: "setTbl", tbl: p.tbl });
        }
      }
      // enable autosave only after the saved project is in state,
      // otherwise an empty map could overwrite it
      loadedKey.current = projectKey;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, send]);

  useEffect(() => {
    if (!projectKey || loadedKey.current !== projectKey) return;
    const t = setTimeout(
      () => saveProject(projectKey, { translations, tbl, aiIds, aiFlags, updatedAt: Date.now() }),
      800,
    );
    return () => clearTimeout(t);
  }, [projectKey, translations, tbl, aiIds, aiFlags]);

  // ---- AI results: fill only lines the user has not translated
  const translationsRef = useRef(translations);
  translationsRef.current = translations;
  // lines whose AI answer failed the real layout check: attempts so far, and the pending retry
  const [wrapTries, setWrapTries] = useState<Record<string, number>>({});
  const [wrapQueue, setWrapQueue] = useState<Record<string, { prev: string; err: string }>>({});
  const checkedRef = useRef<Set<string>>(new Set()); // ids sent with the last "recheck"
  const junkRef = useRef<Set<string>>(new Set());
  const aiFlagsRef = useRef(aiFlags);
  aiFlagsRef.current = aiFlags;
  const wrapTriesRef = useRef(wrapTries);
  wrapTriesRef.current = wrapTries;
  const aiIdsRef = useRef(aiIds);
  aiIdsRef.current = aiIds;
  const viFontRef = useRef(false);
  viFontRef.current = viSupported && diacritics;
  const applyAiResults = useCallback((results: ChunkResult[]) => {
    const current = translationsRef.current;
    // junk strings (code/graphics bytes) are never translated, even if an old job did
    const fresh = results.filter((r) => r.text && !current[r.id] && !junkRef.current.has(r.id));
    if (!fresh.length) return;
    const ok = fresh.filter((r) => r.ok);
    const bad = fresh.filter((r) => !r.ok);
    if (ok.length) {
      setTranslations((prev) => {
        const next = { ...prev };
        for (const r of ok) if (!next[r.id]) next[r.id] = r.text;
        return next;
      });
      setAiIds((prev) => {
        const next = { ...prev };
        for (const r of ok) next[r.id] = true;
        return next;
      });
    }
    setAiFlags((prev) => {
      const next = { ...prev };
      for (const r of ok) delete next[r.id];
      for (const r of bad) next[r.id] = { text: r.text, issue: r.issue ?? "Cần xem lại" };
      return next;
    });
    if (ok.length)
      send({
        type: "wrapCheck",
        tag: "ai",
        items: ok.map((r) => ({ id: r.id, text: r.text })),
        viFont: viFontRef.current,
      });
  }, [send]);

  // ---- file actions
  const openRom = async (file: File) => {
    setBusy(true);
    setStep(1);
    setStatus(`Đang quét ${file.name}…`);
    setEntries([]);
    setSelected(null);
    setIssues([]);
    setTranslations({});
    setAiIds({});
    setAiFlags({});
    setHeader(null); // forces project reload even when reopening the same ROM
    loadedKey.current = null;
    void saveLastRom(file);
    const buf = await file.arrayBuffer();
    send({ type: "load", buffer: buf, tbl }, [buf]);
  };

  const openTbl = async (file: File) => {
    const text = await file.text();
    setTbl(text);
    if (header) {
      setBusy(true);
      send({ type: "setTbl", tbl: text });
    }
    setStatus(`Đã nạp bảng mã ${file.name} (${parseTbl(text).size} ký tự).`);
  };

  const importJson = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      setTranslations((prev) => ({ ...prev, ...(data.translations ?? data) }));
      setStatus(`Đã nhập bản dịch từ ${file.name}.`);
    } catch {
      setStatus("File JSON không hợp lệ.");
    }
  };

  const exportJson = () =>
    download(
      JSON.stringify({ game: header?.code, crc32: header?.crc32, translations }, null, 2),
      `${header?.code ?? "project"}_translations.json`,
      "application/json",
    );

  const build = () => {
    setBusy(true);
    // AI output on junk strings (code/graphics bytes that only look like text) must never reach
    // the ROM: writing there, or repointing the words that "point" at them, corrupts the game.
    const safe: Record<string, string> = {};
    let skipped = 0;
    for (const [id, t] of Object.entries(translations)) {
      if (aiIds[id] && junkIds.has(id)) skipped++;
      else safe[id] = t;
    }
    // the ROM often holds the same dialogue at several offsets (the game reads one of them):
    // give every untranslated identical copy the translation of its twin
    const byText = new Map<string, string>();
    for (const e of entries) if (e.kind === "dialogue" && safe[e.id]) byText.set(e.text, safe[e.id]);
    let copies = 0;
    for (const e of entries) {
      if (e.kind !== "dialogue" || safe[e.id] || junkIds.has(e.id)) continue;
      const t = byText.get(e.text);
      if (t) (safe[e.id] = t), copies++;
    }
    const notes = [skipped && `bỏ qua ${skipped} chuỗi rác do AI dịch`, copies && `áp bản dịch cho ${copies} bản sao trùng`].filter(Boolean);
    setStatus(`Đang build ROM…${notes.length ? ` (${notes.join(", ")})` : ""}`);
    send({ type: "build", translations: safe, viFont: viSupported && diacritics });
  };

  // ---- derived
  const cm = useMemo(() => buildCharMap(tbl ? parseTbl(tbl) : undefined), [tbl]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entries]);
  const done = useMemo(() => entries.filter((e) => translations[e.id]).length, [entries, translations]);

  // dialogue-looking noise (code/graphics bytes that decode as text); translated lines stay visible
  const junkIds = useMemo(
    () => new Set(entries.filter((e) => e.kind === "dialogue" && looksLikeJunk(e.text)).map((e) => e.id)),
    [entries],
  );

  // an error only matters while the line still has a translation that the build would write
  const liveIssues = useMemo(() => issues.filter((i) => translations[i.id]), [issues, translations]);
  const issueIds = useMemo(() => new Set(liveIssues.map((i) => i.id)), [liveIssues]);

  junkRef.current = junkIds;

  // AI output sitting on junk strings (old jobs): harmless to the build, but dead weight
  const junkAiIds = useMemo(
    () => Object.keys(aiIds).filter((id) => junkIds.has(id)).concat(Object.keys(aiFlags).filter((id) => junkIds.has(id) && !aiIds[id])),
    [aiIds, aiFlags, junkIds],
  );
  const purgeJunkAi = () => {
    const drop = new Set(junkAiIds);
    setTranslations((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !(drop.has(id) && aiIds[id]))));
    setAiIds((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !drop.has(id))));
    setAiFlags((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !drop.has(id))));
  };

  const visible = useMemo(() => {
    const q = filter.q.toLowerCase();
    return entries.filter(
      (e) =>
        (filter.kind === "all" || e.kind === filter.kind) &&
        (!filter.hideJunk || !junkIds.has(e.id) || !!translations[e.id]) &&
        (!filter.todo || !translations[e.id]) &&
        (!filter.flagged || !!aiFlags[e.id]) &&
        (!filter.errors || issueIds.has(e.id)) &&
        (!q || e.text.toLowerCase().includes(q) || translations[e.id]?.toLowerCase().includes(q)),
    );
  }, [entries, filter, translations, aiFlags, junkIds, issueIds]);

  // what "Dịch tự động" may send: every untranslated line except Pokémon names (never
  // translated). The panel narrows it to the kinds the user ticks.
  const aiCandidates = useMemo<PlanItem[]>(
    () =>
      entries.flatMap((e) =>
        // flagged lines already have an AI suggestion: do not bill them again
        e.kind === "species" || junkIds.has(e.id) || translations[e.id] || aiFlags[e.id] || !e.text.trim()
          ? []
          : [
              {
                id: e.id,
                kind: e.kind,
                text: e.text,
                capacity: e.capacity,
                fixed: e.fixed,
                ...(e.kind === "dialogue" ? dialogueLimits(e.text) : {}),
              },
            ],
      ),
    [entries, translations, aiFlags, junkIds],
  );
  // junk strings are not the user's concern: they never count as "needs review"
  const autoRetryItems = useMemo<PlanItem[]>(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return Object.entries(wrapQueue).flatMap(([id, retry]) => {
      const e = byId.get(id);
      if (!e || e.kind === "species" || junkIds.has(id) || translations[id]) return [];
      return [
        {
          id,
          kind: e.kind,
          text: e.text,
          capacity: e.capacity,
          fixed: e.fixed,
          ...(e.kind === "dialogue" ? dialogueLimits(e.text) : {}),
          retry,
        },
      ];
    });
  }, [wrapQueue, entries, junkIds, translations]);

  const flaggedCount = Object.keys(aiFlags).filter((id) => !junkIds.has(id)).length;
  const aiCount = Object.keys(aiIds).length;

  // re-run today's validation over AI translations saved earlier (before a validator fix):
  // the ones that now fail move back to "needs review", keeping their text as a suggestion.
  const recheckAi = () => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const bad: Record<string, { text: string; issue: string }> = {};
    for (const id of Object.keys(aiIds)) {
      const e = byId.get(id);
      const t = translations[id];
      if (!e || !t) continue;
      const issue = validate({ id, kind: e.kind, text: e.text, capacity: e.capacity, fixed: e.fixed }, t, diacritics);
      if (issue) bad[id] = { text: t, issue };
    }
    const ids = Object.keys(bad);
    if (ids.length) {
      setTranslations((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      setAiIds((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      setAiFlags((prev) => ({ ...prev, ...bad }));
    }
    return ids.length;
  };

  // run the build's layout check over every translated dialogue line now, not at build time
  const checkWrapAll = () => {
    const items = entries
      .filter((e) => e.kind === "dialogue" && translations[e.id] && !junkIds.has(e.id))
      .map((e) => ({ id: e.id, text: translations[e.id] }));
    checkedRef.current = new Set(items.map((i) => i.id));
    setStatus(`Đang kiểm tra ${items.length.toLocaleString()} câu thoại có vừa ô thoại…`);
    send({ type: "wrapCheck", tag: "recheck", items, viFont: viSupported && diacritics });
  };

  // flagged suggestions that only fail on punctuation the font lacks: fix the text locally and
  // accept it when it now validates. No AI call. Junk strings are skipped.
  const fixFlagged = () => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const fixed: Record<string, string> = {};
    for (const [id, f] of Object.entries(aiFlags)) {
      const e = byId.get(id);
      if (!e || junkIds.has(id)) continue;
      const text = normalizePunct(f.text).normalize("NFC");
      if (text === f.text) continue;
      if (!validate({ id, kind: e.kind, text: e.text, capacity: e.capacity, fixed: e.fixed }, text, diacritics)) fixed[id] = text;
    }
    const ids = Object.keys(fixed);
    if (ids.length) {
      setTranslations((prev) => ({ ...prev, ...fixed }));
      setAiIds((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, true as const])) }));
      setAiFlags((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
    }
    return ids.length;
  };

  // drop old AI output so those lines count as untranslated again and can be re-run.
  // Lines a human edited are no longer in aiIds, so they are never touched.
  const resetAi = (scope: "flagged" | "all") => {
    setAiFlags((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => junkIds.has(id))));
    if (scope === "all") {
      setTranslations((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(aiIds)) delete next[id];
        return next;
      });
      setAiIds({});
    }
  };

  const current = entries.find((e) => e.id === selected) ?? null;
  const issueById = useMemo(() => new Map(liveIssues.map((i) => [i.id, i.message])), [liveIssues]);

  // live fit check for the line being edited (same layout the build runs), debounced
  const currentId = current?.id;
  const currentText = current ? translations[current.id] : undefined;
  useEffect(() => {
    if (!currentId || !currentText?.trim() || current?.kind !== "dialogue") {
      setWrapNote(null);
      return;
    }
    const t = setTimeout(
      () =>
        send({
          type: "wrapCheck",
          tag: `edit:${currentId}`,
          items: [{ id: currentId, text: currentText }],
          viFont: viFontRef.current,
        }),
      300,
    );
    return () => clearTimeout(t);
  }, [currentId, currentText, current?.kind, send, diacritics, viSupported]);

  const goNext = () => {
    const i = visible.findIndex((e) => e.id === selected);
    if (i >= 0 && i + 1 < visible.length) setSelected(visible[i + 1].id);
  };

  // next line still waiting for review, in ROM order, wrapping around; ignores the list filter
  const goNextFlagged = () => {
    const from = entries.findIndex((e) => e.id === selected);
    for (let k = 1; k <= entries.length; k++) {
      const e = entries[(from + k) % entries.length];
      if (e && aiFlags[e.id] && !junkIds.has(e.id) && e.id !== selected) return setSelected(e.id);
    }
  };

  const goPrev = () => {
    const i = visible.findIndex((e) => e.id === selected);
    if (i > 0) setSelected(visible[i - 1].id);
  };

  // open the first line right away so the user sees the editor instead of an empty panel
  useEffect(() => {
    if (!selected && entries.length) {
      setSelected((entries.find((e) => e.kind === "dialogue") ?? entries[0]).id);
    }
  }, [entries, selected]);

  // ---- wizard
  const hasEntries = entries.length > 0;
  const canGo = (n: Step) => n === 1 || (hasEntries && !busy);
  const STEPS: [Step, string][] = [
    [1, "1. Tải ROM"],
    [2, "2. Dịch AI & chỉnh sửa"],
    [3, "3. Xuất ROM"],
  ];
  const stepClass = (n: Step) => (n === step ? "is-current" : n < step ? "is-done" : "");

  return (
    <div className="tl">
      <header className="tl__bar">
        <ol className="tl__steps" aria-label="Các bước">
          {STEPS.map(([n, label]) => (
            <li key={n} className={stepClass(n)} aria-current={n === step ? "step" : undefined}>
              <button type="button" className="tl__step-btn" disabled={!canGo(n)} onClick={() => setStep(n)}>
                {label}
              </button>
            </li>
          ))}
        </ol>
        <div className="tl__status" role="status">
          {busy && <span className="tl__spinner" aria-hidden />}
          {status}
        </div>
      </header>

      {header && step > 1 && (
        <div className="tl__meta">
          <span><b>{header.title}</b> ({header.code})</span>
          <span className="tl__progress">
            <span style={{ width: `${entries.length ? (done / entries.length) * 100 : 0}%` }} />
          </span>
          <span>{done.toLocaleString()} / {entries.length.toLocaleString()} đã dịch</span>
        </div>
      )}

      {/* ---- step 1: load the ROM */}
      {step === 1 && <Intro onFile={openRom} busy={busy} status={status} />}

      {step === 2 && header && entries.length > 0 && (
        <details className="tl__ai" open>
          <summary>Dịch tự động bằng AI <small>(nhanh hơn, vẫn có thể sửa lại từng câu)</small></summary>
        <AiPanel
          gameCode={header.code}
          romCrc32={header.crc32.toString(16)}
          candidates={aiCandidates}
          onResults={applyAiResults}
          diacritics={diacritics}
          onDiacritics={setDiacritics}
          fontReady={viSupported}
          aiCount={aiCount}
          flaggedCount={flaggedCount}
          onReset={resetAi}
          onRecheck={recheckAi}
          onFix={fixFlagged}
          onCheckWrap={checkWrapAll}
          autoRetry={autoRetryItems}
          onAutoRetryStarted={(ids) =>
            setWrapQueue((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.includes(id))))
          }
          junkAiCount={junkAiIds.length}
          onPurgeJunk={purgeJunkAi}
        />
        </details>
      )}

      {step === 2 && entries.length > 0 && (
        <div className="tl__body">
          <aside className="tl__list">
            <div className="tl__filters">
              <input
                type="search"
                placeholder="Tìm câu…"
                value={filter.q}
                onChange={(e) => setFilter({ ...filter, q: e.target.value })}
              />
              <select
                value={filter.kind}
                onChange={(e) => setFilter({ ...filter, kind: e.target.value as Filter["kind"] })}
              >
                <option value="all">Tất cả ({counts.all})</option>
                {(Object.keys(KIND_LABEL) as EntryKind[])
                  .filter((k) => counts[k])
                  .map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]} ({counts[k]})
                    </option>
                  ))}
              </select>
              <label className="tl__check">
                <input
                  type="checkbox"
                  checked={filter.todo}
                  onChange={(e) => setFilter({ ...filter, todo: e.target.checked })}
                />
                Chỉ hiện câu chưa dịch
              </label>
              {junkIds.size > 0 && (
                <label className="tl__check" title="Chuỗi giải mã ra ký tự lạ, nhiều khả năng là dữ liệu mã/đồ hoạ chứ không phải thoại. Cũng không được gửi cho AI.">
                  <input
                    type="checkbox"
                    checked={filter.hideJunk}
                    onChange={(e) => setFilter({ ...filter, hideJunk: e.target.checked })}
                  />
                  Ẩn chuỗi nghi rác ({junkIds.size})
                </label>
              )}
              {issueIds.size > 0 && (
                <label className="tl__check">
                  <input
                    type="checkbox"
                    checked={filter.errors}
                    onChange={(e) => setFilter({ ...filter, errors: e.target.checked })}
                  />
                  Không vừa ô thoại / lỗi xuất ({issueIds.size})
                </label>
              )}
              {flaggedCount > 0 && (
                <label className="tl__check">
                  <input
                    type="checkbox"
                    checked={filter.flagged}
                    onChange={(e) => setFilter({ ...filter, flagged: e.target.checked })}
                  />
                  Cần xem lại ({flaggedCount})
                </label>
              )}
            </div>
            <VirtualList
              items={visible}
              rowHeight={ROW_H}
              render={(e) => (
                <button
                  key={e.id}
                  className={
                    "tl__row" +
                    (e.id === selected ? " is-active" : "") +
                    (translations[e.id] ? " is-done" : "") +
                    (issueById.has(e.id) ? " is-error" : "") +
                    (aiIds[e.id] ? " is-ai" : "") +
                    (aiFlags[e.id] ? " is-flag" : "")
                  }
                  onClick={() => setSelected(e.id)}
                >
                  <span className="tl__row-meta">
                    {translations[e.id] ? "✓ " : ""}
                    {KIND_LABEL[e.kind]}
                    {e.index !== undefined ? ` #${e.index}` : ""}
                  </span>
                  <span className="tl__row-text">{translations[e.id] || e.text}</span>
                </button>
              )}
            />
          </aside>

          <section className="tl__editor">
            {current ? (
              <Editor
                key={current.id}
                entry={current}
                value={translations[current.id] ?? ""}
                issue={issueById.get(current.id)}
                fromAi={!!aiIds[current.id]}
                aiFlag={aiFlags[current.id]}
                wrapIssue={wrapNote?.id === current.id && wrapNote.text === (translations[current.id] ?? "") ? wrapNote.message : null}
                cm={cm}
                onChange={(v) => {
                  setTranslations((prev) => {
                    const next = { ...prev };
                    if (v) next[current.id] = v;
                    else delete next[current.id];
                    return next;
                  });
                  // a human touched it: no longer "AI", flag resolved
                  setAiIds((prev) => {
                    if (!prev[current.id]) return prev;
                    const { [current.id]: _, ...rest } = prev;
                    return rest;
                  });
                  if (v)
                    setAiFlags((prev) => {
                      if (!prev[current.id]) return prev;
                      const { [current.id]: _, ...rest } = prev;
                      return rest;
                    });
                }}
                onNext={goNext}
                onPrev={goPrev}
                flaggedLeft={flaggedCount - (aiFlags[current.id] && !junkIds.has(current.id) ? 1 : 0)}
                onNextFlagged={goNextFlagged}
              />
            ) : (
              <p className="tl__empty">← Chọn một câu ở danh sách bên trái để bắt đầu dịch.</p>
            )}
          </section>
        </div>
      )}

      {step === 2 && entries.length > 0 && (
        <footer className="tl__foot">
          <button className="btn btn--secondary btn--sm" onClick={() => setStep(1)}>← Đổi ROM</button>
          <span className="tl__hint">Chưa dịch hết cũng được: câu chưa dịch giữ nguyên tiếng gốc.</span>
          <button className="btn btn--primary btn--sm" onClick={() => setStep(3)} disabled={busy}>
            Tiếp: Xuất ROM →
          </button>
        </footer>
      )}

      {/* ---- step 3: export */}
      {step === 3 && header && (
        <section className="tl__export">
          <h2>Xuất ROM tiếng Việt</h2>
          <dl className="tl__info">
            <div><dt>Game</dt><dd>{header.title} ({header.code})</dd></div>
            <div><dt>Đã dịch</dt><dd>{done.toLocaleString()} / {entries.length.toLocaleString()} chuỗi ({aiCount.toLocaleString()} bởi AI)</dd></div>
            {flaggedCount > 0 && <div><dt>Cần xem lại</dt><dd>{flaggedCount.toLocaleString()} câu AI chưa được nhận (sẽ không ghi vào ROM)</dd></div>}
            {liveIssues.length > 0 && <div><dt>Lỗi xuất</dt><dd>{liveIssues.length.toLocaleString()} câu không ghi được (xem ở bước 2)</dd></div>}
          </dl>
          {viSupported && (
            <label className="tl__check" title="Vẽ thêm chữ có dấu tiếng Việt vào font của game. Nên bật.">
              <input type="checkbox" checked={diacritics} onChange={(e) => setDiacritics(e.target.checked)} /> Nhúng font tiếng Việt
            </label>
          )}
          <div className="tl__export-actions">
            <button
              className="btn btn--primary"
              onClick={build}
              disabled={busy || !done}
              title={done ? "Tạo file ROM đã dịch để chơi" : "Hãy dịch ít nhất 1 câu ở bước 2"}
            >
              {busy ? "Đang build…" : built ? "Build lại ROM" : "Xuất ROM tiếng Việt"}
            </button>
            {built && (
              <>
                <button className="btn btn--secondary" onClick={() => download(built.rom, `${built.base}_vi.gba`)}>
                  Tải ROM (.gba)
                </button>
                <button className="btn btn--secondary" onClick={() => download(built.bps, `${built.base}_vi.bps`)}>
                  Tải patch (.bps) để chia sẻ
                </button>
              </>
            )}
          </div>
          {issues.length > 0 && (
            <p className="tl__hint">{issues.length} câu bị bỏ qua khi build. Quay lại bước 2, lọc "Không vừa ô thoại / lỗi xuất" để sửa.</p>
          )}
          <details className="tl__tips">
            <summary>Nâng cao</summary>
            <div className="tl__export-actions">
              <FileButton label="Nạp bảng mã (.tbl)" accept=".tbl,.txt" onFile={openTbl} disabled={busy} />
              <FileButton label="Nhập bản dịch (.json)" accept=".json" onFile={importJson} />
              <button className="btn btn--secondary btn--sm" onClick={exportJson}>Lưu bản dịch (.json)</button>
            </div>
          </details>
          <div className="tl__foot">
            <button className="btn btn--secondary btn--sm" onClick={() => setStep(2)}>← Quay lại chỉnh sửa</button>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- editor

function Editor({
  entry,
  value,
  issue,
  fromAi,
  aiFlag,
  wrapIssue,
  cm,
  onChange,
  onNext,
  onPrev,
  flaggedLeft,
  onNextFlagged,
}: {
  entry: Entry;
  value: string;
  issue?: string;
  fromAi: boolean;
  aiFlag?: { text: string; issue: string };
  /** why the line cannot be laid out in its message box (null = fits or unknown) */
  wrapIssue: string | null;
  cm: ReturnType<typeof buildCharMap>;
  onChange: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  /** other lines still flagged for review (excludes the open one) */
  flaggedLeft: number;
  onNextFlagged: () => void;
}) {
  const check = useMemo(() => {
    if (!value) return null;
    try {
      const bytes = encodeString(value, cm).length;
      if (entry.fixed && bytes > entry.capacity)
        return { level: "error", msg: `Quá dài: ${bytes - 1}/${entry.capacity - 1} byte (bảng cố định, không dời được)` };
      if (!entry.fixed && (bytes > entry.capacity || entry.shared))
        return { level: "warn", msg: `${bytes} byte > ${entry.capacity}: sẽ dời sang vùng mở rộng, cập nhật ${entry.refs.length} pointer` };
      return { level: "ok", msg: `${bytes}/${entry.capacity} byte: ghi đè tại chỗ` };
    } catch (e) {
      return { level: "error", msg: (e as Error).message };
    }
  }, [value, cm, entry]);

  const line = longestLine(value || entry.text);

  return (
    <div className="tl__edit">
      <label className="tl__label">Câu gốc</label>
      <pre className="tl__orig">{entry.text}</pre>

      {aiFlag && (
        <div className="tl__suggest">
          <span className="tl__badge tl__badge--warn">AI gợi ý nhưng cần xem lại: {aiFlag.issue}</span>
          <pre className="tl__orig">{aiFlag.text}</pre>
          <button className="btn btn--secondary btn--sm" onClick={() => onChange(aiFlag.text)}>
            Dùng gợi ý này rồi sửa
          </button>
        </div>
      )}

      <label className="tl__label" htmlFor="tl-input">
        Bản dịch của bạn {fromAi && <span className="tl__badge tl__badge--ai">AI</span>}
      </label>
      <textarea
        id="tl-input"
        autoFocus
        rows={6}
        value={value}
        placeholder="Gõ bản dịch tiếng Việt vào đây…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onNext();
          }
        }}
      />
      <div className="tl__checks">
        {check && <span className={`tl__badge tl__badge--${check.level}`}>{check.msg}</span>}
        {issue && <span className="tl__badge tl__badge--error">Lỗi khi xuất ROM: {issue}</span>}
        {wrapIssue && (
          <span className="tl__badge tl__badge--error">Không vừa ô thoại, build sẽ bỏ qua câu này: {wrapIssue}</span>
        )}
        {entry.kind === "dialogue" && line > LINE_MAX && (
          <span className="tl__badge tl__badge--warn">
            Dòng dài {line} ký tự, khung chỉ chứa ~{LINE_MAX}. Hãy xuống dòng bằng \n
          </span>
        )}
      </div>

      <div className="tl__nav">
        <button className="btn btn--secondary btn--sm" onClick={onPrev}>← Câu trước</button>
        <button className="btn btn--primary btn--sm" onClick={onNext}>Câu tiếp →</button>
        {flaggedLeft > 0 && (
          <button className="btn btn--secondary btn--sm" onClick={onNextFlagged}>
            Câu cần xem lại tiếp ({flaggedLeft}) ⚠
          </button>
        )}
        <span className="tl__hint">hoặc nhấn <kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
      </div>

      <details className="tl__tips">
        <summary>Mã đặc biệt &amp; thông tin kỹ thuật</summary>
        <p className="tl__hint">
          Giữ nguyên các mã trong ngoặc như <code>{"{PLAYER}"}</code>, <code>{"{FC:..}"}</code>.{" "}
          <code>\n</code> xuống dòng · <code>\l</code> cuộn dòng · <code>\p</code> sang khung thoại mới.
        </p>
        <dl className="tl__info">
          <div><dt>Vị trí (offset)</dt><dd>0x{entry.offset.toString(16).toUpperCase().padStart(6, "0")}</dd></div>
          <div><dt>Sức chứa</dt><dd>{entry.capacity} byte</dd></div>
          <div><dt>Pointer</dt><dd>{entry.fixed ? "bảng cố định" : entry.refs.length}</dd></div>
          {entry.shared && <div><dt>Chú ý</dt><dd>có pointer trỏ vào giữa chuỗi</dd></div>}
        </dl>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- bits

function VirtualList<T>({
  items,
  rowHeight,
  render,
}: {
  items: T[];
  rowHeight: number;
  render: (item: T) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 5);
  const end = Math.min(items.length, Math.ceil((scroll + height) / rowHeight) + 5);
  return (
    <div className="tl__scroll" ref={ref} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      <div style={{ height: items.length * rowHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
          {items.slice(start, end).map(render)}
        </div>
      </div>
    </div>
  );
}

function FileButton({
  label,
  accept,
  onFile,
  primary,
  disabled,
}: {
  label: string;
  accept: string;
  onFile: (f: File) => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className={`btn btn--sm ${primary ? "btn--primary" : "btn--secondary"}${disabled ? " is-disabled" : ""}`}>
      {label}
      <input
        type="file"
        accept={accept}
        hidden
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}

function Intro({ onFile, busy, status }: { onFile: (f: File) => void; busy: boolean; status: string }) {
  const [over, setOver] = useState(false);
  return (
    <div className="tl__intro">
      <h1>Dịch ROM Pokémon GBA</h1>
      <label
        className={"tl__drop" + (over ? " is-over" : "") + (busy ? " is-disabled" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !busy) onFile(f);
        }}
      >
        <strong>Kéo thả file ROM (.gba) vào đây</strong>
        <span>hoặc bấm để chọn file</span>
        <input
          type="file"
          accept=".gba,.bin"
          hidden
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
      </label>
      {busy && (
        <div className="tl__loading" role="status">
          <span className="tl__spinner" aria-hidden /> {status}
        </div>
      )}
      <ol className="tl__how">
        <li><b>Tải ROM</b> của bạn (Ruby, Sapphire, Emerald, FireRed, LeafGreen bản US/EU).</li>
        <li><b>Dịch AI &amp; chỉnh sửa</b>: để AI dịch tự động, rồi sửa lại từng câu nếu cần.</li>
        <li><b>Xuất ROM tiếng Việt</b> rồi chơi trên máy giả lập.</li>
      </ol>
      <p className="tl__hint">
        File ROM chỉ xử lý ngay trên máy bạn, không bị tải lên server. Bản dịch tự lưu trong trình duyệt.
      </p>
    </div>
  );
}
