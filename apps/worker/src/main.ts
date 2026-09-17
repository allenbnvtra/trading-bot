import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

/**
 * The worker is a pure BullMQ consumer — it never receives HTTP requests —
 * so it uses createApplicationContext instead of a full HTTP Nest app. This
 * avoids binding an unused port and keeps the process minimal. If a
 * liveness/readiness HTTP endpoint is ever needed (e.g. for container
 * orchestration), swap this for NestFactory.create() plus a small
 * HealthModule, mirroring apps/api's.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger("Worker");
  await NestFactory.createApplicationContext(AppModule);
  const concurrency = process.env.WORKER_CONCURRENCY ?? "2";
  logger.log(`Trading Copilot worker started (concurrency=${concurrency}), consuming queue "backtest-run"`);
}

bootstrap();
