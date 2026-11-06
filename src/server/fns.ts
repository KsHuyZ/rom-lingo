// src/server/fns.ts
// ============================================================
// TYPED SERVER FUNCTIONS — explicit server boundary via
// createServerFn from @tanstack/react-start.
// All handlers run exclusively on the server.
// ============================================================
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  getPaginatedPosts,
  getPostBySlug,
  getAuthor,
  getCommentsForPost,
  getFeaturedPosts,
  getRelatedPosts,
} from "./db";
import type { Category } from "./db";

// ---- Input schemas ----

const PostsQuerySchema = z.object({
  page: z.number().int().min(1).catch(1),
  pageSize: z.number().int().min(1).max(50).catch(6),
  q: z.string().optional(),
  category: z
    .enum(["all", "typescript", "react", "performance", "tooling", "architecture"])
    .catch("all"),
  sort: z.enum(["newest", "popular"]).catch("newest"),
});

const PostSlugSchema = z.object({ slug: z.string().min(1) });

const PostIdSchema = z.object({ postId: z.string().min(1) });

// ---- Server functions ----

/** Paginated, filtered, sorted post list. GET-safe (idempotent). */
export const getPosts = createServerFn({ method: "GET" })
  .validator(PostsQuerySchema)
  .handler(async ({ data }) => {
    // Simulate network latency so SSR streaming is observable
    await new Promise((r) => setTimeout(r, 60));
    return getPaginatedPosts({
      page: data.page,
      pageSize: data.pageSize,
      q: data.q,
      category: data.category as Category | "all",
      sort: data.sort,
    });
  });

/** Single post by slug, with author info. */
export const getPost = createServerFn({ method: "GET" })
  .validator(PostSlugSchema)
  .handler(async ({ data }) => {
    await new Promise((r) => setTimeout(r, 40));
    const post = getPostBySlug(data.slug);
    if (!post) return null;
    const author = getAuthor(post.authorId)!;
    return { post, author };
  });

/** Related posts for a given post — intentionally slow to demo streaming. */
export const getRelated = createServerFn({ method: "GET" })
  .validator(PostSlugSchema)
  .handler(async ({ data }) => {
    // Intentionally slow — will be deferred/streamed
    await new Promise((r) => setTimeout(r, 1200));
    const post = getPostBySlug(data.slug);
    if (!post) return [];
    return getRelatedPosts(post, 3);
  });

/** Comments for a post — also slow for streaming demo. */
export const getComments = createServerFn({ method: "GET" })
  .validator(PostIdSchema)
  .handler(async ({ data }) => {
    await new Promise((r) => setTimeout(r, 800));
    return getCommentsForPost(data.postId);
  });

/** Featured / hero posts. */
export const getFeatured = createServerFn({ method: "GET" })
  .handler(async () => {
    await new Promise((r) => setTimeout(r, 30));
    return getFeaturedPosts();
  });

/** Submit a comment — POST mutation. */
const SubmitCommentSchema = z.object({
  postId: z.string().min(1),
  author: z.string().min(1).max(60),
  content: z.string().min(3).max(1000),
});

export const submitComment = createServerFn({ method: "POST" })
  .validator(SubmitCommentSchema)
  .handler(async ({ data }) => {
    // In a real app: insert into DB, validate session, etc.
    await new Promise((r) => setTimeout(r, 300));
    return {
      id: `c${Date.now()}`,
      postId: data.postId,
      author: data.author,
      content: data.content,
      createdAt: new Date().toISOString(),
    };
  });
