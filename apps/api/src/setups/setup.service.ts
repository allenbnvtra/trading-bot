import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { journalEventsRepository, riskCalculationsRepository, setupsRepository } from "@trading-copilot/database";
import type {
  CreateRiskCalculationInput,
  CreateSetupInput,
  SetupListQuery,
  UpdateSetupStatusInput,
} from "@trading-copilot/shared-types";
import type { JournalEvent, RiskCalculation, Setup } from "@trading-copilot/trading-domain";
import { ScreenshotService } from "../screenshots/screenshot.service";

/**
 * Converts validated request strings to Date/Decimal here, at the service
 * layer. NotFoundError/SetupTransitionError raised by
 * setupsRepository.transitionSetupStatus (and NotFoundError raised by
 * riskCalculationsRepository.createRiskCalculation) are deliberately left
 * to propagate — the global DomainErrorFilter (see
 * ../common/domain-error.filter.ts) translates them to 404/409 once, rather
 * than every method here repeating a try/catch.
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(private readonly screenshotService: ScreenshotService) {}

  create(input: CreateSetupInput): Promise<Setup> {
    return setupsRepository.createSetup({
      instrumentId: input.instrumentId,
      strategyId: input.strategyId,
      strategyVersionId: input.strategyVersionId,
      marketSnapshotId: input.marketSnapshotId,
      direction: input.direction,
      source: input.source,
      plannedEntry: new Decimal(input.plannedEntry),
      plannedStop: input.plannedStop ? new Decimal(input.plannedStop) : null,
      plannedTarget1: input.plannedTarget1 ? new Decimal(input.plannedTarget1) : null,
      plannedTarget2: input.plannedTarget2 ? new Decimal(input.plannedTarget2) : null,
      decisionSummary: input.decisionSummary ?? null,
      metadata: input.metadata,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
  }

  list(query: SetupListQuery): Promise<Setup[]> {
    return setupsRepository.listSetups({
      instrumentId: query.instrumentId,
      strategyId: query.strategyId,
      strategyVersionId: query.strategyVersionId,
      status: query.status,
      source: query.source,
      direction: query.direction,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    });
  }

  async getById(id: string): Promise<Setup> {
    const setup = await setupsRepository.getSetup(id);
    if (!setup) {
      throw new NotFoundException(`Setup ${id} not found`);
    }
    return setup;
  }

  async updateStatus(id: string, input: UpdateSetupStatusInput): Promise<Setup> {
    const setup = await setupsRepository.transitionSetupStatus(id, {
      status: input.status,
      decisionSummary: input.decisionSummary ?? null,
    });

    // Screenshot generation is best-effort and must never fail the status
    // transition it is a side effect of — see the milestone brief's
    // "When to generate PRE_TRADE screenshot": a READY setup should have a
    // PRE_TRADE screenshot or a queued generation record, but a screenshot
    // subsystem hiccup is never a reason to reject an otherwise-valid
    // WATCH/PREPARE/READY/REJECTED/INVALIDATED/EXPIRED transition.
    if (setup.status === "READY") {
      await this.screenshotService.requestPreTradeScreenshot(setup.id).catch((err: unknown) => {
        this.logger.warn(`Failed to request PRE_TRADE screenshot for Setup ${setup.id}: ${String(err)}`);
      });
    }

    return setup;
  }

  async getTimeline(id: string): Promise<JournalEvent[]> {
    // 404s first so a timeline request for a nonexistent setup never
    // silently returns an empty array indistinguishable from "no events yet".
    await this.getById(id);
    return journalEventsRepository.getSetupTimeline(id);
  }

  createRiskCalculation(id: string, input: CreateRiskCalculationInput): Promise<RiskCalculation> {
    return riskCalculationsRepository.createRiskCalculation(id, {
      accountEquity: new Decimal(input.accountEquity),
      riskPercentage: new Decimal(input.riskPercentage),
      slippageTicks: input.slippageTicks,
    });
  }

  listRiskCalculations(id: string): Promise<RiskCalculation[]> {
    return riskCalculationsRepository.listRiskCalculations(id);
  }

  async getLatestRiskCalculation(id: string): Promise<RiskCalculation> {
    const calculation = await riskCalculationsRepository.getLatestRiskCalculation(id);
    if (!calculation) {
      throw new NotFoundException(`No risk calculation exists for setup ${id}`);
    }
    return calculation;
  }
}
