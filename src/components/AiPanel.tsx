// AI auto-translation panel: account + quote + live job progress (SSE).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "~/lib/auth-client";
import { quote, type PlanItem } from "~/lib/job-plan";
import type { ChunkResult } from "~/server/database/schema";
import type { JobEvent, JobSnapshot } from "~/server/jobs/events";
import { devTopUp, findJob, getAccount, jobControl, startJob } from "~/server/jobs/fns";

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
}) {
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

  const refreshAccount = useCallback(() => getAccount().then(setAccount), []);
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
        refreshAccount(); // unused credits were released
      }
    };
    return () => es.close();
  }, [jobId, live, refreshAccount]);

  const q = useMemo(
    () => (account ? quote(candidates, account.creditsPer1k) : null),
    [candidates, account],
  );

  const start = async () => {
    setBusy(true);
    setError(null);
    arrivals.current = [];
    try {
      const r = await startJob({
        data: { gameCode, romCrc32, diacritics, items: candidates },
      });
      if (r.ok) {
        setJob(r.job);
        refreshAccount();
      } else setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: "pause" | "resume" | "cancel") => {
    if (!job) return;
    if (action === "cancel" && !confirm("Huỷ job? Phần đã dịch được giữ lại, credit chưa dùng sẽ được hoàn.")) return;
    setJob(await jobControl({ data: { jobId: job.id, action } }));
  };

  if (account === undefined) return <section className="ai"><p className="ai__muted">Đang tải…</p></section>;
  if (account === null) return <AuthBox onDone={refreshAccount} />;

  const pct = job ? Math.round(((job.doneChunks + job.failedChunks) / Math.max(1, job.totalChunks)) * 100) : 0;

  return (
    <section className="ai">
      <div className="ai__head">
        <strong>Dịch tự động (AI)</strong>
        <span className="ai__muted">
          {!account.authDisabled && (
            <>
              {account.user.email} · <b>{account.balance.toLocaleString()}</b> credit
              {account.devTopUp && (
                <button className="ai__link" onClick={() => devTopUp().then(refreshAccount)}>
                  +1000 (dev)
                </button>
              )}
              <button className="ai__link" onClick={() => authClient.signOut().then(refreshAccount)}>
                Đăng xuất
              </button>
            </>
          )}
        </span>
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
            Credit: {job.creditsUsed} / giữ chỗ {job.creditsReserved}
            {job.flaggedStrings > 0 && <> · <span className="ai__warn">⚠ {job.flaggedStrings} chuỗi cần xem lại</span></>}
            {job.failedChunks > 0 && <> · <span className="ai__err">{job.failedChunks} chunk lỗi (không tính phí)</span></>}
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
            <span className="ai__muted" title="Tên Pokémon luôn giữ tiếng Anh">· Tên Pokémon: giữ nguyên</span>
          </span>
          <span>
            {candidates.length.toLocaleString()} chuỗi chưa dịch đã chọn
            {q && q.chunks > 0 && (
              <> · {q.chars.toLocaleString()} ký tự{!account.authDisabled && <> · <b>{q.credits.toLocaleString()} credit</b></>}</>
            )}
          </span>
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
          <button
            className="btn btn--primary btn--sm"
            disabled={busy || !candidates.length || (q ? q.credits > account.balance : true)}
            onClick={start}
          >
            {busy ? "Đang tạo job…" : "Dịch tự động"}
          </button>
          {q && q.credits > account.balance && <span className="ai__err">Không đủ credit</span>}
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

function AuthBox({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r =
      mode === "in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: name || email.split("@")[0] });
    setBusy(false);
    if (r.error) setError(r.error.message ?? "Lỗi đăng nhập");
    else onDone();
  };

  return (
    <section className="ai">
      <form className="ai__auth" onSubmit={submit}>
        <strong>{mode === "in" ? "Đăng nhập để dịch tự động" : "Tạo tài khoản"}</strong>
        {mode === "up" && <input placeholder="Tên" value={name} onChange={(e) => setName(e.target.value)} />}
        <input type="email" required placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Mật khẩu (≥ 8 ký tự)"
          autoComplete={mode === "in" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {mode === "in" ? "Đăng nhập" : "Đăng ký"}
        </button>
        <button type="button" className="ai__link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
          {mode === "in" ? "Chưa có tài khoản? Đăng ký" : "Đã có tài khoản? Đăng nhập"}
        </button>
        {error && <span className="ai__err">{error}</span>}
      </form>
    </section>
  );
}
