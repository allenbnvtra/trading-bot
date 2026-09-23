import type { ScreenshotType, TradeSource } from "@trading-copilot/shared-types";
import type { TradeScreenshot } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapTradeScreenshot } from "../mappers";

/**
 * Metadata only — the image itself lives in object storage (see
 * docs/screenshot-design.md). No image-handling logic belongs here.
 */

export interface CreateTradeScreenshotInput {
  setupId?: string | null;
  tradeId?: string | null;
  tradeSource?: TradeSource | null;
  type: ScreenshotType;
  storageKey: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  marketSnapshotId?: string | null;
  chartConfigVersion: string;
}

export async function createTradeScreenshot(
  input: CreateTradeScreenshotInput,
): Promise<TradeScreenshot> {
  const row = await prisma.tradeScreenshot.create({
    data: {
      setupId: input.setupId ?? null,
      tradeId: input.tradeId ?? null,
      tradeSource: input.tradeSource ?? null,
      type: input.type,
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      width: input.width ?? null,
      height: input.height ?? null,
      marketSnapshotId: input.marketSnapshotId ?? null,
      chartConfigVersion: input.chartConfigVersion,
    },
  });
  return mapTradeScreenshot(row);
}

export async function getTradeScreenshot(id: string): Promise<TradeScreenshot | null> {
  const row = await prisma.tradeScreenshot.findUnique({ where: { id } });
  return row ? mapTradeScreenshot(row) : null;
}

export interface TradeScreenshotFilters {
  setupId?: string;
  tradeId?: string;
  tradeSource?: TradeSource;
  type?: ScreenshotType;
}

export async function listTradeScreenshots(
  filters: TradeScreenshotFilters = {},
): Promise<TradeScreenshot[]> {
  const rows = await prisma.tradeScreenshot.findMany({
    where: {
      setupId: filters.setupId,
      tradeId: filters.tradeId,
      tradeSource: filters.tradeSource,
      type: filters.type,
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapTradeScreenshot);
}
