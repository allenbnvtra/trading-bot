/**
 * Every field here is a pre-formatted display string (or null for "not
 * available"), never a Decimal/number — see this file's own absence of any
 * decimal.js import, which is deliberate and load-bearing: it is what
 * makes "the formatting layer must not calculate financial values"
 * enforced by the type system/module graph, not just a review convention.
 * The caller (notification-send.processor.ts) is responsible for every
 * unit of arithmetic, sourced from packages/risk-engine and the
 * already-persisted Setup/RiskCalculation rows.
 */

import type { NotificationType, SetupStatus } from "@trading-copilot/shared-types";

export interface ReadyTradeCardData {
  instrumentSymbol: string;
  direction: "LONG" | "SHORT";
  strategyName: string;
  strategyVersion: string;
  timeframe: string;
  entry: string;
  stop: string | null;
  target1: string | null;
  target2: string | null;
  stopDistancePoints: string | null;
  riskAmount: string | null;
  quantity: string | null;
  riskReward: string | null;
  expiresAt: string | null;
  status: string;
}

const NOT_AVAILABLE = "NOT AVAILABLE";
const UNKNOWN = "UNKNOWN";

function optionalField(value: string | null, whenMissing: string): string {
  return value ?? whenMissing;
}

export function formatReadyTradeCard(data: ReadyTradeCardData): string {
  const lines = [
    "🟢 TRADE READY",
    "",
    `Instrument: ${data.instrumentSymbol}`,
    `Direction: ${data.direction}`,
    `Strategy: ${data.strategyName} v${data.strategyVersion}`,
    `Timeframe: ${data.timeframe}`,
    `Entry: ${data.entry}`,
    `Stop: ${optionalField(data.stop, NOT_AVAILABLE)}`,
    `Target 1: ${optionalField(data.target1, NOT_AVAILABLE)}`,
    `Target 2: ${optionalField(data.target2, NOT_AVAILABLE)}`,
    `Stop Distance: ${optionalField(data.stopDistancePoints, NOT_AVAILABLE)}`,
    `Risk: ${optionalField(data.riskAmount, UNKNOWN)}`,
    `Quantity: ${optionalField(data.quantity, UNKNOWN)}`,
    `Risk : Reward: ${optionalField(data.riskReward, UNKNOWN)}`,
    `Expires: ${optionalField(data.expiresAt, NOT_AVAILABLE)}`,
    `Status: ${data.status}`,
  ];
  return lines.join("\n");
}

/**
 * The non-READY setup lifecycle notice: a small text-only notification for
 * PREPARE/INVALIDATED/EXPIRED/REJECTED transitions, as opposed to
 * formatReadyTradeCard's full trade card for SETUP_READY. SETUP_READY is
 * deliberately excluded from SetupStatusNoticeNotificationType — that
 * event always goes through formatReadyTradeCard instead.
 *
 * Like ReadyTradeCardData, every field is a plain string/enum the caller
 * already resolved from the persisted Setup row — nothing here is
 * calculated, and nothing here is a Decimal.
 */
export type SetupStatusNoticeNotificationType = Exclude<NotificationType, "SETUP_READY">;

export interface SetupStatusNoticeData {
  setupId: string;
  notificationType: SetupStatusNoticeNotificationType;
  instrumentSymbol: string;
  strategyName: string;
  strategyVersion: string;
  status: SetupStatus;
}

const SETUP_STATUS_NOTICE_EMOJI: Record<SetupStatusNoticeNotificationType, string> = {
  SETUP_PREPARE: "🟡",
  SETUP_INVALIDATED: "⚪",
  SETUP_EXPIRED: "⚫",
  SETUP_REJECTED: "🔴",
};

export function formatSetupStatusNotice(data: SetupStatusNoticeData): string {
  const emoji = SETUP_STATUS_NOTICE_EMOJI[data.notificationType];
  const lines = [
    `${emoji} SETUP ${data.status}`,
    "",
    `${data.instrumentSymbol} — ${data.strategyName} v${data.strategyVersion}`,
    `Setup ID: ${data.setupId}`,
  ];
  return lines.join("\n");
}
