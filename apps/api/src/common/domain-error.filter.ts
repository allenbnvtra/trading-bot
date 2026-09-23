import { ArgumentsHost, Catch, ConflictException, type ExceptionFilter, NotFoundException } from "@nestjs/common";
import {
  FinalTestAlreadySpentError,
  JournalTradeActiveDecisionConflictError,
  JournalTradeStateError,
  NotFoundError,
  ResearchBudgetExceededError,
  ResearchStageOrderError,
  SetupIncompletePlanError,
  SetupTransitionError,
} from "@trading-copilot/database";
import type { Response } from "express";

/**
 * Single, global translation of packages/database's Milestone 2/3
 * repository error classes into HTTP responses. None of these extend
 * HttpException, so without this filter they would surface as unhandled
 * 500s. Registered once in main.ts via `app.useGlobalFilters(...)` rather
 * than being caught/translated by hand in every service method.
 *
 * JournalTradeActiveDecisionConflictError is also explicitly caught by
 * SetupService.execute()/skip() themselves (see setup.service.ts), which
 * translate it into the exact same ConflictException message their existing
 * findJournalTradeBySetupId fast-path check already produces — so it never
 * actually reaches this filter from those two call sites. It is listed here
 * as well purely as a defensive fallback for any other caller of
 * createJournalTrade/createAndRecordJournalTradeEntry (e.g.
 * JournalTradeService.create, the manual journal-trade endpoint), so a
 * genuine constraint violation there still becomes a clean 409 rather than
 * an unhandled 500.
 *
 * FinalTestAlreadySpentError, ResearchStageOrderError, and
 * ResearchBudgetExceededError (Milestone 7, see
 * packages/database/src/errors.ts) are all raised from
 * researchRepository.createResearchExperiment and ResearchService, and
 * likewise translate to a 409 with the error's own message.
 */
@Catch(
  NotFoundError,
  SetupTransitionError,
  JournalTradeStateError,
  SetupIncompletePlanError,
  JournalTradeActiveDecisionConflictError,
  FinalTestAlreadySpentError,
  ResearchStageOrderError,
  ResearchBudgetExceededError,
)
export class DomainErrorFilter implements ExceptionFilter {
  catch(
    exception:
      | NotFoundError
      | SetupTransitionError
      | JournalTradeStateError
      | SetupIncompletePlanError
      | JournalTradeActiveDecisionConflictError
      | FinalTestAlreadySpentError
      | ResearchStageOrderError
      | ResearchBudgetExceededError,
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
