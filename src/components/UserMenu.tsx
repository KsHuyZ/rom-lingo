import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { authClient } from "~/lib/auth-client";

function Avatar({ src, name }: { src?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed)
    return (
      <img
        className="avatar"
        src={src}
        alt=""
        width={28}
        height={28}
        referrerPolicy="no-referrer" // Google avatar hosts reject some referrers
        onError={() => setFailed(true)}
      />
    );
  return (
    <span className="avatar avatar--fallback" aria-hidden>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** Small account menu; login link while signed out, avatar dropdown when signed in. */
export function UserMenu() {
  const { data, isPending } = authClient.useSession();
  const user = data?.user;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (isPending) return null;
  if (!user)
    return (
      <Link to="/login" search={{ redirect: "/" }} className="nav__link">
        Đăng nhập
      </Link>
    );
  const label = user.name || user.email;

  return (
    <div className="usermenu" ref={ref}>
      <button
        type="button"
        className="nav__user"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar src={user.image} name={label} />
        <span className="nav__user-name">{label}</span>
        <span aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="usermenu__panel" role="menu">
          <p className="usermenu__email">{user.email}</p>
          <button
            type="button"
            role="menuitem"
            className="btn btn--secondary btn--sm usermenu__out"
            onClick={() => authClient.signOut().then(() => setOpen(false))}
          >
            Đăng xuất
          </button>
        </div>
      )}
    </div>
  );
}
