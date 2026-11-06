// src/server/db.ts
// ============================================================
// SERVER-ONLY: This file must NEVER be imported from client
// code. It lives behind the server boundary.
// ============================================================
import "vinxi/server"; // ensures this cannot tree-shake into client bundle

export type Category = "typescript" | "react" | "performance" | "tooling" | "architecture";

export interface Author {
  id: string;
  name: string;
  avatar: string; // initials for generated avatar
  bio: string;
  twitter: string;
}

export interface Post {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  coverGradient: string;
  category: Category;
  tags: string[];
  authorId: string;
  publishedAt: string;
  readingTime: number; // minutes
  views: number;
  featured: boolean;
}

export interface Comment {
  id: string;
  postId: string;
  author: string;
  content: string;
  createdAt: string;
}

// ---- Seed data (simulates a database) ----
export const AUTHORS: Author[] = [
  {
    id: "alice",
    name: "Alice Chen",
    avatar: "AC",
    bio: "Full-stack engineer obsessed with DX and type safety.",
    twitter: "alice_codes",
  },
  {
    id: "bob",
    name: "Bob Nguyen",
    avatar: "BN",
    bio: "Performance archaeologist & open-source contributor.",
    twitter: "bob_perf",
  },
  {
    id: "cara",
    name: "Cara Osei",
    avatar: "CO",
    bio: "React core team alumna. Writes about compiler internals.",
    twitter: "cara_react",
  },
];

