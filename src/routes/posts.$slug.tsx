// src/routes/posts.$slug.tsx
// Post detail — STREAMING SSR.
// Critical data (post + author) is awaited; related posts and comments
// are deferred and streamed as they resolve, using React Suspense + <Await>.
import {
  createFileRoute,
  Link,
  notFound,
  defer,
  Await,
} from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { seo } from "~/utils/seo";
import { getPost, getRelated, getComments, submitComment } from "~/server/fns";
import type { Post, Comment } from "~/server/db";

export const Route = createFileRoute("/posts/$slug")({
  loader: async ({ params }) => {
    // 1. Await critical data (blocks initial SSR flush until ready)
    const result = await getPost({ data: { slug: params.slug } });

    if (!result) {
      throw notFound();
    }

    // 2. Defer slow data — stream as promises, not awaited values
    //    These resolve later and are streamed to the client via Suspense
    const relatedPromise = getRelated({ data: { slug: params.slug } });
    const commentsPromise = getComments({ data: { postId: result.post.id } });

    return {
      post: result.post,
      author: result.author,
      // defer() wraps the promise so TanStack Router knows to stream it
      related: defer(relatedPromise),
      comments: defer(commentsPromise),
    };
  },

  // STREAMING SSR mode: critical data blocks, slow data deferred.
  head: ({ loaderData }: { loaderData?: { post?: Post; author?: any } }) => {
    if (!loaderData?.post) {
      return seo({ title: "Not Found — RomLingo" });
    }
    return seo({
      title: `${loaderData.post.title} — RomLingo`,
      description: loaderData.post.excerpt,
    });
  },

  notFoundComponent: PostNotFound,
  component: PostDetailPage,
});

function PostDetailPage() {
  const { post, author, related, comments } = Route.useLoaderData();

  return (
    <div className="container article animate-in">
      {/* Streaming indicator */}
      <div className="stream-banner" role="status" aria-live="polite">
        <span className="stream-dot" aria-hidden="true" />
        Streaming SSR active — related posts &amp; comments loaded asynchronously
      </div>

      {/* Article header — always immediately available (SSR) */}
      <header className="article__header">
        <div className="article__meta">
          <Link to="/posts" className="btn btn--ghost btn--sm">
            ← All articles
          </Link>
          <span className={`tag tag--brand`}>{post.category}</span>
          <span className="ssr-badge ssr-badge--streaming">Streaming SSR</span>
        </div>

        <h1 className="article__title">{post.title}</h1>
        <p className="article__lead">{post.excerpt}</p>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "var(--space-4)",
            color: "var(--color-text-secondary)",
            fontSize: "var(--text-sm)",
          }}
        >
          <time dateTime={post.publishedAt}>
            📅{" "}
            {new Date(post.publishedAt).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </time>
          <span>⏱ {post.readingTime} min read</span>
          <span>👁 {post.views.toLocaleString()} views</span>
        </div>
      </header>

      {/* Cover image placeholder */}
      <div
        className="article__cover"
        style={{ background: post.coverGradient }}
        role="img"
        aria-label={`Cover image for ${post.title}`}
      />

      {/* Two-column layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: "var(--space-10)",
        }}
      >
        {/* Article body */}
        <div>
          <div
            className="article__body"
            dangerouslySetInnerHTML={{ __html: post.content }}
          />

          {/* Author card */}
          <div
            className="author-card"
            style={{ marginTop: "var(--space-10)" }}
          >
            <div className="author-avatar" aria-hidden="true">
              {author.avatar}
            </div>
            <div>
              <p className="author-name">{author.name}</p>
              <p className="author-bio">{author.bio}</p>
              <p
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--color-brand)",
                  marginTop: "var(--space-1)",
                }}
              >
                @{author.twitter}
              </p>
            </div>
          </div>

          {/* Comments — DEFERRED / STREAMED */}
          <section
            aria-label="Comments"
            style={{ marginTop: "var(--space-10)" }}
          >
            <h2
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: "var(--text-2xl)",
                marginBottom: "var(--space-5)",
              }}
            >
              Comments
            </h2>
            <Suspense
              fallback={
                <div
                  style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
                >
                  {[1, 2].map((i) => (
                    <CommentSkeleton key={i} />
                  ))}
                </div>
              }
            >
              <Await promise={comments}>
                {(commentList: Comment[]) => (
                  <CommentsSection
                    comments={commentList}
                    postId={post.id}
                  />
                )}
              </Await>
            </Suspense>
          </section>
        </div>

        {/* Related posts sidebar — DEFERRED / STREAMED */}
        <aside aria-label="Related articles">
          <Suspense fallback={<RelatedSkeleton />}>
            <Await promise={related}>
              {(relatedPosts: Post[]) => <RelatedPosts posts={relatedPosts} />}
            </Await>
          </Suspense>
        </aside>
      </div>
    </div>
  );
}

