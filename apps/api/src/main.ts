import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { DomainErrorFilter } from "./common/domain-error.filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Local dev: allow the dashboard's origin (and any other local origin)
  // rather than hardcoding one port, since DASHBOARD_PORT is configurable.
  app.enableCors({ origin: true });

  // Global translation of packages/database's Milestone 2 repository error
  // classes (NotFoundError -> 404, SetupTransitionError/JournalTradeStateError
  // -> 409) — see common/domain-error.filter.ts.
  app.useGlobalFilters(new DomainErrorFilter());

  const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3001;
  await app.listen(port);
  console.log(`Trading Copilot API listening on port ${port}`);
}

bootstrap();