export const POSTS: Post[] = [
  {
    id: "1",
    slug: "tanstack-start-deep-dive",
    title: "TanStack Start: A Deep Dive into the Next-Gen Full-Stack Framework",
    excerpt:
      "Explore how TanStack Start unifies file-based routing, server functions, SSR streaming, and type safety in one cohesive architecture.",
    content: `
<h2>Why TanStack Start Matters</h2>
<p>The React ecosystem has long suffered from a gap between routing and data-fetching. TanStack Start closes that gap by building directly on top of TanStack Router—the first router designed for end-to-end type safety—and adding a first-class server story via Nitro and Vite.</p>

<h3>File-Based Routing Done Right</h3>
<p>Instead of a custom convention, TanStack Start uses a code-generated route tree. You write regular TypeScript files; the router plugin scans them and emits a typed tree. No magic strings, no \`useParams as any\`.</p>

<pre><code>// src/routes/posts.$postId.tsx
export const Route = createFileRoute("/posts/$postId")({
  loader: ({ params }) => getPost({ data: { id: params.postId } }),
  component: PostPage,
});</code></pre>

<h3>Server Functions as First-Class Citizens</h3>
<p><code>createServerFn</code> lets you write server-side code adjacent to the components that consume it. The network boundary is explicit, the types flow across, and the security model is clear: if it's inside <code>.handler()</code>, it never touches the client bundle.</p>

<h2>Streaming and Deferred Data</h2>
<p>Not every piece of data has the same latency profile. TanStack Start's <code>defer()</code> primitive lets you ship critical HTML immediately, then stream slower data as it resolves—all using React Suspense under the hood.</p>

<blockquote>Streaming is not an optimisation. It's the correct default for heterogeneous data.</blockquote>

<p>The result is a framework that feels lightweight to write but heavy-duty under production load.</p>
    `,
    coverGradient: "linear-gradient(135deg, hsl(262,70%,45%), hsl(200,70%,40%))",
    category: "architecture",
    tags: ["tanstack", "react", "ssr", "typescript"],
    authorId: "alice",
    publishedAt: "2026-10-20",
    readingTime: 8,
    views: 12840,
    featured: true,
  },
  {
    id: "2",
    slug: "type-safe-search-params",
    title: "Zero-Cost Type-Safe Search Params with Zod + TanStack Router",
    excerpt:
      "Stop guessing what's in your URL. Learn how validateSearch turns query strings into fully typed, runtime-validated data at the route level.",
    content: `
<h2>The Problem with Search Params</h2>
<p>Traditional routers hand you a <code>URLSearchParams</code> or a plain string object and let you fend for yourself. You end up with \`Number(params.page)\` scattered throughout the codebase, often returning \`NaN\`.</p>

<h3>Enter validateSearch</h3>
<p>TanStack Router's <code>validateSearch</code> hook runs at the route boundary before your loader or component ever sees the data. Combine it with Zod and you get parsing, coercion, and defaults for free.</p>

<pre><code>const searchSchema = z.object({
  q: z.string().default(""),
  page: z.coerce.number().catch(1),
  sort: z.enum(["newest", "popular"]).catch("newest"),
});

export const Route = createFileRoute("/posts")({
  validateSearch: searchSchema.parse,
  loader: ({ deps }) => getPosts({ data: deps }),
});</code></pre>

<h2>Search Dependencies and Stale Avoidance</h2>
<p>Declare which search params your loader depends on via <code>loaderDeps</code>. The router will only re-run the loader when those specific params change, preventing unnecessary refetches.</p>

<p>This is one of the most underappreciated features in the router's design.</p>
    `,
    coverGradient: "linear-gradient(135deg, hsl(145,60%,35%), hsl(185,70%,35%))",
    category: "typescript",
    tags: ["zod", "typescript", "search-params", "tanstack-router"],
    authorId: "alice",
    publishedAt: "2026-10-15",
    readingTime: 6,
    views: 9231,
    featured: false,
  },
  {
    id: "3",
    slug: "react-streaming-ssr",
    title: "React 19 Streaming SSR: From Theory to Production",
    excerpt:
      "React's concurrent rendering and streaming primitives have matured. Here's how to use them effectively in a TanStack Start app.",
    content: `
<h2>Concurrency Is Not Optional</h2>
<p>React 19 ships concurrent rendering on by default. This means Suspense boundaries aren't just for lazy-loaded components anymore—they're the primary mechanism for streaming server-rendered HTML.</p>

<h3>How Streaming Works End-to-End</h3>
<p>When the server receives a request, it renders the React tree to a stream. Suspense boundaries act as flush points: everything outside a Suspense boundary renders immediately, while the suspended subtree is replaced with a fallback and flushed later when the data resolves.</p>

<pre><code>function Dashboard() {
  const { critical, deferred } = Route.useLoaderData();
  return (
    &lt;div&gt;
      &lt;CriticalStats data={critical} /&gt;
      &lt;Suspense fallback={&lt;Skeleton /&gt;}&gt;
        &lt;Await resolve={deferred}&gt;
          {(data) =&gt; &lt;Analytics data={data} /&gt;}
        &lt;/Await&gt;
      &lt;/Suspense&gt;
    &lt;/div&gt;
  );
}</code></pre>

<h2>Choosing the Right SSR Mode</h2>
<p>Not every route needs streaming. Static marketing pages can use <code>ssr: false</code> for pure client rendering, while authenticated dashboards benefit most from streaming.</p>
    `,
    coverGradient: "linear-gradient(135deg, hsl(0,70%,45%), hsl(38,80%,45%))",
    category: "react",
    tags: ["react", "streaming", "ssr", "suspense"],
    authorId: "cara",
    publishedAt: "2026-10-10",
    readingTime: 10,
    views: 7654,
    featured: false,
  },
  {
    id: "4",
    slug: "vite-nitro-deploy",
    title: "Deploy Anywhere: Vite + Nitro Deployment Adapters Explained",
    excerpt:
      "TanStack Start targets Node.js, Cloudflare Workers, Vercel, Netlify, and more—without changing your application code.",
    content: `
<h2>The Adapter Model</h2>
<p>Nitro, the server engine powering TanStack Start, ships a preset system. You pick the deployment target by setting \`server.preset\` in your config. The build output changes accordingly; your application code stays identical.</p>

<pre><code>// app.config.ts
export default defineConfig({
  server: { preset: "cloudflare-pages" },
});</code></pre>

<h3>Available Presets</h3>
<p>Node.js, Bun, Deno, Cloudflare Workers, Cloudflare Pages, Vercel Functions, Vercel Edge, Netlify Functions, AWS Lambda, and more. The list grows with each Nitro release.</p>

<h2>Edge vs. Node Runtime Trade-offs</h2>
<p>Edge runtimes are geographically distributed and start instantly, but they impose strict limits on memory, execution time, and available Node.js APIs. Know your workload before choosing an edge preset.</p>
    `,
    coverGradient: "linear-gradient(135deg, hsl(220,70%,40%), hsl(262,60%,45%))",
    category: "tooling",
    tags: ["vite", "nitro", "deployment", "cloudflare", "vercel"],
    authorId: "bob",
    publishedAt: "2026-10-05",
    readingTime: 7,
    views: 5102,
    featured: false,
  },
  {
    id: "5",
    slug: "web-performance-core-vitals",
    title: "Core Web Vitals Optimization Playbook for 2026",
    excerpt:
      "INP replaced FID, and LCP thresholds tightened. Here's your updated guide to hitting green on all three metrics.",
    content: `
<h2>What Changed in 2026</h2>
<p>Google's Page Experience signals now include INP (Interaction to Next Paint) with a threshold of 100ms (vs. the original 200ms). Meanwhile, LCP measurements now factor in element visibility, not just paint timing.</p>

<h3>Optimizing INP</h3>
<p>INP measures the latency of all user interactions throughout the page's lifecycle. The main culprits are long tasks on the main thread. Break them up with <code>scheduler.yield()</code> or move work to a Web Worker.</p>

<h2>Streaming's Role in LCP</h2>
<p>Server-side streaming significantly improves LCP by getting the first byte of meaningful content to the browser faster. Combined with priority hints and preload links, you can consistently hit sub-2.5s LCP even on slow connections.</p>
    `,
    coverGradient: "linear-gradient(135deg, hsl(38,90%,40%), hsl(145,60%,35%))",
    category: "performance",
    tags: ["performance", "core-web-vitals", "inp", "lcp"],
    authorId: "bob",
    publishedAt: "2026-09-28",
    readingTime: 9,
    views: 11430,
    featured: true,
  },
  {
    id: "6",
    slug: "tanstack-router-middleware",
    title: "Server Function Middleware: Auth, Logging & Context Injection",
    excerpt:
      "Build reusable middleware layers for your TanStack Start server functions—without reaching for a separate backend framework.",
    content: `
<h2>The Middleware Chain</h2>
<p>TanStack Start server functions support a \`.middleware()\` composable. Each middleware can read and write a typed context object, making it trivial to inject authenticated user data, database connections, or telemetry.</p>

<pre><code>const authMiddleware = createMiddleware().server(async ({ next }) => {
  const session = await getSession();
  if (!session) throw redirect({ to: "/login" });
  return next({ context: { user: session.user } });
});

export const getPrivateData = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    // context.user is typed and guaranteed to exist
    return db.query.userData.findMany({
      where: eq(userData.userId, context.user.id),
    });
  });</code></pre>

<h2>Composing Middleware</h2>
<p>Middleware compose left-to-right, sharing the same typed context. Chain auth → logging → rate-limiting without the spaghetti of Express middleware stacks.</p>
    `,
    coverGradient: "linear-gradient(135deg, hsl(300,60%,35%), hsl(262,70%,40%))",
    category: "architecture",
    tags: ["middleware", "auth", "server-functions", "tanstack"],
    authorId: "alice",
    publishedAt: "2026-09-20",
    readingTime: 7,
    views: 6788,
    featured: false,
  },
];

