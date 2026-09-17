# TradingView Webhook Security

`POST /webhooks/tradingview` is a public HTTP endpoint by necessity: TradingView's servers must be able to reach it. This document covers what's safe to put in an alert message, and the production controls this project expects to sit in front of the endpoint. It is written to be configurable between **local development** (no controls, trusted network) and **production** (all of the below).

## Never put credentials in a webhook alert message

TradingView alert messages are plain text, are stored by TradingView, and (in this project) are persisted verbatim into `InboundWebhookEvent.rawPayload` for audit. **Never** include, in an alert message or anywhere in its `metadata`:

- broker account passwords or API keys
- TradingView account credentials
- exchange/broker API credentials of any kind
- account numbers or anything else that grants access to money

There is no legitimate reason a `SETUP_CANDIDATE` signal needs any of these: the payload only ever describes a market observation (instrument, direction, price/volume context), never an account or an order. If a future milestone needs to authenticate the *source* of a webhook, that is a shared secret configured out-of-band (see "Optional shared-secret validation" below), never something embedded in the alert body itself.

## What this project logs

`InboundWebhookEvent.rawPayload` stores the payload as received, since the payload is not expected to ever contain a secret (see above) and the whole point of Milestone 3 is auditability: every field TradingView sent is available for later inspection via `GET /webhooks/tradingview/events/:id`. Application logs (stdout/structured logs) deliberately avoid dumping the full raw body on every request (see "Observability" in `docs/tradingview-setup.md`'s sibling implementation notes) to keep log volume sane and avoid a second, less-controlled copy of the same data. The durable, queryable copy is the database row, not the log stream.

## Production controls

None of these are implemented in application code (a personal research tool doesn't need to reinvent a WAF), and none are strictly required for local development. They are configuration for wherever this is actually deployed (see `docs/roadmap.md` Milestone 12, "24/7 deployment and monitoring").

- **HTTPS only.** TradingView requires HTTPS for webhook URLs in production regardless; terminate TLS at the reverse proxy (nginx/Caddy/Traefik), never accept the webhook over plain HTTP outside local development.
- **Reverse-proxy validation.** Put the endpoint behind a reverse proxy that can enforce request size limits, timeouts, and (optionally) a well-known path prefix, before the request ever reaches the Node process.
- **Source-IP allowlisting, where practical.** TradingView publishes the IP ranges its alert servers send from; a reverse proxy or firewall rule can restrict `POST /webhooks/tradingview` to those ranges. This is a defense-in-depth measure, not a substitute for validating the payload itself: IP ranges can change, and this project does not hardcode them into application logic (that would silently break ingestion the day TradingView adds a new range without a code change).
- **Rate limiting.** Configurable, not hardcoded (env-driven; see `docs/tradingview-setup.md` for the exact variables) so it can be tuned for real alert volume without a deploy. Set generously enough that a burst of legitimate alerts (e.g. several instruments firing near the same bar close) is never accidentally throttled; log rejections so a too-tight limit is visible, not silently dropping real signals. Implemented with `@nestjs/throttler`, applied only to `POST /webhooks/tradingview` (not globally: every other endpoint is internal/local-only today). `TRADINGVIEW_WEBHOOK_RATE_LIMIT` (default `120`) is the number of requests allowed per `TRADINGVIEW_WEBHOOK_RATE_TTL_SECONDS` window (default `60`).
- **Payload size limits.** A `SETUP_CANDIDATE` alert is at most a few hundred bytes of JSON. The default Express/Nest body size limit (100kb) is already generous for this; nothing this project does needs a larger body, and a request exceeding it is rejected before any application code runs.
- **Strict schema validation.** Already enforced in application code (`packages/shared-types/src/tradingview.ts`) regardless of network-layer protections. Never trust a payload merely because it arrived on the expected path from an allowlisted IP.
- **Request logging without secrets.** Log the fact of a request (timestamp, processing outcome, latency), not the full raw body, in ordinary application logs. The raw body's durable, inspectable home is `InboundWebhookEvent`, accessed through the authenticated admin API/dashboard, not the log stream.
- **Optional source-certificate verification / mutual TLS**, where the reverse proxy supports it, for an extra layer of transport-level assurance. Not required for TradingView's own webhook delivery (which doesn't support client certificates), but relevant if this endpoint is ever fronted by infrastructure that can enforce it for other reasons.
- **Never trust `X-Forwarded-For` blindly.** If IP allowlisting is implemented, only trust `X-Forwarded-For`/`X-Real-IP` when the application is deployed behind a specifically configured, trusted reverse proxy that is known to set that header correctly and strip any client-supplied value, since otherwise a client can simply forge the header. NestJS's `app.set('trust proxy', ...)` (Express) must be configured deliberately, not left permissive by default.

## Optional shared-secret validation

TradingView's webhook alerts do not support custom request signing headers directly, but a shared secret can still be embedded as a field in the alert message's JSON body (distinct from a *credential*: a per-deployment random string with no access to money, used only to prove "this request came from an alert template I configured," similar in spirit to a webhook path secret). If added in a future iteration:

- Store it as an environment variable, never committed to source control (see `.env.example`).
- Compare it in constant time (`crypto.timingSafeEqual`), not `===`, to avoid a timing side-channel.
- Reject (and journal) any request with a missing or mismatched secret before any other processing.

This is not implemented in Milestone 3. The payload schema documented in `docs/tradingview-setup.md` has no such field yet. Documented here as the recommended shape if/when it's added, so it isn't invented ad hoc later.

## Local development vs. production

| Control | Local development | Production |
|---|---|---|
| Transport | plain HTTP, `localhost` | HTTPS via reverse proxy |
| Rate limiting | effectively unlimited (generous defaults) | tuned to real alert volume |
| IP allowlisting | none | TradingView's published ranges, at the proxy/firewall |
| Body size limit | default (100kb) | default (100kb), already generous |
| Logging | verbose, local-only | outcome/latency only, no raw body in logs |

Nothing above requires different application code between the two. It's reverse-proxy and environment configuration, keeping the application itself simple per `CLAUDE.md`'s "avoid premature abstractions."
