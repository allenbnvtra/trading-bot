import { Decimal } from "decimal.js";
import {
  calculatePositionSize,
  calculateRiskBudget,
  calculateRiskPerContract,
  calculateRiskReward,
  calculateStopDistancePoints,
  calculateStopDistanceTicks,
} from "@trading-copilot/risk-engine";
import type { RiskCalculation } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { NotFoundError } from "../errors";
import { mapRiskCalculation } from "../mappers";
import { createJournalEvent } from "./journal-events";

/**
 * All numeric values are produced by calling straight into
 * packages/risk-engine — this module never reimplements the math itself
 * (see CLAUDE.md "financial calculations are never independently produced
 * in a controller"). Immutable once created: no update function exists.
 */

export interface CreateRiskCalculationInput {
  accountEquity: Decimal;
  riskPercentage: Decimal;
  slippageTicks: number;
}

export interface RiskCalculationInstrumentContext {
  tickSize: Decimal;
  pointValue: Decimal;
  tickValue: Decimal;
  commissionPerContract: Decimal;
}

export interface ComputedRiskCalculation {
  entryPrice: Decimal;
  stopPrice: Decimal;
  stopDistancePoints: Decimal;
  stopDistanceTicks: Decimal;
  riskBudget: Decimal;
  estimatedSlippage: Decimal;
  estimatedCommission: Decimal;
  riskPerUnit: Decimal;
  calculatedQuantity: number;
  estimatedTotalRisk: Decimal;
  riskReward: Decimal;
}

/**
 * Pure computation, calling only packages/risk-engine functions — extracted
 * from createRiskCalculation so the numeric pipeline is unit-testable
 * without a database (see src/repositories/risk-calculations.test.ts).
 * createRiskCalculation below is the only place this feeds into a
 * persisted, immutable RiskCalculation row.
 */
export function computeRiskCalculation(
  entryPrice: Decimal,
  stopPrice: Decimal,
  target: Decimal,
  instrument: RiskCalculationInstrumentContext,
  input: CreateRiskCalculationInput,
): ComputedRiskCalculation {
  const stopDistancePoints = calculateStopDistancePoints(entryPrice, stopPrice);
  const stopDistanceTicks = calculateStopDistanceTicks(stopDistancePoints, instrument.tickSize);
  const riskBudget = calculateRiskBudget(input.accountEquity, input.riskPercentage);

  // Per-contract dollar cost of slippage — same formula packages/backtester
  // uses (ticks * tickSize gives a price distance, times pointValue gives
  // the dollar cost of that distance for one contract).
  const estimatedSlippage = new Decimal(input.slippageTicks)
    .times(instrument.tickSize)
    .times(instrument.pointValue);
  const estimatedCommission = instrument.commissionPerContract;

  const riskPerUnit = calculateRiskPerContract(
    stopDistancePoints,
    instrument.pointValue,
    estimatedCommission,
    estimatedSlippage,
  );
  const calculatedQuantity = calculatePositionSize(riskBudget, riskPerUnit);
  // Decimal(0) when calculatedQuantity is 0 — 0 is a valid outcome, not an
  // error, and is still persisted (see packages/risk-engine's
  // calculatePositionSize doc comment).
  const estimatedTotalRisk = riskPerUnit.times(calculatedQuantity);
  const riskReward = calculateRiskReward(entryPrice, stopPrice, target);

  return {
    entryPrice,
    stopPrice,
    stopDistancePoints,
    stopDistanceTicks,
    riskBudget,
    estimatedSlippage,
    estimatedCommission,
    riskPerUnit,
    calculatedQuantity,
    estimatedTotalRisk,
    riskReward,
  };
}

export async function createRiskCalculation(
  setupId: string,
  input: CreateRiskCalculationInput,
): Promise<RiskCalculation> {
  const setup = await prisma.setup.findUnique({ where: { id: setupId } });
  if (!setup) {
    throw new NotFoundError("Setup", setupId);
  }

  const instrument = await prisma.instrument.findUnique({ where: { id: setup.instrumentId } });
  if (!instrument) {
    throw new NotFoundError("Instrument", setup.instrumentId);
  }

  const entryPrice = new Decimal(setup.plannedEntry.toString());
  const stopPrice = new Decimal(setup.plannedStop.toString());
  const target = new Decimal(setup.plannedTarget1.toString());
  const tickSize = new Decimal(instrument.tickSize.toString());
  const pointValue = new Decimal(instrument.pointValue.toString());
  const tickValue = new Decimal(instrument.tickValue.toString());
  const commissionPerContract = new Decimal(instrument.commissionPerContract.toString());

  const computed = computeRiskCalculation(entryPrice, stopPrice, target, {
    tickSize,
    pointValue,
    tickValue,
    commissionPerContract,
  }, input);

  return prisma.$transaction(async (tx) => {
    const row = await tx.riskCalculation.create({
      data: {
        setupId,
        accountEquity: input.accountEquity.toString(),
        riskPercentage: input.riskPercentage.toString(),
        riskBudget: computed.riskBudget.toString(),
        entryPrice: entryPrice.toString(),
        stopPrice: stopPrice.toString(),
        stopDistancePoints: computed.stopDistancePoints.toString(),
        stopDistanceTicks: computed.stopDistanceTicks.toString(),
        pointValue: pointValue.toString(),
        tickValue: tickValue.toString(),
        estimatedCommission: computed.estimatedCommission.toString(),
        estimatedSlippage: computed.estimatedSlippage.toString(),
        riskPerUnit: computed.riskPerUnit.toString(),
        calculatedQuantity: computed.calculatedQuantity,
        estimatedTotalRisk: computed.estimatedTotalRisk.toString(),
        riskReward: computed.riskReward.toString(),
      },
    });

    await createJournalEvent(
      {
        eventType: "RISK_CALCULATED",
        entityType: "RISK_CALCULATION",
        entityId: row.id,
        correlationId: setupId,
        instrumentId: setup.instrumentId,
        strategyId: setup.strategyId,
        strategyVersionId: setup.strategyVersionId,
      },
      tx,
    );

    return mapRiskCalculation(row);
  });
}

export async function listRiskCalculations(setupId: string): Promise<RiskCalculation[]> {
  const rows = await prisma.riskCalculation.findMany({
    where: { setupId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapRiskCalculation);
}

export async function getLatestRiskCalculation(setupId: string): Promise<RiskCalculation | null> {
  const row = await prisma.riskCalculation.findFirst({
    where: { setupId },
    orderBy: { createdAt: "desc" },
  });
  return row ? mapRiskCalculation(row) : null;
}
