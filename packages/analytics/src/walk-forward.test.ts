import { describe, expect, it } from "vitest";
import { generateWalkForwardWindows } from "./walk-forward";

describe("generateWalkForwardWindows", () => {
  it("generates non-overlapping-start, deterministic windows stepping forward by stepDays", () => {
    const windows = generateWalkForwardWindows(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z") < new Date("2026-03-01T00:00:00Z") ? 30 : 30,
      15,
    );
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]).toEqual({
      index: 0,
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-31T00:00:00Z"),
    });
    expect(windows[1]!.start).toEqual(new Date("2026-01-16T00:00:00Z"));
  });

  it("rejects non-positive window/step lengths", () => {
    expect(() => generateWalkForwardWindows(new Date(), new Date(Date.now() + 1000), 0, 1)).toThrow();
  });
});
