import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * See apps/api/vitest.config.ts for why SWC (not esbuild) is used to
 * transform test files: NestJS DI needs `emitDecoratorMetadata`.
 */
export default defineConfig({
  test: {
    root: "./",
    environment: "node",
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
    }),
  ],
});
