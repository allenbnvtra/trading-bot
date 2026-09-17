# TradingView webhook fixtures

**SYNTHETIC TEST DATA — NOT REAL MARKET DATA.** These are hand-built example payloads for exercising `POST /webhooks/tradingview` locally, without needing a real TradingView account or a publicly reachable server. See `docs/tradingview-setup.md` for the full manual test procedure and `docs/tradingview-security.md` for production hardening.

All fixtures assume the seeded development data from `pnpm db:seed`: the `ema-trend-pullback` v1.0.0 strategy, the `GENFUT1`/`SIM-FUT` futures instrument, and a `TradingViewInstrumentMapping` from `CME`/`NQ1!` to that instrument.

| File | Purpose | Expected result |
|---|---|---|
| `valid-long.json` | A well-formed LONG `SETUP_CANDIDATE` signal | `202`, event `PROCESSED`, one `Setup` created (`WATCH`, `LONG`) |
| `valid-short.json` | A well-formed SHORT `SETUP_CANDIDATE` signal, different bar | `202`, event `PROCESSED`, one `Setup` created (`WATCH`, `SHORT`) |
| `duplicate.json` | Byte-identical to `valid-long.json` | POST it *after* `valid-long.json` and no second `Setup` is created — the fingerprint matches an already-received event |
| `unknown-instrument.json` | `NYMEX`/`CL1!`, which has no `TradingViewInstrumentMapping` | Event stored, `processingStatus: REJECTED`, `failureCode: UNKNOWN_INSTRUMENT`, no `Setup` created |
| `unknown-strategy.json` | A `strategyKey`/`strategyVersion` pair with no matching `StrategyVersion` row | Event stored, `processingStatus: REJECTED`, `failureCode: UNKNOWN_STRATEGY_VERSION`, no `Setup` created |
| `malformed.json` | Invalid `direction`, non-ISO `barTime`, scientific-notation and non-numeric prices, negative volume | `400` synchronously — rejected before it's even queued |
| `unsupported-schema.json` | `schemaVersion: 2` (not yet supported) | Event stored, `processingStatus: UNSUPPORTED` — never crashes the server |

## Usage

```bash
curl -i -X POST http://localhost:3001/webhooks/tradingview \
  -H "Content-Type: application/json" \
  --data @fixtures/tradingview/valid-long.json
```

Repeat with `duplicate.json` and confirm no second `Setup` was created:

```bash
curl -s http://localhost:3001/setups | jq 'length'
```
