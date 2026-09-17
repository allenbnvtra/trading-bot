import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * NestJS relies on `emitDecoratorMetadata` (design:paramtypes) for
 * constructor-based dependency injection. Vitest's default esbuild
 * transform does not emit that metadata, so `@nestjs/testing`'s
 * `Test.createTestingModule` would fail to resolve providers with more
 * than one constructor dependency. `unplugin-swc` transforms test files
 * with SWC (configured for legacy decorators + metadata) instead, which is
 * the standard Nest + Vitest setup documented by NestJS.
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
