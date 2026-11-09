// AI auto-translation panel: account + quote + live job progress (SSE).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialog } from "~/components/Dialog";
import { GoogleSignIn } from "~/components/GoogleSignIn";
import { quote, type PlanItem } from "~/lib/job-plan";
import type { ChunkResult } from "~/server/database/schema";
import type { JobEvent, JobSnapshot } from "~/server/jobs/events";
import { activeJobs, findJob, getAccount, jobControl, startJob } from "~/server/jobs/fns";

type Account = Awaited<ReturnType<typeof getAccount>>;

const ACTIVE = new Set(["queued", "running", "paused"]);
const STATUS_LABEL: Record<string, string> = {
  queued: "Đang chờ",
  running: "Đang dịch",
  paused: "Tạm dừng",
  done: "Hoàn tất",
  failed: "Thất bại",
  cancelled: "Đã huỷ",
};

const KIND_CHOICES: [PlanItem["kind"], string][] = [
  ["move", "Chiêu"],
  ["item", "Item"],
  ["ability", "Ability"],
  ["dialogue", "Hội thoại"],
];

export function AiPanel({
  gameCode,
  romCrc32,
  candidates: allCandidates,
  onResults,
  diacritics,
  onDiacritics,
  fontReady,
  aiCount,
  flaggedCount,
  onReset,
  onRecheck,
  onFix,
  onCheckWrap,
  junkAiCount,
  onPurgeJunk,
  autoRetry,
  onAutoRetryStarted,
  onSwitchGame,
}: {
  gameCode: string;
  romCrc32: string;
  /** entries the job would translate (untranslated, current filter) */
  candidates: PlanItem[];
  onResults: (r: ChunkResult[]) => void;
  diacritics: boolean;
  onDiacritics: (v: boolean) => void;
  /** the ROM has a Vietnamese font profile: the build adds the glyphs itself */
  fontReady: boolean;
  /** lines currently holding an AI translation / an AI suggestion flagged for review */
  aiCount: number;
  flaggedCount: number;
  /** drop old AI output so the lines become translatable again */
  onReset: (scope: "flagged" | "all") => void;
  /** re-validate saved AI translations with the current rules; returns how many now fail */
  onRecheck: () => number;
  /** auto-fix flagged lines that only fail on punctuation (no AI call); returns how many were fixed */
  onFix: () => number;
  /** lay every translated dialogue line out in its message box, as the build does */
  onCheckWrap: () => void;
  /** AI translations / suggestions left on junk strings by older jobs */
  junkAiCount: number;
  onPurgeJunk: () => void;
  /** lines whose AI answer did not fit its message box, with the rejection to correct */
  autoRetry: PlanItem[];
  onAutoRetryStarted: (ids: string[]) => void;
  /** open another game by its project key (`CODE-crc32`) */
  onSwitchGame: (key: string) => void;
}) {
  const dialog = useDialog();
  const [account, setAccount] = useState<Account | undefined>(undefined);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  // Pokémon names are never translated, so "species" is not offered at all
  const [kinds, setKinds] = useState<Set<PlanItem["kind"]>>(new Set(["move", "item"]));
  const candidates = useMemo(() => allCandidates.filter((c) => kinds.has(c.kind)), [allCandidates, kinds]);
  const perKind = useMemo(() => {
    const n: Record<string, number> = {};
    for (const c of allCandidates) n[c.kind] = (n[c.kind] ?? 0) + 1;
    return n;
  }, [allCandidates]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const arrivals = useRef<number[]>([]);
  const onResultsRef = useRef(onResults);
  onResultsRef.current = onResults;

  const refreshAccount = useCallback(
    () => getAccount().then(setAccount),
    [],
  );
  useEffect(() => {
    refreshAccount();
  }, [refreshAccount]);

  // Resume a job that is still running (e.g. after closing the tab). A finished one is NOT
  // replayed into the table on its own: it can hold thousands of old results (mock runs,
  // junk strings) the user never asked for. It is offered as a button instead.
  const [lastJob, setLastJob] = useState<JobSnapshot | null>(null);
  useEffect(() => {
    if (!account) return;
    findJob({ data: { gameCode, romCrc32 } }).then((j) => {
      if (!j) return;
      if (ACTIVE.has(j.status)) setJob(j);
      else setLastJob(j);
    });
  }, [account?.user.id, gameCode, romCrc32]); // eslint-disable-line react-hooks/exhaustive-deps

  // live progress
  const jobId = job?.id;
  const live = job ? ACTIVE.has(job.status) : false;

  // only one game may translate at a time: another game's running job blocks starting this one
  const [other, setOther] = useState<{ gameCode: string; romCrc32: string } | null>(null);
  useEffect(() => {
    if (!account || live) return setOther(null);
    let off = false;
    activeJobs()
      .then((jobs) => {
        if (off) return;
        const j = jobs.find(
          (x) => (x.status === "running" || x.status === "queued") && !(x.gameCode === gameCode && x.romCrc32 === romCrc32),
        );
        setOther(j ? { gameCode: j.gameCode, romCrc32: j.romCrc32 } : null);
      })
      .catch(() => setOther(null));
    return () => {
      off = true;
    };
  }, [account?.user.id, gameCode, romCrc32, live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!jobId) return;
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as JobEvent;
      setJob(e.job);
      if (e.type === "snapshot" || e.type === "chunk") onResultsRef.current(e.results);
      if (e.type === "chunk") {
        setProvider(e.provider);
        const now = Date.now();
        arrivals.current = [...arrivals.current, now].slice(-10);
        const a = arrivals.current;
        if (a.length >= 2) {
          const perChunk = (a[a.length - 1] - a[0]) / (a.length - 1);
          const left = e.job.totalChunks - e.job.doneChunks - e.job.failedChunks;
          setEta(Math.round((left * perChunk) / 1000));
        }
      }
      if (!ACTIVE.has(e.job.status)) {
        es.close();
        setEta(null);
      }
    };
    return () => es.close();
  }, [jobId, live]);

  const q = useMemo(
    () => (account ? quote(candidates) : null),
    [candidates, account],
  );

  const run = async (items: PlanItem[]) => {
    setBusy(true);
    setError(null);
    arrivals.current = [];
    try {
      const r = await startJob({
        data: { gameCode, romCrc32, diacritics, items },
      });
      if (r.ok) {
        setJob(r.job);
        refreshAccount();
        return true;
      }
      setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
    return false;
  };
  const start = () => run(candidates);

  // Lines the browser found do not fit their message box are sent back to the model once the
  // current job is over, with the exact layout error. The queue is capped per line upstream.
  const [autoOn, setAutoOn] = useState(true);
  const retrying = useRef(false);
  useEffect(() => {
    if (!autoOn || !account || live || busy || other || retrying.current || !autoRetry.length) return;
    retrying.current = true;
    const ids = autoRetry.map((i) => i.id);
    run(autoRetry).then((ok) => {
      if (ok) onAutoRetryStarted(ids);
      retrying.current = false;
    });
  }, [autoOn, account, live, busy, other, autoRetry]); // eslint-disable-line react-hooks/exhaustive-deps

  const control = async (action: "pause" | "resume" | "cancel") => {
    if (!job) return;
    if (
      action === "cancel" &&
      !(await dialog.confirm({
        title: "Huỷ job?",
        message: "Phần đã dịch được giữ lại.",
        confirmLabel: "Huỷ job",
        cancelLabel: "Không",
        danger: true,
      }))
    )
      return;
    setJob(await jobControl({ data: { jobId: job.id, action } }));
  };

  if (account === undefined) return <section className="ai"><p className="ai__muted">Đang tải…</p></section>;
  if (account === null)
    return (
      <section className="ai">
        <div className="ai__auth">
          <strong>Dịch tự động (AI)</strong>
          <span className="ai__muted">Cần đăng nhập để dùng.</span>
          <GoogleSignIn onDone={refreshAccount} />
        </div>
      </section>
    );

  const pct = job ? Math.round(((job.doneChunks + job.failedChunks) / Math.max(1, job.totalChunks)) * 100) : 0;

  return (
    <section className="ai">
      <div className="ai__head">
        <strong>Dịch tự động (AI)</strong>
      </div>

      {job && (live || job.status !== "done" || job.doneStrings > 0) && (
        <div className="ai__job">
          <div className="ai__row">
            <span>
              {STATUS_LABEL[job.status]} · {job.doneStrings.toLocaleString()} / {job.totalStrings.toLocaleString()} chuỗi ·
              chunk {job.doneChunks + job.failedChunks}/{job.totalChunks}
              {eta !== null && live && ` · còn ~${fmtDuration(eta)}`}
            </span>
            <span className="ai__actions">
              {job.status === "running" || job.status === "queued" ? (
                <button className="btn btn--secondary btn--sm" onClick={() => control("pause")}>Tạm dừng</button>
              ) : null}
              {job.status === "paused" && (
                <button className="btn btn--secondary btn--sm" onClick={() => control("resume")}>Tiếp tục</button>
              )}
              {live && (
                <button className="btn btn--ghost btn--sm" onClick={() => control("cancel")}>Huỷ</button>
              )}
            </span>
          </div>
          <div className="ai__bar"><span style={{ width: `${pct}%` }} /></div>
          <div className="ai__muted">
            {provider && <>Nguồn: {provider} · </>}
            {job.fallbackChunks > 0 && <>{job.fallbackChunks} chunk qua dự phòng · </>}
            {job.flaggedStrings > 0 && <> · <span className="ai__warn">⚠ {job.flaggedStrings} chuỗi cần xem lại</span></>}
            {job.failedChunks > 0 && <> · <span className="ai__err">{job.failedChunks} chunk lỗi</span></>}
          </div>
          {job.error && !live && <div className="ai__err">{job.error}</div>}
        </div>
      )}

      {!live && (
        <div className="ai__start">
          <span className="ai__kinds">
            Dịch:
            {KIND_CHOICES.map(([k, label]) => (
              <label key={k} className="tl__check">
                <input
                  type="checkbox"
                  checked={kinds.has(k)}
                  disabled={!perKind[k]}
                  onChange={(e) => {
                    const next = new Set(kinds);
                    if (e.target.checked) next.add(k);
                    else next.delete(k);
                    setKinds(next);
                  }}
                />
                {label} ({(perKind[k] ?? 0).toLocaleString()})
              </label>
            ))}
          </span>
          <span>
            {candidates.length.toLocaleString()} chuỗi chưa dịch đã chọn
            {q && q.chunks > 0 && (
              <> · {q.chars.toLocaleString()} ký tự</>
            )}
          </span>
          <label className="tl__check" title="Câu AI dịch xong mà không vừa ô thoại được tự gửi lại cho AI kèm lỗi cụ thể, tối đa 2 lần mỗi câu">
            <input type="checkbox" checked={autoOn} onChange={(e) => setAutoOn(e.target.checked)} />
            Tự dịch lại câu không vừa ô thoại
          </label>
          <label className="tl__check">
            <input type="checkbox" checked={diacritics} onChange={(e) => onDiacritics(e.target.checked)} />
            {fontReady ? "Có dấu (app tự nhúng font khi build)" : "Có dấu (cần font đã hack)"}
          </label>
          {lastJob && !job && (
            <button
              className="ai__link"
              title="Đổ lại kết quả của job đã chạy xong lần trước vào bảng dịch"
              onClick={() => {
                setJob(lastJob);
                setLastJob(null);
              }}
            >
              Nạp kết quả job trước ({lastJob.doneStrings.toLocaleString()} chuỗi)
            </button>
          )}
          {junkAiCount > 0 && (
            <button
              className="ai__link"
              title="Gỡ bản dịch AI nằm trên chuỗi rác (do job cũ). Build vốn đã bỏ qua chúng; câu bạn tự dịch không bị đụng."
              onClick={async () => {
                const ok = await dialog.confirm({
                  title: "Dọn chuỗi rác",
                  message: `Gỡ ${junkAiCount} bản dịch/gợi ý AI trên chuỗi rác?`,
                  confirmLabel: "Gỡ",
                });
                if (ok) onPurgeJunk();
              }}
            >
              Dọn {junkAiCount.toLocaleString()} bản dịch AI trên chuỗi rác
            </button>
          )}
          <button
            className="ai__link"
            title="Kiểm tra mọi câu thoại đã dịch có vừa ô thoại không (cùng bộ kiểm tra của build). Câu AI không vừa chuyển sang 'cần xem lại'; câu bạn tự dịch được đánh dấu lỗi."
            onClick={onCheckWrap}
          >
            Kiểm tra vừa ô thoại
          </button>
          {aiCount > 0 && (
            <button
              className="ai__link"
              title="Chạy lại bộ kiểm tra hiện tại trên các bản dịch AI đã lưu; câu không đạt chuyển sang 'cần xem lại'"
              onClick={async () => {
                const n = onRecheck();
                await dialog.alert(
                  n ? `${n} bản dịch AI không đạt, đã chuyển sang "cần xem lại". Bấm "Làm lại" để dịch lại.` : "Tất cả bản dịch AI đều đạt.",
                );
              }}
            >
              Kiểm tra lại bản dịch AI
            </button>
          )}
          {flaggedCount > 0 && (
            <button
              className="ai__link"
              title="Sửa tại chỗ các gợi ý lỗi chỉ vì dấu câu font không có (— thành -), không gọi AI. Bỏ qua chuỗi rác."
              onClick={async () => {
                const n = onFix();
                await dialog.alert(n ? `Đã tự sửa ${n} câu.` : "Không có câu nào sửa được tự động.");
              }}
            >
              Tự sửa lỗi dấu câu
            </button>
          )}
          {flaggedCount > 0 && (
            <button
              className="ai__link"
              title="Bỏ các gợi ý AI đang bị đánh dấu lỗi để dịch lại bằng AI (không đụng tới câu đã dịch)"
              onClick={async () => {
                const ok = await dialog.confirm({
                  title: "Làm lại câu lỗi",
                  message: `Bỏ ${flaggedCount} gợi ý lỗi để dịch lại?`,
                  confirmLabel: "Bỏ gợi ý",
                });
                if (ok) onReset("flagged");
              }}
            >
              Làm lại {flaggedCount.toLocaleString()} câu lỗi
            </button>
          )}
          {aiCount > 0 && (
            <button
              className="ai__link"
              title="Xoá mọi bản dịch do AI tạo (câu bạn đã tự sửa được giữ lại) để dịch lại từ đầu"
              onClick={async () => {
                const ok = await dialog.confirm({
                  title: "Xoá bản dịch AI",
                  message: `Xoá ${aiCount} bản dịch AI (cả câu lỗi) để dịch lại? Câu bạn đã sửa tay được giữ.`,
                  confirmLabel: "Xoá",
                  danger: true,
                });
                if (ok) onReset("all");
              }}
            >
              Xoá {aiCount.toLocaleString()} bản dịch AI
            </button>
          )}
          <button
            className="btn btn--primary btn--sm"
            disabled={busy || !candidates.length || !!other}
            onClick={start}
          >
            {busy ? "Đang tạo job…" : "Dịch tự động"}
          </button>
        </div>
      )}
      {!live && other && (
        <div className="ai__muted">
          Đang dịch game khác ({other.gameCode}); mỗi lần chỉ chạy một game.{" "}
          <button className="ai__link" onClick={() => onSwitchGame(`${other.gameCode}-${other.romCrc32}`)}>
            Chuyển sang game đó
          </button>
        </div>
      )}
      {error && <div className="ai__err">{error}</div>}
    </section>
  );
}

function fmtDuration(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} phút` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
