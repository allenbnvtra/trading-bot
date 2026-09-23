# Research Methodology

This document governs how Trading Copilot is allowed to discover, validate, and approve trading strategies once research milestones begin (Milestone 6+). It exists to prevent the single most common failure mode in retail quant research: *"try thousands of combinations until one makes money."*

Milestone 1 does not do research — it validates infrastructure with one fixed, untuned strategy. This document describes the guardrails that must exist before AI is allowed to research and evaluate strategies.

## The pipeline

```
HISTORICAL DATA
      ↓
RESEARCH DATA
      ↓
VALIDATION DATA
      ↓
FINAL UNTOUCHED TEST
      ↓
WALK-FORWARD TESTING
      ↓
PAPER TRADING
      ↓
POSSIBLE APPROVAL
```

Each stage uses data or conditions the previous stage did not. A strategy only advances by passing the current stage on its own terms — not by being re-tuned until it passes.

## The final test dataset is not renewable

The final out-of-sample test dataset exists to answer one question honestly: *does this survive contact with data it has never influenced?* The moment a final-test result is used to change the strategy, that dataset stops being a final test — it has become another round of fitting. When that happens, a new, previously-unseen final-test period must be designated, and the fact that the original one was "spent" must be recorded, not hidden.

## Experiment tracking

Every research attempt is logged, whether it succeeded or failed: the hypothesis, the parameters tried, the dataset used, and the result. Failed experiments are never deleted or hidden — a strategy that "worked" after 500 undisclosed prior failures on the same data is not evidence of a real edge, it is evidence of multiple-comparisons bias. Track:

- experiment count
- tested hypotheses
- parameter variations
- pass/fail outcome per stage

## Sample size guardrails

Paper-trading and approval decisions require **both** a minimum calendar period **and** a minimum number of candidate setups — never one alone. Example starting guardrails (configurable, not mathematical guarantees):

- at least 60 calendar days, **and**
- at least 100 candidate setups

For historical intraday research, prefer multiple years of data where available, spanning more than one market regime. A strategy validated only on one trending year has not been validated against ranging, high-volatility, or low-volatility conditions.

## Overfitting and parameter mining

- Never trust a strategy that only works at one narrow, specific parameter value. Prefer stable, wide parameter regions over isolated performance peaks.
- Required robustness checks before a strategy can be considered for paper trading: performance by year, by month, by regime (trending/ranging/high-vol/low-vol), long vs. short, by session, by time of day, by day of week, and sensitivity to slippage, commissions, and parameter perturbation.

## Never do this

- Move directly from "one losing trade" to a live strategy-rule modification.
- Declare a strategy "profitable" or "validated." Describe evidence and its limitations instead — sample size, regime coverage, sensitivity, and what would falsify the hypothesis.
- Let repeated hypothesis testing on the same dataset go untracked.
- Let AI produce the authoritative P&L/risk numbers behind a research conclusion — those numbers come from `packages/backtester` and `packages/risk-engine`, deterministically. AI may summarize and hypothesize; it does not calculate.

## Winner/loser comparison discipline

A condition that is common among losing trades is not automatically a *cause* of losses — it may be equally common among winners, or common in the underlying population of all setups. Before concluding anything, compare condition prevalence and outcome quality across **losers, winners, and all trades** (see `docs/trade-journal-design.md`). Report sample sizes alongside every comparison.

## Strategy lifecycle

```
DISCOVERED → BACKTESTING → VALIDATION → OUT_OF_SAMPLE → WALK_FORWARD → PAPER_CANDIDATE → PAPER_TRADING → APPROVED
                                                                              ↓
                                                                    PAUSED / RETIRED
```

A strategy change is always a new `StrategyVersion`. An approved historical version is never silently altered.

**`PAPER_CANDIDATE`** (added in Milestone 7) sits between `WALK_FORWARD` and `PAPER_TRADING`. Every status through `WALK_FORWARD` can be reached automatically as a hypothesis's experiments complete; `PAPER_CANDIDATE` cannot: it requires an explicit, human-confirmed HTTP request (`confirmedByHuman: true`) and re-checks the sample-size guardrails above over the combined `FINAL_TEST`+`WALK_FORWARD` window. Nothing in this codebase can move a `StrategyVersion` past `WALK_FORWARD` without that human action, and nothing moves it past `PAPER_CANDIDATE` at all yet: `PAPER_TRADING`/`APPROVED` require paper-trading execution and monitoring infrastructure this milestone does not build. See `docs/ai-research.md` for the exact dataset-role pipeline (`RESEARCH → VALIDATION → FINAL_TEST → WALK_FORWARD`) and the final-test reuse safeguard's mechanism.

## How the Milestone 7 experiment pipeline enforces this

- **Execution.** `POST /research/hypotheses/:id/experiments` creates the experiment and its `Backtest` in one transaction, then enqueues the backtest onto the same `backtest-run` queue and `BacktestRunProcessor` as `POST /backtests`. The experiment moves `QUEUED → RUNNING → COMPLETED | FAILED` with its backtest. Every transition is an atomic conditional update, and each terminal one writes a `RESEARCH_EXPERIMENT_COMPLETED` or `RESEARCH_EXPERIMENT_FAILED` journal event.
- **Stage order.** A stage (`RESEARCH → VALIDATION → FINAL_TEST → WALK_FORWARD`) requires a COMPLETED experiment at the prior stage.
- **Window isolation.** From `VALIDATION` onward, a stage's window must start at or after the latest window end of every non-FAILED experiment for the same hypothesis.
- **Holdout.** `FINAL_TEST` and `WALK_FORWARD` windows must start at or after the hypothesis's `sourceDataSummary.sampleWindowEnd`, the last journal trade the hypothesis was generated from.
- **Final test is not renewable.** At most one non-FAILED `FINAL_TEST` per hypothesis (a partial unique index on `status <> 'FAILED'`). A COMPLETED experiment can never be relabeled FAILED, so a spent final test stays spent.
- **History is kept.** Deleting a hypothesis or backtest that an experiment references is refused (`ON DELETE RESTRICT`). FAILED experiments are never deleted.
- **Lifecycle.** A completed experiment advances its `StrategyVersion` forward only: `RESEARCH → BACKTESTING`, `VALIDATION → VALIDATION`, `FINAL_TEST → OUT_OF_SAMPLE`, `WALK_FORWARD → WALK_FORWARD`. It never moves a version backward and never past `WALK_FORWARD`. `PAPER_CANDIDATE` is a separate, human-confirmed action.

Known limitations: advancement is completion-based, not outcome-based (a COMPLETED experiment means the backtest ran, not that the strategy passed); the sample-size guardrail counts system-wide journal trades, not the experiment's own backtest trades; and the stage checks are application-level reads, so two simultaneous create requests for the same hypothesis could both pass the window check (the final-test rule alone is a database constraint).

## Counterfactual analysis

Future counterfactual questions ("would a wider stop have mattered?", "would waiting for candle close have mattered?") are research artifacts. They are always clearly labeled hypothetical/simulated and are never mixed with actual trade outcomes in reporting.
