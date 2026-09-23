import { Module } from "@nestjs/common";
import { ScreenshotModule } from "../screenshots/screenshot.module";
import { SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

@Module({
  imports: [ScreenshotModule],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
