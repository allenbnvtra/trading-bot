import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UsePipes,
} from "@nestjs/common";
import {
  createRiskCalculationSchema,
  createSetupSchema,
  setupListQuerySchema,
  updateSetupStatusSchema,
  type CreateRiskCalculationInput,
  type CreateSetupInput,
  type SetupListQuery,
  type UpdateSetupStatusInput,
} from "@trading-copilot/shared-types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { SetupService } from "./setup.service";

@Controller("setups")
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(createSetupSchema))
  create(@Body() body: CreateSetupInput) {
    return this.setupService.create(body);
  }

  @Get()
  @UsePipes(new ZodValidationPipe(setupListQuerySchema))
  list(@Query() query: SetupListQuery) {
    return this.setupService.list(query);
  }

  @Get(":id")
  getById(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.setupService.getById(id);
  }

  @Patch(":id/status")
  updateStatus(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateSetupStatusSchema)) body: UpdateSetupStatusInput,
  ) {
    return this.setupService.updateStatus(id, body);
  }

  @Get(":id/timeline")
  getTimeline(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.setupService.getTimeline(id);
  }

  @Post(":id/risk-calculations")
  @HttpCode(HttpStatus.CREATED)
  createRiskCalculation(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(createRiskCalculationSchema)) body: CreateRiskCalculationInput,
  ) {
    return this.setupService.createRiskCalculation(id, body);
  }

  @Get(":id/risk-calculations")
  listRiskCalculations(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.setupService.listRiskCalculations(id);
  }

  @Get(":id/risk-calculations/latest")
  getLatestRiskCalculation(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.setupService.getLatestRiskCalculation(id);
  }
}
