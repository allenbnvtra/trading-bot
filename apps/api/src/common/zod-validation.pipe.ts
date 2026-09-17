import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/**
 * Generic Zod-backed validation pipe. Applied per-route with
 * `@UsePipes(new ZodValidationPipe(schema))` using the request-shape schemas
 * already defined in @trading-copilot/shared-types, so every external input
 * (body, query, multipart field) is validated at the boundary before it
 * reaches a controller/service.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Validation failed",
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
