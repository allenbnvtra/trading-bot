import { Body, Controller, Get, Post, UsePipes } from "@nestjs/common";
import { createInstrumentSchema, type CreateInstrumentInput } from "@trading-copilot/shared-types";
import type { Instrument } from "@trading-copilot/trading-domain";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { InstrumentService } from "./instrument.service";

@Controller("instruments")
export class InstrumentController {
  constructor(private readonly instrumentService: InstrumentService) {}

  @Get()
  list(): Promise<Instrument[]> {
    return this.instrumentService.list();
  }

  @Post()
  @UsePipes(new ZodValidationPipe(createInstrumentSchema))
  create(@Body() body: CreateInstrumentInput): Promise<Instrument> {
    return this.instrumentService.create(body);
  }
}