// ---- Sub-components ----

interface CommentsSectionProps {
  comments: Comment[];
  postId: string;
}

function CommentsSection({ comments, postId }: CommentsSectionProps) {
  const [localComments, setLocalComments] = useState(comments);
  const [author, setAuthor] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!author.trim() || !content.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const newComment = await submitComment({
        data: { postId, author: author.trim(), content: content.trim() },
      });
      setLocalComments((prev) => [...prev, newComment]);
      setAuthor("");
      setContent("");
    } catch {
      setError("Failed to submit comment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {localComments.length === 0 ? (
        <p
          style={{
            color: "var(--color-text-muted)",
            fontStyle: "italic",
            marginBottom: "var(--space-6)",
          }}
        >
          No comments yet. Be the first!
        </p>
      ) : (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", marginBottom: "var(--space-8)" }}
        >
          {localComments.map((c) => (
            <div
              key={c.id}
              style={{
                padding: "var(--space-4) var(--space-5)",
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-lg)",
              }}
            >
              <p
                style={{
                  fontWeight: 700,
                  fontSize: "var(--text-sm)",
                  marginBottom: "var(--space-2)",
                  color: "var(--color-brand)",
                }}
              >
                {c.author}
                <span
                  style={{
                    fontWeight: 400,
                    color: "var(--color-text-muted)",
                    marginLeft: "var(--space-3)",
                  }}
                >
                  {new Date(c.createdAt).toLocaleDateString()}
                </span>
              </p>
              <p
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {c.content}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Comment form — POST server function */}
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
        aria-label="Leave a comment"
      >
        <h3
          style={{ fontSize: "var(--text-lg)", fontWeight: 700, marginBottom: "var(--space-2)" }}
        >
          Leave a comment
        </h3>
        {error && (
          <p
            style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}
            role="alert"
          >
            {error}
          </p>
        )}
        <input
          id="comment-author"
          type="text"
          placeholder="Your name"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          required
          maxLength={60}
          style={{
            padding: "var(--space-3)",
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            color: "var(--color-text)",
            fontSize: "var(--text-sm)",
            outline: "none",
          }}
          aria-label="Your name"
        />
        <textarea
          id="comment-content"
          placeholder="Share your thoughts…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
          minLength={3}
          maxLength={1000}
          rows={4}
          style={{
            padding: "var(--space-3)",
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            color: "var(--color-text)",
            fontSize: "var(--text-sm)",
            resize: "vertical",
            outline: "none",
            fontFamily: "inherit",
          }}
          aria-label="Your comment"
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting}
          id="comment-submit-btn"
          style={{ alignSelf: "flex-start" }}
        >
          {submitting ? "Submitting…" : "Post Comment"}
        </button>
      </form>
    </div>
  );
}

function RelatedPosts({ posts }: { posts: Post[] }) {
  if (posts.length === 0) {
    return (
      <div className="related-posts">
        <p
          className="related-posts__title"
          style={{ marginBottom: 0 }}
        >
          No related articles found.
        </p>
      </div>
    );
  }

  return (
    <div className="related-posts">
      <p className="related-posts__title">Related Articles</p>
      {posts.map((post, i) => (
        <Link
          key={post.id}
          to="/posts/$slug"
          params={{ slug: post.slug }}
          className="related-post-item"
        >
          <span className="related-post-item__num">
            {String(i + 1).padStart(2, "0")}
          </span>
          <span className="related-post-item__title">{post.title}</span>
        </Link>
      ))}
    </div>
  );
}

function CommentSkeleton() {
  return (
    <div
      style={{
        padding: "var(--space-4) var(--space-5)",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
      }}
    >
      <div
        className="skeleton skeleton--text"
        style={{ width: "30%", marginBottom: "var(--space-3)" }}
      />
      <div className="skeleton skeleton--text" style={{ width: "90%" }} />
      <div className="skeleton skeleton--text" style={{ width: "75%" }} />
    </div>
  );
}

function RelatedSkeleton() {
  return (
    <div className="related-posts">
      <p className="related-posts__title">Related Articles</p>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="related-post-item"
          style={{ pointerEvents: "none" }}
        >
          <span className="skeleton" style={{ width: 20, height: 14 }} />
          <div
            className="skeleton skeleton--text"
            style={{ flex: 1 }}
          />
        </div>
      ))}
    </div>
  );
}

function PostNotFound() {
  return (
    <div className="container state-container">
      <div className="state-container__icon">📄</div>
      <h1 className="state-container__title">Article not found</h1>
      <p className="state-container__description">
        This article may have been moved or deleted.
      </p>
      <Link to="/posts" className="btn btn--primary">
        Browse all articles
      </Link>
    </div>
  );
}
