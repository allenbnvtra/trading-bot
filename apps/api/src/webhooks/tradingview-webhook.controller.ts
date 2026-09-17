import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UsePipes,
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import {
  inboundWebhookEventListQuerySchema,
  type InboundWebhookEventListQuery,
} from "@trading-copilot/shared-types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TradingViewWebhookService } from "./tradingview-webhook.service";

/**
 * POST /webhooks/tradingview is the only rate-limited route in this app
 * (see docs/tradingview-security.md "production controls") - ThrottlerGuard
 * is applied per-route here, never globally, since every other endpoint is
 * internal/local-only for now. All orchestration (schema funnel,
 * fingerprinting, persistence, enqueue) lives in TradingViewWebhookService;
 * this controller only wires HTTP verbs/params to it, per CLAUDE.md "keep
 * controllers thin".
 */
@Controller("webhooks/tradingview")
export class TradingViewWebhookController {
  constructor(private readonly webhookService: TradingViewWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ThrottlerGuard)
  ingest(@Body() rawBody: unknown) {
    return this.webhookService.ingestWebhook(rawBody);
  }

  @Get("events")
  @UsePipes(new ZodValidationPipe(inboundWebhookEventListQuerySchema))
  listEvents(@Query() query: InboundWebhookEventListQuery) {
    return this.webhookService.listEvents(query);
  }

  @Get("events/:id")
  getEvent(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.webhookService.getEvent(id);
  }

  @Get("events/:id/timeline")
  getTimeline(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.webhookService.getTimeline(id);
  }
}
