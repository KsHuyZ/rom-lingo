// src/routes/index.tsx
// Home page — SSR (not streaming) since all data is fast.
// Renders featured posts and site intro.
import { createFileRoute, Link } from "@tanstack/react-router";
import { seo } from "~/utils/seo";
import { getFeatured } from "~/server/fns";
import type { Post } from "~/server/db";

export const Route = createFileRoute("/")({
  // SSR mode: full server render, no streaming needed (data is fast)
  head: () =>
    seo({
      title: "RomLingo — Modern Dev Engineering Blog",
      description:
        "Deep dives on TypeScript, React, performance, and the modern web stack. Written by engineers for engineers.",
    }),

  loader: async () => {
    const featured = await getFeatured();
    return { featured };
  },

  component: HomePage,
});

function HomePage() {
  const { featured } = Route.useLoaderData();

  return (
    <div>
      <HeroSection />
      <section className="section container animate-in animate-in--delay-1">
        <div className="section__header">
          <div>
            <h2 className="section__title">Featured Articles</h2>
            <p className="section__subtitle">
              Hand-picked deep dives from our editors
            </p>
          </div>
          <Link to="/posts" className="btn btn--ghost btn--sm">
            View all →
          </Link>
        </div>
        <div className="posts-grid posts-grid--featured">
          {featured.map((post, i) => (
            <FeaturedCard key={post.id} post={post} large={i === 0} />
          ))}
        </div>
      </section>
      <TechStackBanner />
    </div>
  );
}

function HeroSection() {
  return (
    <section className="hero container">
      <div className="animate-in">
        <span className="hero__eyebrow">
          <span>✦</span> Engineering Excellence
        </span>
        <h1 className="hero__title">
          Where <strong>modern web</strong> engineering lives
        </h1>
        <p className="hero__description">
          Deep dives on TypeScript, React 19, TanStack, performance
          optimization, and the architecture decisions that separate good
          software from great software.
        </p>
        <div className="hero__cta">
          <Link to="/posts" className="btn btn--primary" id="cta-read-articles">
            Read Articles
          </Link>
          <Link to="/about" className="btn btn--ghost" id="cta-about">
            About the blog
          </Link>
        </div>
      </div>
    </section>
  );
}

interface FeaturedCardProps {
  post: Post;
  large?: boolean;
}

function FeaturedCard({ post, large }: FeaturedCardProps) {
  return (
    <Link to="/posts/$slug" params={{ slug: post.slug }}>
      <article
        className="card"
        aria-label={`Read: ${post.title}`}
        style={
          large
            ? { gridRow: "span 2" }
            : undefined
        }
      >
        <div
          className="card__image"
          style={{ background: post.coverGradient }}
          aria-hidden="true"
        />
        <div className="card__body">
          <div className="card__meta">
            <span className={`tag tag--brand`}>{post.category}</span>
            <span>{post.readingTime} min read</span>
            <span>·</span>
            <time dateTime={post.publishedAt}>
              {new Date(post.publishedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </time>
          </div>
          <h3
            className="card__title"
            style={large ? { fontSize: "var(--text-xl)" } : undefined}
          >
            {post.title}
          </h3>
          <p className="card__excerpt">{post.excerpt}</p>
        </div>
        <div className="card__footer">
          <div className="tech-stack">
            {post.tags.slice(0, 3).map((t) => (
              <span key={t} className="tech-badge">
                #{t}
              </span>
            ))}
          </div>
          <span
            className="ssr-badge ssr-badge--server"
            title="Rendered server-side"
          >
            SSR
          </span>
        </div>
      </article>
    </Link>
  );
}

function TechStackBanner() {
  const techs = [
    { icon: "⚡", label: "TanStack Start" },
    { icon: "🔀", label: "File-based Routing" },
    { icon: "🔒", label: "Zod Validation" },
    { icon: "🌊", label: "React Streaming" },
    { icon: "🔧", label: "Server Functions" },
    { icon: "🚀", label: "Nitro Deployment" },
  ];

  return (
    <section
      className="section container animate-in animate-in--delay-2"
      aria-label="Technology stack"
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--space-4)",
          justifyContent: "center",
          padding: "var(--space-10)",
          background: "var(--color-surface)",
          borderRadius: "var(--radius-2xl)",
          border: "1px solid var(--color-border)",
        }}
      >
        {techs.map((tech) => (
          <div
            key={tech.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-3) var(--space-5)",
              background: "var(--color-surface-2)",
              borderRadius: "var(--radius-full)",
              border: "1px solid var(--color-border)",
              fontSize: "var(--text-sm)",
              fontWeight: 500,
              color: "var(--color-text-secondary)",
            }}
          >
            <span>{tech.icon}</span>
            {tech.label}
          </div>
        ))}
      </div>
    </section>
  );
}
