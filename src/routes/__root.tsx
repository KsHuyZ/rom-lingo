// src/routes/__root.tsx
// Root route: full HTML document shell (SSR) + top nav.
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import "../global.css";

export const Route = createRootRouteWithContext<object>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "RomLingo — Dịch ROM Pokémon GBA" },
      {
        name: "description",
        content: "Trích xuất và dịch text ROM Pokémon GBA ngay trên trình duyệt.",
      },
      { name: "theme-color", content: "#0d0f14" },
    ],
    links: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="vi">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav className="nav" aria-label="Primary navigation">
          <div className="container nav__inner">
            <Link to="/translate" className="nav__brand" aria-label="RomLingo">
              <span className="brand-dot" aria-hidden="true" />
              RomLingo
            </Link>
            <div className="nav__links">
              <Link
                to="/translate"
                className="nav__link"
                activeProps={{ className: "nav__link active" }}
              >
                Dịch ROM
              </Link>
              <Link
                to="/login"
                search={{ redirect: "/translate" }}
                className="nav__link"
                activeProps={{ className: "nav__link active" }}
              >
                Đăng nhập
              </Link>
            </div>
          </div>
        </nav>
        <main id="main-content">
          <Outlet />
        </main>
        <Scripts />
      </body>
    </html>
  );
}
