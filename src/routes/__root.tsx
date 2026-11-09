// src/routes/__root.tsx
// Root route: HTML document shell only. Header + page outlet.
import { createRootRouteWithContext, Outlet, HeadContent, Scripts } from "@tanstack/react-router";
import { DialogProvider } from "~/components/Dialog";
import { SiteHeader } from "~/components/SiteHeader";
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
      { name: "theme-color", content: "#2db5a6" },
    ],
    links: [{ rel: "icon", type: "image/png", href: "/logo.png" }],
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
        <DialogProvider>
          <SiteHeader />
          <main id="main-content">
            <Outlet />
          </main>
        </DialogProvider>
        <Scripts />
      </body>
    </html>
  );
}
