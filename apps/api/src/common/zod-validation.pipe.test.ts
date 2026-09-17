import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZodValidationPipe } from "./zod-validation.pipe";

describe("ZodValidationPipe", () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().nonnegative(),
  });

  it("returns the parsed value when input is valid", () => {
    const pipe = new ZodValidationPipe(schema);
    const result = pipe.transform({ name: "Ada", age: 30 });
    expect(result).toEqual({ name: "Ada", age: 30 });
  });

  it("applies schema defaults", () => {
    const withDefault = z.object({ slippageTicks: z.number().int().min(0).default(0) });
    const pipe = new ZodValidationPipe(withDefault);
    expect(pipe.transform({})).toEqual({ slippageTicks: 0 });
  });

  it("throws BadRequestException on invalid input", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({ name: "", age: -1 })).toThrow(BadRequestException);
  });

  it("includes issue details in the exception response", () => {
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ name: "", age: -1 });
      expect.fail("expected transform to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        message: string;
        issues: Array<{ path: string; message: string }>;
      };
      expect(response.message).toBe("Validation failed");
      expect(response.issues.length).toBeGreaterThan(0);
      expect(response.issues.some((issue) => issue.path === "name")).toBe(true);
    }
  });
});
