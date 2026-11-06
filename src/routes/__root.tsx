// src/routes/__root.tsx
// The root route renders the full HTML document shell (full-document SSR).
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import "../global.css";

export const Route = createRootRouteWithContext<object>()({
  // Full-document SSR: the head() function supplies per-page metadata
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "RomLingo — Modern Dev Engineering Blog" },
      {
        name: "description",
        content:
          "Deep dives on TypeScript, React, performance, and the modern web stack.",
      },
      { name: "theme-color", content: "#0d0f14" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    ],
  }),

  notFoundComponent: RootNotFoundComponent,
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <SiteNav />
        <main id="main-content">
          <Outlet />
        </main>
        <SiteFooter />
        {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
        <Scripts />
      </body>
    </html>
  );
}

function RootNotFoundComponent() {
  return (
    <div className="container section" style={{ textAlign: "center", padding: "var(--space-20) 0" }}>
      <div className="empty-state">
        <span style={{ fontSize: "var(--text-4xl)", marginBottom: "var(--space-4)", display: "block" }}>
          🔍
        </span>
        <h1 className="section__title" style={{ marginBottom: "var(--space-3)" }}>
          Page Not Found
        </h1>
        <p className="section__subtitle" style={{ marginBottom: "var(--space-6)" }}>
          The page or article you are looking for does not exist or has been moved.
        </p>
        <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "center" }}>
          <Link to="/" className="btn btn--primary">
            Return Home
          </Link>
          <Link to="/posts" className="btn btn--secondary">
            Browse Articles
          </Link>
        </div>
      </div>
    </div>
  );
}

function SiteNav() {
  return (
    <nav className="nav" aria-label="Primary navigation">
      <div className="container nav__inner">
        <Link to="/" className="nav__brand" aria-label="RomLingo Home">
          <span className="brand-dot" aria-hidden="true" />
          RomLingo
        </Link>

        <div className="nav__links" role="list">
          <Link
            to="/"
            className="nav__link"
            activeProps={{ className: "nav__link active" }}
            activeOptions={{ exact: true }}
            role="listitem"
          >
            Home
          </Link>
          <Link
            to="/posts"
            className="nav__link"
            activeProps={{ className: "nav__link active" }}
            role="listitem"
          >
            Articles
          </Link>
          <Link
            to="/translate"
            className="nav__link"
            activeProps={{ className: "nav__link active" }}
            role="listitem"
          >
            Dịch ROM
          </Link>
          <Link
            to="/about"
            className="nav__link"
            activeProps={{ className: "nav__link active" }}
            role="listitem"
          >
            About
          </Link>
        </div>

        <div className="nav__links">
          <span
            className="ssr-badge ssr-badge--streaming"
            title="Streaming SSR active"
          >
            ⚡ Streaming SSR
          </span>
        </div>
      </div>
    </nav>
  );
}

function SiteFooter() {
  return (
    <footer className="footer">
      <div className="container footer__inner">
        <p className="footer__copy">
          © {new Date().getFullYear()} RomLingo. Built with TanStack Start.
        </p>
        <div className="footer__links">
          <Link to="/">Home</Link>
          <Link to="/posts">Articles</Link>
          <Link to="/about">About</Link>
        </div>
      </div>
    </footer>
  );
}
