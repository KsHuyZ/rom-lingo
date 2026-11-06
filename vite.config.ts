import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tanstackStart(),
    viteReact(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    {
      name: "tanstack-start-rollup-fix",
      configEnvironment(name) {
        if (name === "client") {
          return {
            build: {
              rollupOptions: {
                input: {
                  index: "virtual:tanstack-start-client-entry",
                },
              },
            },
          };
        }
        if (name === "ssr") {
          return {
            build: {
              rollupOptions: {
                input: "virtual:tanstack-start-server-entry",
              },
            },
          };
        }
      },
    },
  ],
});
