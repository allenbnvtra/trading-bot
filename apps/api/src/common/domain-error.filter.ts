import { ArgumentsHost, Catch, ConflictException, type ExceptionFilter, NotFoundException } from "@nestjs/common";
import { JournalTradeStateError, NotFoundError, SetupTransitionError } from "@trading-copilot/database";
import type { Response } from "express";

/**
 * Single, global translation of packages/database's Milestone 2 repository
 * error classes into HTTP responses. NotFoundError/SetupTransitionError/
 * JournalTradeStateError do not extend HttpException, so without this
 * filter they would surface as unhandled 500s. Registered once in main.ts
 * via `app.useGlobalFilters(...)` rather than being caught/translated by
 * hand in every service method.
 */
@Catch(NotFoundError, SetupTransitionError, JournalTradeStateError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(
    exception: NotFoundError | SetupTransitionError | JournalTradeStateError,
    host: ArgumentsHost,
  ): void {
    const httpException =
      exception instanceof NotFoundError
        ? new NotFoundException(exception.message)
        : new ConflictException(exception.message);

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    response.status(httpException.getStatus()).json(httpException.getResponse());
  }
}
