// src/routes/index.tsx
// Game library: every game imported on this device, with progress; import a new ROM here.
// ROMs and translations live in IndexedDB; only the AI job state comes from the server.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { readHeader } from "~/lib/gba/rom";
import { droppedRom, hasPicker, pickRom, type Picked } from "~/lib/pick-rom";
import {
  clearLegacyRom,
  deleteProject,
  listProjects,
  loadLastRom,
  saveRom,
  saveRomHandle,
  type GameSummary,
} from "~/lib/storage";
import { useDialog } from "~/components/Dialog";
import { activeJobs } from "~/server/jobs/fns";
import { seo } from "~/utils/seo";
import "~/styles/translate.css";

export const Route = createFileRoute("/")({
  ssr: false, // reads IndexedDB
  head: () =>
    seo({
      title: "Game của bạn — RomLingo",
      description: "Dịch ROM Pokémon GBA ngay trên trình duyệt: danh sách game đã và đang dịch.",
    }),
  component: Library,
});

type Running = Record<string, { status: string; pct: number }>;
const keyOf = (h: { code: string; crc32: number }) => `${h.code}-${h.crc32.toString(16)}`;

function Library() {
  const navigate = useNavigate();
  const dialog = useDialog();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [running, setRunning] = useState<Running>({});
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const refresh = useCallback(() => {
    void listProjects().then(setGames);
    activeJobs()
      .then((jobs) =>
        setRunning(
          Object.fromEntries(
            jobs.map((j) => [
              `${j.gameCode}-${j.romCrc32}`,
              { status: j.status, pct: Math.round(((j.doneChunks + j.failedChunks) / Math.max(1, j.totalChunks)) * 100) },
            ]),
          ),
        ),
      )
      .catch(() => setRunning({})); // signed out / offline: the list still works
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000); // a job keeps running while its game is not open
    return () => clearInterval(t);
  }, [refresh]);

  // before ROMs were kept per game there was one slot: move that ROM under its own key once
  useEffect(() => {
    void (async () => {
      const f = await loadLastRom();
      if (!f) return;
      try {
        const key = keyOf(readHeader(new Uint8Array(await f.arrayBuffer())));
        await saveRom(key, f);
        await clearLegacyRom();
        refresh();
      } catch {
        await clearLegacyRom(); // not a ROM: nothing to keep
      }
    })();
  }, [refresh]);

  /** Store the ROM under its key (code + CRC), then open its page. `expect`: it must be that game. */
  const store = async ({ file, handle }: Picked, expect?: GameSummary) => {
    setBusy(true);
    setNote(null);
    try {
      const key = keyOf(readHeader(new Uint8Array(await file.arrayBuffer())));
      if (expect && key !== expect.key) {
        setNote(`"${file.name}" không phải đúng bản ROM của ${expect.title} (khác mã hoặc nội dung). Hãy chọn đúng file đã dùng để dịch.`);
        return;
      }
      if (handle) await saveRomHandle(key, handle);
      else await saveRom(key, file);
      await navigate({ to: "/$id", params: { id: key } });
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ROM gone (cleared site data): pick the file again; the translations carry on as they were
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<GameSummary | null>(null);
  const choose = async (expect?: GameSummary) => {
    if (busy) return;
    if (hasPicker()) {
      const r = await pickRom();
      if (r) void store(r, expect);
      return;
    }
    target.current = expect ?? null;
    input.current?.click(); // other browsers: plain file input (keeps a copy)
  };

  return (
    <div className="container tl__intro tl__library">
      <h1>Game của bạn</h1>

      <label
        className={"tl__drop" + (over ? " is-over" : "") + (busy ? " is-disabled" : "")}
        onClick={(e) => {
          if (!hasPicker()) return; // the hidden <input> handles it
          e.preventDefault(); // the picker gives a handle; the input only gives a copy
          void choose();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setOver(false);
          if (busy) return;
          const r = await droppedRom(e.dataTransfer);
          if (r) void store(r);
        }}
      >
        <strong>Kéo thả file ROM (.gba) vào đây để thêm game</strong>
        <span>hoặc bấm để chọn file</span>
        <input
          ref={input}
          type="file"
          accept=".gba,.bin"
          hidden
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void store({ file: f }, target.current ?? undefined);
            target.current = null;
            e.target.value = "";
          }}
        />
      </label>
      <p className="tl__hint">
        File ROM chỉ xử lý ngay trên máy bạn, không bị tải lên server. Bản dịch tự lưu trong trình duyệt. Mỗi lần chỉ một game được dịch AI.
      </p>
      {note && <p className="ai__err" role="alert">{note}</p>}

      <section className="tl__games" aria-label="Danh sách game">
        {games === null ? (
          <p className="tl__hint">Đang tải…</p>
        ) : games.length === 0 ? (
          <p className="tl__hint">Chưa có game nào. Nạp ROM ở trên để bắt đầu.</p>
        ) : (
          <ul>
            {games.map((g) => {
              const job = running[g.key];
              const pct = g.total ? Math.min(100, (g.done / g.total) * 100) : 0;
              return (
                <li key={g.key}>
                  {g.thumb ? (
                    <img className="tl__game-thumb" src={g.thumb} alt="" width={64} height={64} />
                  ) : (
                    <span className="tl__game-thumb tl__game-thumb--empty" aria-hidden>{g.title.slice(0, 1)}</span>
                  )}
                  <div className="tl__game-main">
                    <b>
                      {g.title} <small>({g.code})</small>
                    </b>
                    {job?.status === "running" || job?.status === "queued" ? (
                      <span className="tl__badge tl__badge--ai">AI đang dịch {job.pct}%</span>
                    ) : job?.status === "paused" ? (
                      <span className="tl__badge tl__badge--warn">AI tạm dừng {job.pct}%</span>
                    ) : null}
                    <span className="tl__progress"><span style={{ width: `${pct}%` }} /></span>
                    <small>
                      {g.done.toLocaleString()}
                      {g.total ? ` / ${g.total.toLocaleString()}` : ""} đã dịch · {new Date(g.updatedAt).toLocaleDateString("vi-VN")}
                      {g.rom === "missing" && " · mất file ROM, chọn lại để tiếp tục"}
                      {g.rom === "permission" && " · sẽ hỏi quyền đọc file khi mở"}
                    </small>
                  </div>
                  <div className="tl__game-actions">
                    {g.rom === "missing" ? (
                      <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => choose(g)}>
                        Chọn lại ROM
                      </button>
                    ) : (
                      <Link to="/$id" params={{ id: g.key }} className="btn btn--primary btn--sm">
                        Mở
                      </Link>
                    )}
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={async () => {
                        const ok = await dialog.confirm({
                          title: `Xoá ${g.title}?`,
                          message: "Bản dịch và file ROM đã lưu trên máy sẽ mất. Job AI trên server không bị ảnh hưởng.",
                          confirmLabel: "Xoá",
                          danger: true,
                        });
                        if (!ok) return;
                        await deleteProject(g.key);
                        refresh();
                      }}
                    >
                      Xoá
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
