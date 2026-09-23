import { z } from "zod";
import { SKIP_REASONS } from "./enums";

export const NOTIFICATION_QUEUE = "notification-delivery";
export const SEND_NOTIFICATION_JOB = "send-notification";

/** Bumped whenever the READY trade-card's format changes in a way that
 * should not silently rewrite delivery history — mirrors
 * CHART_CONFIG_VERSION's role for screenshots. */
export const NOTIFICATION_TEMPLATE_VERSION = "1.0.0";

/** How long the notification worker waits for a PRE_TRADE screenshot to
 * reach READY before sending a text-only READY notification. See
 * docs/notifications.md "Screenshot attachment". */
export const NOTIFICATION_SCREENSHOT_WAIT_MS = 8_000;
export const NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS = 500;

const positiveDecimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^(?!0(?:\.0+)?$)\d+(\.\d+)?$/, `${label} must be a positive decimal string (not zero)`);

const nonNegativeDecimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${label} must be a non-negative decimal string`);

/**
 * The single-action "record what I actually did" endpoint backing the
 * dashboard's PAPER TRADE / I ENTERED THIS TRADE buttons: creates a
 * JournalTrade AND records its entry atomically (see
 * createAndRecordJournalTradeEntry in journal-trades.ts), so the dashboard
 * never has to sequence two API calls for one human action. executionMode
 * is deliberately restricted to PAPER|MANUAL_LIVE — BACKTEST is never
 * created through this path (see createJournalTradeSchema's own comment)
 * and SKIPPED goes through skipSetupSchema/POST /setups/:id/skip instead.
 */
export const executeSetupSchema = z.object({
  executionMode: z.enum(["PAPER", "MANUAL_LIVE"]),
  actualEntry: positiveDecimalString("actualEntry"),
  quantity: z.number().int().positive(),
  entryTimestamp: z.string().datetime(),
  actualFees: nonNegativeDecimalString("actualFees").optional(),
  actualSlippage: nonNegativeDecimalString("actualSlippage").optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type ExecuteSetupInput = z.infer<typeof executeSetupSchema>;

export const skipSetupSchema = z.object({
  reason: z.enum(SKIP_REASONS).optional(),
});
export type SkipSetupInput = z.infer<typeof skipSetupSchema>;

export const notificationListQuerySchema = z.object({
  setupId: z.string().uuid().optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
