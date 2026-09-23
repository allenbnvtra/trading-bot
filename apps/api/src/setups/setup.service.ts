import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import {
  journalEventsRepository,
  journalTradesRepository,
  notificationDeliveriesRepository,
  riskCalculationsRepository,
  setupsRepository,
} from "@trading-copilot/database";
import type {
  CreateRiskCalculationInput,
  CreateSetupInput,
  ExecuteSetupInput,
  SetupListQuery,
  SkipSetupInput,
  UpdateSetupStatusInput,
} from "@trading-copilot/shared-types";
import type {
  JournalEvent,
  JournalTrade,
  NotificationDelivery,
  RiskCalculation,
  Setup,
} from "@trading-copilot/trading-domain";
import { NotificationService } from "../notifications/notification.service";
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

  constructor(
    private readonly screenshotService: ScreenshotService,
    private readonly notificationService: NotificationService,
  ) {}

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

    await this.notifyForStatus(setup).catch((err: unknown) => {
      this.logger.warn(`Failed to request notification for Setup ${setup.id} (${setup.status}): ${String(err)}`);
    });

    return setup;
  }

  /**
   * Notification policy (docs/notifications.md "Notification policy"):
   * WATCH never notifies (dashboard-only, avoids alert spam on the noisiest
   * state). PREPARE notifies only when NOTIFICATION_PREPARE_ENABLED=true
   * (default off, since PREPARE is a much noisier state than READY and the
   * brief's own stated goal for WATCH — "avoid notification spam" — applies
   * here too; an operator opts in explicitly). READY always notifies.
   * INVALIDATED/EXPIRED/REJECTED notify only if a PREPARE or READY
   * notification was already SENT for this setup — an invalidation the
   * human was never told about in the first place needs no "never mind"
   * message.
   */
  private async notifyForStatus(setup: Setup): Promise<void> {
    if (setup.status === "PREPARE") {
      if (process.env.NOTIFICATION_PREPARE_ENABLED === "true") {
        await this.notificationService.requestNotification(setup.id, "SETUP_PREPARE");
      }
      return;
    }
    if (setup.status === "READY") {
      await this.notificationService.requestNotification(setup.id, "SETUP_READY");
      return;
    }
    if (setup.status === "INVALIDATED" || setup.status === "EXPIRED" || setup.status === "REJECTED") {
      const priorNotification = await notificationDeliveriesRepository.findMostRecentSentNotification(setup.id, [
        "SETUP_PREPARE",
        "SETUP_READY",
      ]);
      if (priorNotification) {
        const notificationType =
          setup.status === "INVALIDATED"
            ? "SETUP_INVALIDATED"
            : setup.status === "EXPIRED"
              ? "SETUP_EXPIRED"
              : "SETUP_REJECTED";
        await this.notificationService.requestNotification(setup.id, notificationType);
      }
    }
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

  /**
   * Mirrors listRiskCalculations above exactly: a thin passthrough to the
   * repository, no existence check on the setup id first (a nonexistent
   * setup simply returns an empty array, same as listRiskCalculations does).
   * The dashboard's Setup detail page (Task 12) is the only caller.
   */
  listNotifications(id: string): Promise<NotificationDelivery[]> {
    return notificationDeliveriesRepository.listNotificationsForSetup(id);
  }

  /**
   * The dashboard's single-action "PAPER TRADE" / "I ENTERED THIS TRADE"
   * button: creates and records an OPEN JournalTrade atomically, sourced
   * from the Setup's own planned values — never re-supplied by the caller,
   * so what gets journaled always matches what was actually approved.
   *
   * plannedStop fallback: `transitionSetupStatus`
   * (packages/database/src/repositories/setups.ts) enforces only the
   * WATCH/PREPARE/READY/... state-machine matrix (ALLOWED_TRANSITIONS) — it
   * has no precondition requiring plannedStop/plannedTarget1 to be non-null
   * before a Setup can reach READY. A TradingView-sourced Setup (Milestone
   * 3) can therefore be READY with only a candidate entry known (see
   * CreateSetupInput's own doc comment on plannedStop in setups.ts). Since
   * JournalTrade.plannedStop is a required column, falling back to
   * plannedEntry is real behavior here, not dead code — confirmed by
   * reading transitionSetupStatus before writing this, per this task's
   * brief. If a stricter precondition is added to the READY transition
   * later, this fallback becomes unreachable and should be deleted then.
   */
  async execute(setupId: string, input: ExecuteSetupInput): Promise<JournalTrade> {
    const setup = await this.getById(setupId);
    if (setup.status !== "READY") {
      throw new ConflictException(`Setup ${setupId} is not READY — cannot record an execution against it`);
    }

    // Idempotency guard against a double-submit (double-click, a retried
    // HTTP request) against the same READY setup: the Setup's own status is
    // deliberately never transitioned away from READY by execute() (that
    // lifecycle stays orthogonal to "has a trade been recorded" — see this
    // method's doc comment and skip()'s matching behavior), and
    // JournalTrade.setupId has no unique constraint, so without this check a
    // second call would silently create a second, independent OPEN
    // JournalTrade for the same setup.
    const existingOpenTrade = await journalTradesRepository.findOpenJournalTradeBySetupId(setupId);
    if (existingOpenTrade) {
      throw new ConflictException(`Setup ${setupId} already has an OPEN JournalTrade — cannot execute it again`);
    }

    // estimatedTotalRisk (riskPerUnit * calculatedQuantity), not riskBudget
    // (the theoretical account-level allocation e.g. 1% of equity): the
    // former is the actual computed dollar risk for the sized position,
    // which is what rMultiple needs at close time to normalize netPnl. The
    // latest calculation is best-effort — a READY setup with no
    // RiskCalculation on file still executes, just without a real rMultiple
    // baseline (see computeJournalTradeClose's "never fabricated as 0" note).
    const latestRiskCalculation = await riskCalculationsRepository.getLatestRiskCalculation(setupId);
    const plannedRisk = latestRiskCalculation ? new Decimal(latestRiskCalculation.estimatedTotalRisk.toString()) : null;

    return journalTradesRepository.createAndRecordJournalTradeEntry({
      setupId: setup.id,
      instrumentId: setup.instrumentId,
      strategyId: setup.strategyId,
      strategyVersionId: setup.strategyVersionId,
      direction: setup.direction,
      plannedEntry: setup.plannedEntry,
      plannedStop: setup.plannedStop ?? setup.plannedEntry,
      plannedTarget1: setup.plannedTarget1,
      plannedTarget2: setup.plannedTarget2,
      plannedRisk,
      executionMode: input.executionMode,
      actualEntry: new Decimal(input.actualEntry),
      quantity: input.quantity,
      entryTimestamp: new Date(input.entryTimestamp),
      actualFees: input.actualFees ? new Decimal(input.actualFees) : null,
      actualSlippage: input.actualSlippage ? new Decimal(input.actualSlippage) : null,
      notes: input.notes ?? null,
    });
  }

  /**
   * Records a deliberate "did not take this trade" decision. This is about
   * the trade decision, not the Setup's own lifecycle — a skipped READY
   * setup is left exactly as it was and can still separately
   * expire/invalidate on its own terms via updateStatus.
   */
  async skip(setupId: string, input: SkipSetupInput): Promise<JournalTrade> {
    const setup = await this.getById(setupId);
    return journalTradesRepository.createJournalTrade({
      setupId: setup.id,
      instrumentId: setup.instrumentId,
      strategyId: setup.strategyId,
      strategyVersionId: setup.strategyVersionId,
      direction: setup.direction,
      plannedEntry: setup.plannedEntry,
      plannedStop: setup.plannedStop ?? setup.plannedEntry,
      plannedTarget1: setup.plannedTarget1,
      plannedTarget2: setup.plannedTarget2,
      plannedRisk: null,
      executionMode: "SKIPPED",
      skipReason: input.reason ?? null,
      entryNotes: null,
    });
  }
}
