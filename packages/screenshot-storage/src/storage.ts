import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface ScreenshotStorage {
  save(key: string, data: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * Local-disk implementation for development (docs/screenshot-design.md).
 * Production is expected to swap this for an S3-compatible implementation
 * of the same interface (not implemented in this milestone) — nothing else
 * in this codebase should depend on LocalDiskScreenshotStorage's concrete
 * type, only on ScreenshotStorage.
 */
export class LocalDiskScreenshotStorage implements ScreenshotStorage {
  constructor(private readonly rootDir: string) {}

  private resolvePath(key: string): string {
    const resolved = resolve(this.rootDir, key);
    const rootWithSep = resolve(this.rootDir) + sep;
    if (resolved !== resolve(this.rootDir) && !resolved.startsWith(rootWithSep)) {
      throw new Error(`Storage key "${key}" escapes the storage root`);
    }
    return resolved;
  }

  async save(key: string, data: Buffer, _contentType: string): Promise<void> {
    const path = this.resolvePath(key);
    await mkdir(dirname(path), { recursive: true });
    // Write to a temp path then rename, so a crash mid-write never leaves a
    // partially-written file at the real key (docs/screenshot-design.md
    // implies READY only ever means "a complete, valid image exists").
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, data);
    await rename(tmpPath, path);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.resolvePath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }
}
