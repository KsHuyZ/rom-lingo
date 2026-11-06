// src/utils/seo.ts
// Reusable head() helper for consistent SEO meta tags across all routes.

interface SeoOptions {
  title: string;
  description?: string;
  image?: string;
  noIndex?: boolean;
}

export function seo({ title, description, image, noIndex }: SeoOptions) {
  const siteName = "RomLingo";
  const fullTitle = title.includes(siteName) ? title : `${title} — ${siteName}`;
  const baseUrl = "https://romlingo.dev"; // canonical domain

  const meta: Array<Record<string, string>> = [
    { title: fullTitle },
    { name: "og:type", content: "website" },
    { name: "og:site_name", content: siteName },
    { name: "og:title", content: fullTitle },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:site", content: "@romlingo" },
    { name: "twitter:title", content: fullTitle },
  ];

  if (description) {
    meta.push(
      { name: "description", content: description },
      { name: "og:description", content: description },
      { name: "twitter:description", content: description }
    );
  }

  if (image) {
    meta.push(
      { name: "og:image", content: image },
      { name: "twitter:image", content: image }
    );
  } else {
    const defaultOg = `${baseUrl}/og-default.png`;
    meta.push(
      { name: "og:image", content: defaultOg },
      { name: "twitter:image", content: defaultOg }
    );
  }

  if (noIndex) {
    meta.push({ name: "robots", content: "noindex, nofollow" });
  }

  return { meta };
}
