import { Module } from "@nestjs/common";
import { InstrumentController } from "./instrument.controller";
import { InstrumentService } from "./instrument.service";

@Module({
  controllers: [InstrumentController],
  providers: [InstrumentService],
})
export class InstrumentModule {}
