// src/routes/posts.tsx
// Posts list — SSR with validated search params (q, page, sort, category).
// The loader is re-run only when declared deps change (loaderDeps).
import {
  createFileRoute,
  Link,
  useNavigate,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { z } from "zod";
import { seo } from "~/utils/seo";
import { getPosts } from "~/server/fns";
import type { Post } from "~/server/db";

// ---- Validated search schema ----
const postsSearchSchema = z.object({
  q: z.string().optional().default(""),
  page: z.coerce.number().int().min(1).optional().default(1),
  sort: z.enum(["newest", "popular"]).optional().default("newest"),
  category: z
    .enum(["all", "typescript", "react", "performance", "tooling", "architecture"])
    .optional()
    .default("all"),
});

type PostsSearch = z.infer<typeof postsSearchSchema>;
type PostsSearchInput = Partial<PostsSearch> & SearchSchemaInput;

export const Route = createFileRoute("/posts/")({
  // SSR mode: full server render on every navigation with changed deps
  validateSearch: (search: PostsSearchInput): PostsSearch =>
    postsSearchSchema.parse(search),

  // Only re-fetch when these params change (prevents spurious refetches)
  loaderDeps: ({ search }) => ({
    q: search.q,
    page: search.page,
    sort: search.sort,
    category: search.category,
  }),

  head: () =>
    seo({
      title: "Articles — RomLingo",
      description:
        "Browse all engineering articles: TypeScript, React, performance, tooling, and architecture.",
    }),

  loader: async ({ deps }) => {
    const data = await getPosts({
      data: {
        page: deps.page,
        pageSize: 6,
        q: deps.q || undefined,
        category: deps.category as PostsSearch["category"],
        sort: deps.sort,
      },
    });
    return data;
  },

  component: PostsPage,
});

function PostsPage() {
  const { items: posts, total, page, pageSize } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const totalPages = Math.ceil(total / pageSize);

  function updateSearch(patch: Partial<PostsSearch>) {
    navigate({
      search: (prev) => ({ ...prev, ...patch, page: 1 }),
    });
  }

  function goToPage(p: number) {
    navigate({ search: (prev) => ({ ...prev, page: p }) });
  }

  return (
    <div className="container section animate-in">
      {/* Page heading */}
      <div className="section__header">
        <div>
          <h1 className="section__title">All Articles</h1>
          <p className="section__subtitle">
            {total} article{total !== 1 ? "s" : ""} ·{" "}
            <span className="ssr-badge ssr-badge--server">
              Full SSR + Validated Search
            </span>
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="filter-bar" role="search" aria-label="Filter articles">
        <div className="filter-bar__input-wrap">
          <span className="filter-bar__icon" aria-hidden="true">
            🔍
          </span>
          <input
            id="posts-search-input"
            className="filter-bar__input"
            type="search"
            placeholder="Search articles…"
            value={search.q}
            onChange={(e) => updateSearch({ q: e.target.value })}
            aria-label="Search articles"
          />
        </div>

        <select
          id="posts-category-select"
          className="filter-bar__select"
          value={search.category}
          onChange={(e) =>
            updateSearch({ category: e.target.value as PostsSearch["category"] })
          }
          aria-label="Filter by category"
        >
          <option value="all">All categories</option>
          <option value="typescript">TypeScript</option>
          <option value="react">React</option>
          <option value="performance">Performance</option>
          <option value="tooling">Tooling</option>
          <option value="architecture">Architecture</option>
        </select>

        <select
          id="posts-sort-select"
          className="filter-bar__select"
          value={search.sort}
          onChange={(e) =>
            updateSearch({ sort: e.target.value as PostsSearch["sort"] })
          }
          aria-label="Sort articles"
        >
          <option value="newest">Newest first</option>
          <option value="popular">Most popular</option>
        </select>
      </div>

      {/* Post grid */}
      {posts.length === 0 ? (
        <div className="state-container">
          <div className="state-container__icon">📭</div>
          <h2 className="state-container__title">No articles found</h2>
          <p className="state-container__description">
            Try adjusting your search or clearing filters.
          </p>
          <button
            className="btn btn--ghost"
            onClick={() =>
              updateSearch({ q: "", category: "all", sort: "newest" })
            }
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="posts-grid" role="list" aria-label="Article list">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          <button
            className="pagination__btn"
            onClick={() => goToPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            ← Prev
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              className={`pagination__btn ${p === page ? "pagination__btn--active" : ""}`}
              onClick={() => goToPage(p)}
              aria-label={`Page ${p}`}
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </button>
          ))}

          <button
            className="pagination__btn"
            onClick={() => goToPage(page + 1)}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            Next →
          </button>
        </nav>
      )}
    </div>
  );
}

interface PostCardProps {
  post: Post;
}

function PostCard({ post }: PostCardProps) {
  const categoryColors: Record<string, string> = {
    typescript: "brand",
    react: "accent",
    performance: "warning",
    tooling: "muted",
    architecture: "brand",
  };

  return (
    <div role="listitem">
      <Link to="/posts/$slug" params={{ slug: post.slug }}>
        <article className="card" aria-label={`Article: ${post.title}`}>
          <div
            className="card__image"
            style={{ background: post.coverGradient }}
            aria-hidden="true"
          />
          <div className="card__body">
            <div className="card__meta">
              <span
                className={`tag tag--${categoryColors[post.category] ?? "muted"}`}
              >
                {post.category}
              </span>
              <span>{post.readingTime} min</span>
              <span>·</span>
              <time dateTime={post.publishedAt}>
                {new Date(post.publishedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </div>
            <h2 className="card__title">{post.title}</h2>
            <p className="card__excerpt">{post.excerpt}</p>
          </div>
          <div className="card__footer">
            <div className="tech-stack">
              {post.tags.slice(0, 2).map((t) => (
                <span key={t} className="tech-badge">
                  #{t}
                </span>
              ))}
            </div>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
              {post.views.toLocaleString()} views
            </span>
          </div>
        </article>
      </Link>
    </div>
  );
}
