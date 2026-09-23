# Backtesting Assumptions

This document exists because backtests are only useful if their assumptions are explicit. Every assumption below is deliberately conservative under ambiguity — when OHLC data cannot tell us what actually happened intrabar, we assume the worse outcome for the trade rather than the better one.

These assumptions are implemented in `packages/backtester/src/engine.ts`. If the code and this document ever disagree, the code is what actually ran — treat that as a bug in this document (or in the code) to be fixed, not as acceptable drift.

## Look-ahead bias prevention

A strategy signal is evaluated using only `candles[0..i]`: it never sees candle `i+1` or later. `packages/strategy-engine`'s `evaluateEmaTrendPullback` and `evaluateStrategyDefinition` (the DSL interpreter) are both look-ahead-safe by construction: each is a pure function over a prefix of the candle array.

## Entry timing

A signal detected using candle `i`'s close cannot be filled at candle `i`'s close price — that price was only just formed and is not tradeable information "during" that candle. Entry fills at candle `i+1`'s **open**. If candle `i` is the last candle in the series, the signal is dropped (there is nothing to enter at).

## Stop and target derivation

Stop and target distances are derived from ATR **as of the signal candle** (`atrAtSignal`), not the entry candle — this is the volatility that was known at decision time. Because entry price is next-bar open rather than the signal candle's close, realized risk can differ slightly from the plan; this is intentional and is not "corrected" by re-deriving the stop from the entry price.

- LONG: `stopPrice = entryPrice - (atrAtSignal * stopAtrMultiplier)`, `targetPrice = entryPrice + (atrAtSignal * targetAtrMultiplier)`
- SHORT: mirrored

## Same-candle stop and target ("the ambiguous candle")

OHLC data cannot tell us whether price touched the stop or the target first within a single candle. When one candle's range contains both:

**Rule: assume the stop was hit first.** The trade is recorded with `exitReason = SAME_CANDLE_STOP_AND_TARGET` and `exitPrice = stopPrice`. This is the conservative assumption — it never lets an ambiguous candle look better than it might have been.

## Gaps

If price gaps through the stop or target (e.g. the entry candle's open is already beyond the target), the engine still fills at the documented open/stop/target price, not at the more extreme intrabar price. This under-states favorable gaps and over-states adverse ones — again, conservative.

## Slippage

Slippage is applied **adversely only**, in ticks, on both entry and exit fills:

- LONG entry: fill price = `open + slippageTicks * tickSize` (worse, i.e. higher)
- SHORT entry: fill price = `open - slippageTicks * tickSize` (worse, i.e. lower)
- Stop/target exits: fill price is worsened by the same `slippageTicks * tickSize` beyond the stop/target level
- `END_OF_DATA` closes (see below) do not have slippage applied — they are an artificial backtest-completion close, not a real fill

## Commissions

`fees = commissionPerContract * quantity * 2` — a full round turn (entry + exit) per contract, from `Instrument.commissionPerContract`.

## Position sizing

Position size is computed by `packages/risk-engine` from `initialBalance`, `riskPercentage`, the planned stop distance, `Instrument.pointValue`, commission, and estimated slippage cost. If the computed size floors to zero contracts (the account can't afford even one contract at the configured risk), the signal is **skipped** — no trade is recorded, and the skip is counted in `skippedSignalCount` for transparency. This is not currently persisted as a journal event (that is a Milestone 2 concept — see `docs/trade-journal-design.md`).

## One position at a time

For Milestone 1, at most one open position per strategy/instrument backtest run. New signals are ignored while a position is open.

## Missing candles / session boundaries

The backtester requires strictly increasing, non-duplicate timestamps in its input candle series and throws a clear error otherwise — it does not attempt to interpolate or infer missing bars. Session-boundary-aware execution (e.g. not entering into an illiquid overnight session) is not yet implemented; all candles in the provided series are treated as equally tradeable in Milestone 1.

## End of data

If a position is still open when the candle series ends, it is closed at the final candle's close price, `exitReason = END_OF_DATA`. This is an artificial closure for backtest completeness, not a real market event.

## R multiple

`rMultiple = netPnl / riskAmount`, where `riskAmount` is the actual dollar risk taken (`riskPerContract * quantity` from the sizing calculation), not the theoretical ATR-based risk before sizing rounding.

## Determinism

`runBacktest` is a pure function of its inputs: no wall-clock reads, no random number generation, no dependence on object iteration order beyond the input candle array's order. Running it twice on identical input produces byte-identical output — this is asserted by an explicit test in `packages/backtester`.

## What this does *not* claim

None of the above makes a strategy profitable or validated. It only makes the simulation's rules explicit and reproducible. See `docs/research-methodology.md` for what would actually be required before trusting a strategy's results.
