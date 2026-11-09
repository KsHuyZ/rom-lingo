// Shared modal dialog: `const dialog = useDialog()`, then `await dialog.confirm(...)` / `await dialog.alert(...)`.
// One native <dialog> lives in the root layout; calls made while one is open wait their turn.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

export type DialogOptions = {
  title?: string;
  message: ReactNode;
  /** default: "Đồng ý" (confirm) / "Đóng" (alert) */
  confirmLabel?: string;
  /** default: "Huỷ"; confirm only */
  cancelLabel?: string;
  /** destructive action: red button, and Cancel gets the initial focus */
  danger?: boolean;
};

type Api = {
  /** true = confirmed; false = cancelled (button, Esc or click outside) */
  confirm: (o: DialogOptions | string) => Promise<boolean>;
  alert: (o: DialogOptions | string) => Promise<void>;
};

type Pending = { kind: "confirm" | "alert"; opts: DialogOptions; resolve: (ok: boolean) => void };

const Ctx = createContext<Api | null>(null);

export function useDialog(): Api {
  const api = useContext(Ctx);
  if (!api) throw new Error("useDialog needs <DialogProvider> above it");
  return api;
}

const norm = (o: DialogOptions | string): DialogOptions => (typeof o === "string" ? { message: o } : o);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const current = queue[0];

  const api = useMemo<Api>(
    () => ({
      confirm: (o) => new Promise<boolean>((resolve) => setQueue((q) => [...q, { kind: "confirm", opts: norm(o), resolve }])),
      alert: (o) =>
        new Promise<void>((resolve) => setQueue((q) => [...q, { kind: "alert", opts: norm(o), resolve: () => resolve() }])),
    }),
    [],
  );

  const close = useCallback(
    (ok: boolean) => {
      current?.resolve(ok);
      setQueue((q) => q.slice(1));
    },
    [current],
  );

  // open/close the native dialog with the queue; focus the safe button (Cancel for destructive ones)
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (current && !d.open) d.showModal();
    if (!current && d.open) d.close();
    if (current) d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [current]);

  const o = current?.opts;
  const isConfirm = current?.kind === "confirm";

  return (
    <Ctx.Provider value={api}>
      {children}
      <dialog
        ref={ref}
        className="dlg"
        aria-labelledby={o?.title ? titleId : undefined}
        onCancel={(e) => {
          e.preventDefault(); // Esc: close through state so the promise settles
          close(false);
        }}
        onClose={() => {
          if (current) close(false); // browser closed it anyway (e.g. a second Esc): settle the promise
        }}
        onClick={(e) => {
          if (e.target === ref.current) close(false); // backdrop click
        }}
      >
        {o && (
          <>
            {o.title && <h2 id={titleId} className="dlg__title">{o.title}</h2>}
            <div className="dlg__msg">{o.message}</div>
            <div className="dlg__actions">
              {isConfirm && (
                <button type="button" className="btn btn--secondary btn--sm" data-autofocus={o.danger ? "" : undefined} onClick={() => close(false)}>
                  {o.cancelLabel ?? "Huỷ"}
                </button>
              )}
              <button
                type="button"
                className={`btn btn--sm ${o.danger ? "btn--danger" : "btn--primary"}`}
                data-autofocus={o.danger && isConfirm ? undefined : ""}
                onClick={() => close(true)}
              >
                {o.confirmLabel ?? (isConfirm ? "Đồng ý" : "Đóng")}
              </button>
            </div>
          </>
        )}
      </dialog>
    </Ctx.Provider>
  );
}
