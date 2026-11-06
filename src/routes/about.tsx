// src/routes/about.tsx
// About page — CLIENT-only rendering (ssr: false).
// Demonstrates choosing the appropriate SSR mode per route.
// No server data needed; purely static content.
import { createFileRoute, Link } from "@tanstack/react-router";
import { seo } from "~/utils/seo";

export const Route = createFileRoute("/about")({
  // SSR mode: disabled — this is a static client-only page.
  // No server round-trip, no loader. Perfect for purely presentational routes.
  ssr: false,

  head: () =>
    seo({
      title: "About — RomLingo",
      description: "Learn about RomLingo, our mission, and the technology stack that powers this blog.",
    }),

  component: AboutPage,
});

function AboutPage() {
  return (
    <div className="container section animate-in">
      {/* Page hero */}
      <div style={{ maxWidth: "var(--content-max)", marginBottom: "var(--space-16)" }}>
        <span className="hero__eyebrow" style={{ marginBottom: "var(--space-5)" }}>
          About this blog
        </span>
        <h1
          className="section__title"
          style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-4xl)", marginBottom: "var(--space-5)" }}
        >
          Built to demonstrate the{" "}
          <span
            style={{
              background: "var(--color-brand-gradient)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            full TanStack Start stack
          </span>
        </h1>
        <p
          style={{
            fontSize: "var(--text-lg)",
            color: "var(--color-text-secondary)",
            lineHeight: 1.7,
            marginBottom: "var(--space-8)",
          }}
        >
          RomLingo is a fully working TanStack Start application that
          demonstrates every major feature of the framework: file-based routing,
          validated search params, route loaders, typed server functions,
          full-document SSR, and streaming.
        </p>
        <div
          style={{
            padding: "var(--space-5)",
            background: "var(--color-brand-glow)",
            border: "1px solid hsl(var(--hue-brand) 70% 65% / 0.3)",
            borderRadius: "var(--radius-lg)",
            fontSize: "var(--text-sm)",
            color: "var(--color-brand)",
            fontFamily: "var(--font-mono)",
          }}
          role="note"
        >
          ⚡ This page renders with <strong>ssr: false</strong> — pure
          client-side rendering. No server round-trip needed for static content.
        </div>
      </div>

      {/* Feature breakdown */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "var(--space-6)",
          marginBottom: "var(--space-16)",
        }}
      >
        {FEATURES.map((f) => (
          <FeatureCard key={f.title} {...f} />
        ))}
      </div>

      {/* Architecture diagram */}
      <div
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-2xl)",
          padding: "var(--space-10)",
          marginBottom: "var(--space-12)",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: "var(--text-2xl)",
            marginBottom: "var(--space-8)",
            textAlign: "center",
          }}
        >
          Architecture Overview
        </h2>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
          }}
        >
          {ARCH_LAYERS.map((layer) => (
            <div
              key={layer.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-4)",
                padding: "var(--space-4)",
                background: "var(--color-surface-2)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span style={{ fontSize: "1.5rem", minWidth: 36 }}>{layer.icon}</span>
              <div>
                <p style={{ fontWeight: 600, color: "var(--color-text)", marginBottom: 2 }}>
                  {layer.label}
                </p>
                <p style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>
                  {layer.description}
                </p>
              </div>
              <span
                className={`ssr-badge ssr-badge--${layer.mode}`}
                style={{ marginLeft: "auto" }}
              >
                {layer.mode}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ textAlign: "center" }}>
        <Link to="/posts" className="btn btn--primary" id="about-cta-articles">
          Read the articles →
        </Link>
      </div>
    </div>
  );
}

// ---- Data ----

const FEATURES: FeatureCardProps[] = [
  {
    icon: "📁",
    title: "File-based Routing",
    description:
      "Routes live in src/routes/. The router plugin scans them and emits a typed route tree automatically.",
    badge: "server",
    badgeLabel: "auto-generated",
  },
  {
    icon: "🔒",
    title: "Validated Search Params",
    description:
      "Every search param is parsed with Zod at the route boundary. No URLSearchParams guessing.",
    badge: "server",
    badgeLabel: "Zod + validateSearch",
  },
  {
    icon: "⚡",
    title: "Route Loaders",
    description:
      "Data is fetched in parallel before the route renders. loaderDeps prevents unnecessary refetches.",
    badge: "server",
    badgeLabel: "parallel loaders",
  },
  {
    icon: "🔧",
    title: "Typed Server Functions",
    description:
      "createServerFn gives you RPC-style server calls with end-to-end type safety and Zod validation.",
    badge: "server",
    badgeLabel: "createServerFn",
  },
  {
    icon: "🌊",
    title: "Streaming SSR",
    description:
      "Critical data renders immediately. Slow data is deferred and streamed via React Suspense + defer().",
    badge: "streaming",
    badgeLabel: "defer + Await",
  },
  {
    icon: "🚀",
    title: "Nitro Deployment",
    description:
      "Change server.preset to target Node.js, Cloudflare, Vercel, or any Nitro adapter—zero app changes.",
    badge: "client",
    badgeLabel: "adapter-agnostic",
  },
];

const ARCH_LAYERS = [
  {
    icon: "🌐",
    label: "Browser / Client",
    description: "React 19 hydration, TanStack Router client-side navigation",
    mode: "client" as const,
  },
  {
    icon: "🔄",
    label: "Streaming SSR Layer",
    description: "React renderToPipeableStream + TanStack defer() for progressive rendering",
    mode: "streaming" as const,
  },
  {
    icon: "🔧",
    label: "Server Functions",
    description: "createServerFn — typed RPC with Zod validation and middleware",
    mode: "server" as const,
  },
  {
    icon: "🏗️",
    label: "Route Loaders",
    description: "Parallel data fetching at route boundaries, selective re-fetching via loaderDeps",
    mode: "server" as const,
  },
  {
    icon: "🚀",
    label: "Nitro Runtime",
    description: "Universal server engine — Node.js, Cloudflare Workers, Vercel, Netlify, and more",
    mode: "server" as const,
  },
];

interface FeatureCardProps {
  icon: string;
  title: string;
  description: string;
  badge: "server" | "streaming" | "client";
  badgeLabel: string;
}

function FeatureCard({ icon, title, description, badge, badgeLabel }: FeatureCardProps) {
  return (
    <div className="card animate-in">
      <div className="card__body">
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: "var(--space-3)",
          }}
        >
          <span style={{ fontSize: "2rem" }} aria-hidden="true">{icon}</span>
          <span className={`ssr-badge ssr-badge--${badge}`}>{badgeLabel}</span>
        </div>
        <h3
          className="card__title"
          style={{ fontSize: "var(--text-base)", marginBottom: "var(--space-2)" }}
        >
          {title}
        </h3>
        <p
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--color-text-secondary)",
            lineHeight: 1.6,
          }}
        >
          {description}
        </p>
      </div>
    </div>
  );
}
