import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Local dev: allow the dashboard's origin (and any other local origin)
  // rather than hardcoding one port, since DASHBOARD_PORT is configurable.
  app.enableCors({ origin: true });

  const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3001;
  await app.listen(port);
  console.log(`Trading Copilot API listening on port ${port}`);
}

bootstrap();
