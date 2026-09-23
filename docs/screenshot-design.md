# Trade Chart Screenshot Design (Future — Milestone 5+)

Screenshots are part of the future trade journal. Milestone 1 does not implement this; this document records the intended design so later work builds on stored data rather than a dependency on TradingView.

## Why not just screenshot TradingView

Screenshotting a third-party platform is fragile (layout changes, auth walls, rate limits) and couples the journal to a UI we don't control. Instead:

```
PostgreSQL candles
      ↓
internal chart renderer (Next.js + a lightweight charting library, e.g. TradingView Lightweight Charts)
      ↓
annotated chart (entry zone, stop, target(s), support/resistance, VWAP, setup timestamp/status)
      ↓
Playwright screenshot
      ↓
PNG
      ↓
object storage
      ↓
journal / dashboard / notification
```

## Screenshot types

- **PRE_TRADE** — instrument, timeframe, strategy/version, recent candles, entry zone, stop, target(s), support/resistance, VWAP, setup timestamp, setup status. Captured at decision time and **never overwritten** after the trade closes — it is part of the pre-trade record.
- **POST_TRADE** — everything in PRE_TRADE plus actual entry, actual exit, MFE, MAE, result in R, winner/loss classification. A separate image, separate row.

## Storage

- Local development: local disk under a `storage/screenshots/` path (already gitignored).
- Production: S3-compatible object storage.
- The database stores metadata only, never the image blob: `id`, `tradeId`/`setupId`, `type`, `createdAt`, `marketSnapshotId`, `storageKey`, `mimeType`, `width`/`height`, `chartConfigVersion`.

## AI and screenshots

Future AI agents may receive a structured market snapshot **plus** the chart image for visual context. Structured data remains authoritative for any precise value. Computer vision is never asked to estimate exact risk, ticks, contract count, or P&L from pixels — those come from `packages/risk-engine` and `packages/backtester`, deterministically.

## Out of scope for Milestone 1

No chart renderer, no Playwright integration, no screenshot storage exists yet. Do not let this derail Milestone 1's vertical slice (candles → strategy → backtest → dashboard trade inspection), which currently renders trade context as tabular surrounding-candle data, not a chart image.

## Known limitations

- **A row stuck at `GENERATING` has no automatic recovery path.** `ScreenshotService.requestPreTradeScreenshot`/`requestPostTradeScreenshot` (`apps/api/src/screenshots/screenshot.service.ts`) re-attempt `screenshotQueue.add(..., { jobId: screenshot.id })` whenever `tradeScreenshotsRepository.requestOrRetryScreenshot` reports a row still at `REQUESTED` — including one that was already `alreadyInFlight` — so a row left `REQUESTED` with no job behind it (e.g. Redis was down at the moment of the original enqueue, right after the row was created) self-heals on the next automatic retrigger or manual re-request call, the same jobId-dedup trick used by `apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts`. This deliberately does **not** cover a row stuck at `GENERATING` (for example, the worker process crashed mid-render after calling `markScreenshotGenerating` but before `markScreenshotReady`/`markScreenshotFailed`) — recovering that case would require a real periodic reconciliation sweep (job-state-aware, not a blind re-`add()`, per the same reasoning `webhook-reconciliation.processor.ts` documents), which is out of scope for now. A `GENERATING` row currently requires manual intervention (e.g. a direct DB fix) to unstick.
