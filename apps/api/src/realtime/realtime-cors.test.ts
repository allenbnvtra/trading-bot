import { describe, expect, it } from "vitest";
import { parseRealtimeCorsOrigin } from "./realtime-cors";

describe("parseRealtimeCorsOrigin", () => {
  it("defaults to permissive (true) when unset — local development", () => {
    expect(parseRealtimeCorsOrigin(undefined)).toBe(true);
  });

  it("defaults to permissive (true) for an empty string", () => {
    expect(parseRealtimeCorsOrigin("")).toBe(true);
  });

  it("splits a comma-separated list into an origin array, trimming whitespace", () => {
    expect(parseRealtimeCorsOrigin("https://app.example.com, https://admin.example.com")).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });

  it("supports a single production origin", () => {
    expect(parseRealtimeCorsOrigin("https://app.example.com")).toEqual(["https://app.example.com"]);
  });
});
