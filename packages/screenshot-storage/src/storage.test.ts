import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDiskScreenshotStorage } from "./storage";

describe("LocalDiskScreenshotStorage", () => {
  let root: string;
  let storage: LocalDiskScreenshotStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "screenshot-storage-test-"));
    storage = new LocalDiskScreenshotStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves a file under the root and reports it as existing", async () => {
    await storage.save("setups/abc/pre-trade/1.0.0.png", Buffer.from("fake-png-bytes"), "image/png");
    expect(await storage.exists("setups/abc/pre-trade/1.0.0.png")).toBe(true);
  });

  it("round-trips the exact bytes written", async () => {
    const data = Buffer.from("fake-png-bytes");
    await storage.save("setups/abc/pre-trade/1.0.0.png", data, "image/png");
    const readBack = await storage.read("setups/abc/pre-trade/1.0.0.png");
    expect(readBack.equals(data)).toBe(true);
  });

  it("creates intermediate directories as needed", async () => {
    await storage.save("deeply/nested/path/1.0.0.png", Buffer.from("x"), "image/png");
    const onDisk = await readFile(join(root, "deeply/nested/path/1.0.0.png"));
    expect(onDisk.toString()).toBe("x");
  });

  it("rejects a key that attempts to escape the storage root via path traversal", async () => {
    await expect(storage.save("../../../etc/passwd", Buffer.from("x"), "image/png")).rejects.toThrow(
      /escapes the storage root/i,
    );
  });

  it("exists() returns false for a key that was never saved", async () => {
    expect(await storage.exists("never/saved.png")).toBe(false);
  });

  it("read() throws a clear error for a missing key", async () => {
    await expect(storage.read("never/saved.png")).rejects.toThrow();
  });
});
