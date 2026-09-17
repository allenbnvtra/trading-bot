import { Module } from "@nestjs/common";
import { MarketSnapshotController } from "./market-snapshot.controller";
import { MarketSnapshotService } from "./market-snapshot.service";

@Module({
  controllers: [MarketSnapshotController],
  providers: [MarketSnapshotService],
})
export class MarketSnapshotModule {}
