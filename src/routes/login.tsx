// src/routes/login.tsx
// Standalone Google sign-in page (Better Auth + Google Identity Services).
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { GoogleSignIn } from "~/components/GoogleSignIn";
import { authClient } from "~/lib/auth-client";
import { seo } from "~/utils/seo";
import "~/styles/login.css";

/** Only same-site absolute paths: blocks open redirects like `//evil.com` or `https://…`. */
function safeRedirect(v: unknown): string {
  return typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : "/";
}

export const Route = createFileRoute("/login")({
  ssr: false, // session lives in a cookie + client SDK; nothing to render on the server
  validateSearch: (s: Record<string, unknown>) => ({ redirect: safeRedirect(s.redirect) }),
  head: () => seo({ title: "Đăng nhập — RomLingo", description: "Đăng nhập hoặc tạo tài khoản RomLingo." }),
  component: LoginPage,
});

function LoginPage() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const session = authClient.useSession();
  const go = () => navigate({ to: redirect, replace: true });

  const user = session.data?.user;

  return (
    <div className="container login">
      <div className="login__card">
        {user ? (
          <>
            <h1 className="login__title">Đã đăng nhập</h1>
            <p className="login__sub">
              Bạn đang dùng tài khoản <b>{user.email}</b>.
            </p>
            <button className="btn btn--primary login__submit" onClick={go}>
              Tiếp tục
            </button>
            <button type="button" className="login__switch" onClick={() => authClient.signOut()}>
              Đăng xuất
            </button>
          </>
        ) : (
          <>
            <h1 className="login__title">Đăng nhập</h1>
            <p className="login__sub">
              Đăng nhập bằng Google để dùng dịch tự động bằng AI.
            </p>
            <GoogleSignIn onDone={go} prompt={false} />
          </>
        )}
        <Link to="/" className="login__back">
          ← Về trang chủ
        </Link>
      </div>
    </div>
  );
}
