import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path alias. Needed so
    // vitest (which resolves modules via vite, not tsc) can import
    // Server Component route files that use the "@/..." import style -
    // e.g. the render routes' page.test.tsx files import their real
    // page.tsx, which imports "@/lib/api".
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    root: "./",
    environment: "jsdom",
  },
});
