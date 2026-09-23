import { Module } from "@nestjs/common";
import { NotificationModule } from "../notifications/notification.module";
import { ScreenshotModule } from "../screenshots/screenshot.module";
import { SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

@Module({
  imports: [ScreenshotModule, NotificationModule],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