export const COMMENTS: Comment[] = [
  {
    id: "c1",
    postId: "1",
    author: "Dev Reader",
    content: "This is exactly the overview I needed. The defer() section clarified a lot.",
    createdAt: "2026-10-21T08:30:00Z",
  },
  {
    id: "c2",
    postId: "1",
    author: "TypeScript Fan",
    content: "Love that everything is typed end-to-end. No more `as any` in route params!",
    createdAt: "2026-10-21T12:00:00Z",
  },
  {
    id: "c3",
    postId: "2",
    author: "Validation Enjoyer",
    content: "The loaderDeps section saved me a ton of unnecessary fetches.",
    createdAt: "2026-10-16T09:15:00Z",
  },
];

// ---- Helper queries ----
export function getPaginatedPosts(opts: {
  page: number;
  pageSize: number;
  q?: string;
  category?: Category | "all";
  sort?: "newest" | "popular";
}) {
  let results = [...POSTS];

  if (opts.q) {
    const q = opts.q.toLowerCase();
    results = results.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.excerpt.toLowerCase().includes(q) ||
        p.tags.some((t) => t.includes(q))
    );
  }

  if (opts.category && opts.category !== "all") {
    results = results.filter((p) => p.category === opts.category);
  }

  if (opts.sort === "popular") {
    results.sort((a, b) => b.views - a.views);
  } else {
    results.sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
  }

  const total = results.length;
  const start = (opts.page - 1) * opts.pageSize;
  const items = results.slice(start, start + opts.pageSize);

  return { items, total, page: opts.page, pageSize: opts.pageSize };
}

export function getPostBySlug(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug);
}

export function getAuthor(id: string): Author | undefined {
  return AUTHORS.find((a) => a.id === id);
}

export function getCommentsForPost(postId: string): Comment[] {
  return COMMENTS.filter((c) => c.postId === postId);
}

export function getFeaturedPosts(): Post[] {
  return POSTS.filter((p) => p.featured);
}

export function getRelatedPosts(post: Post, limit = 3): Post[] {
  return POSTS.filter(
    (p) => p.id !== post.id && (p.category === post.category || p.tags.some((t) => post.tags.includes(t)))
  ).slice(0, limit);
}
