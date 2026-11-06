// src/routes/translate.tsx
// ROM translation workbench. Everything runs in the browser: the ROM never
// leaves the user's machine. Heavy work lives in a Web Worker.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { seo } from "~/utils/seo";
import { buildCharMap, parseTbl } from "~/lib/gba/charmap";
import { encodeString, longestLine } from "~/lib/gba/text";
import type { BuildIssue, Entry, EntryKind, RomHeader } from "~/lib/gba/rom";
import type { WorkerRequest, WorkerResponse } from "~/lib/gba/protocol";
import { loadProject, saveProject } from "~/lib/storage";
import type { PlanItem } from "~/lib/job-plan";
import type { ChunkResult } from "~/server/database/schema";
import { AiPanel } from "~/components/AiPanel";
import "~/styles/translate.css";

export const Route = createFileRoute("/translate")({
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

type Filter = { kind: EntryKind | "all"; q: string; todo: boolean; flagged: boolean };
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
  const [filter, setFilter] = useState<Filter>({ kind: "all", q: "", todo: false, flagged: false });
  const [aiIds, setAiIds] = useState<Record<string, true>>({});
  const [aiFlags, setAiFlags] = useState<AiFlags>({});
  const [status, setStatus] = useState("Chọn file ROM (.gba) để bắt đầu.");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<BuildIssue[]>([]);
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
        case "error":
          setBusy(false);
          setStatus(`Lỗi: ${m.message}`);
          break;
      }
    };
  }, [header]);

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
  const applyAiResults = useCallback((results: ChunkResult[]) => {
    const current = translationsRef.current;
    const fresh = results.filter((r) => r.text && !current[r.id]);
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
  }, []);

  // ---- file actions
  const openRom = async (file: File) => {
    setBusy(true);
    setStatus(`Đang quét ${file.name}…`);
    setEntries([]);
    setSelected(null);
    setIssues([]);
    setTranslations({});
    setAiIds({});
    setAiFlags({});
    setHeader(null); // forces project reload even when reopening the same ROM
    loadedKey.current = null;
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
    setStatus("Đang build ROM…");
    send({ type: "build", translations, viFont: viSupported && diacritics });
  };

  // ---- derived
  const cm = useMemo(() => buildCharMap(tbl ? parseTbl(tbl) : undefined), [tbl]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entries]);
  const done = useMemo(() => entries.filter((e) => translations[e.id]).length, [entries, translations]);

  const visible = useMemo(() => {
    const q = filter.q.toLowerCase();
    return entries.filter(
      (e) =>
        (filter.kind === "all" || e.kind === filter.kind) &&
        (!filter.todo || !translations[e.id]) &&
        (!filter.flagged || !!aiFlags[e.id]) &&
        (!q || e.text.toLowerCase().includes(q) || translations[e.id]?.toLowerCase().includes(q)),
    );
  }, [entries, filter, translations, aiFlags]);

  // what "Dịch tự động" may send: every untranslated line except Pokémon names (never
  // translated). The panel narrows it to the kinds the user ticks.
  const aiCandidates = useMemo<PlanItem[]>(
    () =>
      entries.flatMap((e) =>
        // flagged lines already have an AI suggestion: do not bill them again
        e.kind === "species" || translations[e.id] || aiFlags[e.id] || !e.text.trim()
          ? []
          : [{ id: e.id, kind: e.kind, text: e.text, capacity: e.capacity, fixed: e.fixed }],
      ),
    [entries, translations, aiFlags],
  );
  const flaggedCount = Object.keys(aiFlags).length;

  const current = entries.find((e) => e.id === selected) ?? null;
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i.message])), [issues]);

  const goNext = () => {
    const i = visible.findIndex((e) => e.id === selected);
    if (i >= 0 && i + 1 < visible.length) setSelected(visible[i + 1].id);
  };

  return (
    <div className="tl">
      <header className="tl__bar">
        <div className="tl__actions">
          <FileButton label="Mở ROM" accept=".gba,.bin" onFile={openRom} primary disabled={busy} />
          <FileButton label="Bảng mã .tbl" accept=".tbl,.txt" onFile={openTbl} disabled={busy} />
          <FileButton label="Nhập JSON" accept=".json" onFile={importJson} disabled={!header} />
          <button className="btn btn--secondary btn--sm" onClick={exportJson} disabled={!header}>
            Xuất JSON
          </button>
          {viSupported && (
            <label className="tl__check" title="Vẽ thêm glyph chữ có dấu vào font của game">
              <input type="checkbox" checked={diacritics} onChange={(e) => setDiacritics(e.target.checked)} /> Font tiếng Việt
            </label>
          )}
          {built && (
            <>
              <button className="btn btn--secondary btn--sm" onClick={() => download(built.rom, `${built.base}_vi.gba`)}>
                Tải ROM (.gba)
              </button>
              <button className="btn btn--secondary btn--sm" onClick={() => download(built.bps, `${built.base}_vi.bps`)}>
                Tải BPS
              </button>
            </>
          )}
          <button className="btn btn--primary btn--sm" onClick={build} disabled={!header || busy || !done}>
            Build ROM + BPS
          </button>
        </div>
        <div className="tl__status" role="status">
          {busy && <span className="tl__spinner" aria-hidden />}
          {status}
        </div>
      </header>

      {header && (
        <div className="tl__meta">
          <span><b>{header.title}</b> · {header.code} · v{header.version}</span>
          <span>{(header.size / 1048576).toFixed(0)} MB</span>
          <span>CRC32 {header.crc32.toString(16).toUpperCase().padStart(8, "0")}</span>
          <span className="tl__progress">
            <span style={{ width: `${entries.length ? (done / entries.length) * 100 : 0}%` }} />
          </span>
          <span>{done.toLocaleString()} / {entries.length.toLocaleString()} đã dịch</span>
        </div>
      )}

      {header && entries.length > 0 && (
        <AiPanel
          gameCode={header.code}
          romCrc32={header.crc32.toString(16)}
          candidates={aiCandidates}
          onResults={applyAiResults}
          diacritics={diacritics}
          onDiacritics={setDiacritics}
          fontReady={viSupported}
        />
      )}

      {entries.length > 0 && (
        <div className="tl__body">
          <aside className="tl__list">
            <div className="tl__filters">
              <input
                type="search"
                placeholder="Tìm text…"
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
                Chưa dịch
              </label>
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
                    {KIND_LABEL[e.kind]}
                    {e.index !== undefined ? ` #${e.index}` : ` 0x${e.offset.toString(16).toUpperCase()}`}
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
              />
            ) : (
              <p className="tl__empty">Chọn một dòng bên trái để dịch.</p>
            )}
          </section>
        </div>
      )}

      {!header && <Intro />}
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
  cm,
  onChange,
  onNext,
}: {
  entry: Entry;
  value: string;
  issue?: string;
  fromAi: boolean;
  aiFlag?: { text: string; issue: string };
  cm: ReturnType<typeof buildCharMap>;
  onChange: (v: string) => void;
  onNext: () => void;
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
      <dl className="tl__info">
        <div><dt>Offset</dt><dd>0x{entry.offset.toString(16).toUpperCase().padStart(6, "0")}</dd></div>
        <div><dt>Sức chứa</dt><dd>{entry.capacity} byte</dd></div>
        <div><dt>Pointer</dt><dd>{entry.fixed ? "bảng cố định" : entry.refs.length}</dd></div>
        {entry.shared && <div><dt>Chú ý</dt><dd>có pointer trỏ vào giữa chuỗi</dd></div>}
      </dl>

      <label className="tl__label">Gốc</label>
      <pre className="tl__orig">{entry.text}</pre>

      {aiFlag && (
        <div className="tl__suggest">
          <span className="tl__badge tl__badge--warn">Gợi ý AI: {aiFlag.issue}</span>
          <pre className="tl__orig">{aiFlag.text}</pre>
          <button className="btn btn--secondary btn--sm" onClick={() => onChange(aiFlag.text)}>
            Dùng gợi ý rồi sửa
          </button>
        </div>
      )}

      <label className="tl__label" htmlFor="tl-input">
        Bản dịch {fromAi && <span className="tl__badge tl__badge--ai">AI</span>}
      </label>
      <textarea
        id="tl-input"
        autoFocus
        rows={6}
        value={value}
        placeholder={entry.text}
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
        {issue && <span className="tl__badge tl__badge--error">Build: {issue}</span>}
        {entry.kind === "dialogue" && line > LINE_MAX && (
          <span className="tl__badge tl__badge--warn">Dòng dài {line} ký tự (khung ~{LINE_MAX}), thêm \n</span>
        )}
      </div>
      <p className="tl__hint">
        <kbd>Ctrl</kbd>+<kbd>Enter</kbd> sang dòng tiếp. Giữ nguyên các mã <code>{"{PLAYER}"}</code>,{" "}
        <code>{"{FC:..}"}</code>. <code>\n</code> xuống dòng, <code>\l</code> cuộn dòng, <code>\p</code> sang khung mới.
      </p>
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

function Intro() {
  return (
    <div className="tl__intro">
      <h1>Dịch ROM Pokémon GBA</h1>
      <p>
        Hỗ trợ Ruby / Sapphire / Emerald / FireRed / LeafGreen bản US/EU. ROM được xử lý hoàn toàn trên máy
        bạn, không upload lên server.
      </p>
      <ul>
        <li>Tự tìm bảng tên Pokémon, chiêu, ability, item và hội thoại (qua pointer).</li>
        <li>Chuỗi dài hơn bản gốc được dời sang vùng mở rộng và tự cập nhật pointer.</li>
        <li>Xuất ROM đã dịch và patch <code>.bps</code> để chia sẻ (không chia sẻ ROM).</li>
        <li>Tiếng Việt có dấu cần hack font, rồi nạp file <code>.tbl</code> map ký tự mới (ví dụ <code>51=ạ</code>).</li>
      </ul>
    </div>
  );
}
