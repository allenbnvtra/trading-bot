import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveScreenshotStorageRoot } from "./root-path";

/**
 * Regression coverage for the cross-process storage-path bug: apps/api and
 * apps/worker are started as separate processes, each with its own
 * process.cwd() (its own package directory). Before this fix,
 * SCREENSHOT_STORAGE_ROOT="./storage/screenshots" resolved via Node's
 * `path.resolve` (which anchors to process.cwd()) to two DIFFERENT
 * absolute directories - one per process - so a file the worker wrote was
 * never found by the API. resolveScreenshotStorageRoot must anchor to the
 * monorepo root instead, which is independent of whichever process calls
 * it.
 */
describe("resolveScreenshotStorageRoot", () => {
  const originalCwd = process.cwd();
  let cwdA: string;
  let cwdB: string;

  beforeEach(async () => {
    // Two distinct, unrelated directories standing in for apps/api's cwd
    // and apps/worker's cwd - neither is an ancestor of the monorepo root,
    // so if the implementation ever regressed to cwd-relative resolution,
    // these would produce different (and wrong) results.
    cwdA = await mkdtemp(join(tmpdir(), "screenshot-root-cwd-a-"));
    cwdB = await mkdtemp(join(tmpdir(), "screenshot-root-cwd-b-"));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwdA, { recursive: true, force: true });
    await rm(cwdB, { recursive: true, force: true });
  });

  it("resolves a relative path to the same absolute path regardless of process.cwd()", () => {
    process.chdir(cwdA);
    const resolvedFromA = resolveScreenshotStorageRoot("./storage/screenshots");

    process.chdir(cwdB);
    const resolvedFromB = resolveScreenshotStorageRoot("./storage/screenshots");

    expect(resolvedFromA).toBe(resolvedFromB);
    expect(isAbsolute(resolvedFromA)).toBe(true);
  });

  it("anchors the relative path to the monorepo root, not process.cwd()", () => {
    process.chdir(cwdA);
    const resolved = resolveScreenshotStorageRoot("./storage/screenshots");

    // The monorepo root is an ancestor of this test file's own location,
    // three levels up from packages/screenshot-storage/(src|dist).
    const expectedMonorepoRoot = resolve(__dirname, "..", "..", "..");
    expect(resolved).toBe(resolve(expectedMonorepoRoot, "storage/screenshots"));
    // And, critically, NOT under either fake cwd.
    expect(resolved.startsWith(cwdA)).toBe(false);
    expect(resolved.startsWith(cwdB)).toBe(false);
  });

  it("returns an already-absolute path unchanged", () => {
    process.chdir(cwdA);
    const absoluteInput = resolve(cwdB, "some/absolute/screenshots/root");

    expect(resolveScreenshotStorageRoot(absoluteInput)).toBe(absoluteInput);
  });
});
