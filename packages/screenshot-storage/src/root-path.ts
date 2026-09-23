import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Walks up from `startDir` until it finds a directory containing
 * `pnpm-workspace.yaml` (this repo's actual workspace marker - see
 * pnpm-workspace.yaml at the repo root). Throws if it reaches the
 * filesystem root without finding one, since that means this module has
 * been moved somewhere the assumption no longer holds and silently
 * returning the wrong directory would be worse than failing loudly.
 */
function findMonorepoRoot(startDir: string): string {
  for (let dir = startDir; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate monorepo root (pnpm-workspace.yaml) walking up from ${startDir}`,
      );
    }
  }
}

/**
 * Resolves a possibly-relative screenshot storage root against a STABLE
 * anchor: the monorepo root, found by walking up from this module's own
 * compiled location (__dirname), rather than against whichever process
 * happens to call it.
 *
 * This matters because apps/api and apps/worker are started as separate
 * processes, each with its OWN process.cwd() (its own package directory,
 * per standard pnpm/turbo workspace behavior). Resolving
 * SCREENSHOT_STORAGE_ROOT with Node's `path.resolve` (which anchors to
 * process.cwd()) therefore resolves to two DIFFERENT directories for the
 * same relative env var, one per process, so a file the worker wrote is
 * never found by the API. Anchoring to the monorepo root instead - a fixed
 * point independent of either process's cwd - guarantees both processes
 * agree on the same absolute path.
 *
 * An already-absolute path is returned unchanged: an operator who
 * explicitly configured an absolute path gets exactly that path, with no
 * re-anchoring.
 */
export function resolveScreenshotStorageRoot(root: string): string {
  if (isAbsolute(root)) {
    return root;
  }
  const monorepoRoot = findMonorepoRoot(__dirname);
  return resolve(monorepoRoot, root);
}
