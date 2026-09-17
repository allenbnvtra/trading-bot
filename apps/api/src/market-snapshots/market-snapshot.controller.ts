import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UsePipes } from "@nestjs/common";
import { createMarketSnapshotSchema, type CreateMarketSnapshotInput } from "@trading-copilot/shared-types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { marketSnapshotListQuerySchema, type MarketSnapshotListQuery } from "./market-snapshot.schemas";
import { MarketSnapshotService } from "./market-snapshot.service";

@Controller("market-snapshots")
export class MarketSnapshotController {
  constructor(private readonly marketSnapshotService: MarketSnapshotService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(createMarketSnapshotSchema))
  create(@Body() body: CreateMarketSnapshotInput) {
    return this.marketSnapshotService.create(body);
  }

  @Get()
  @UsePipes(new ZodValidationPipe(marketSnapshotListQuerySchema))
  list(@Query() query: MarketSnapshotListQuery) {
    return this.marketSnapshotService.list(query);
  }

  @Get(":id")
  getById(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.marketSnapshotService.getById(id);
  }
}
