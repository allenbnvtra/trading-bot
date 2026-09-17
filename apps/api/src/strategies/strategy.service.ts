import { Injectable, NotFoundException } from "@nestjs/common";
import { strategiesRepository } from "@trading-copilot/database";
import type { Strategy } from "@trading-copilot/trading-domain";

@Injectable()
export class StrategyService {
  list(): Promise<Strategy[]> {
    return strategiesRepository.listStrategies();
  }

  async getById(id: string) {
    const strategy = await strategiesRepository.getStrategyWithVersions(id);
    if (!strategy) {
      throw new NotFoundException(`Strategy ${id} not found`);
    }
    return strategy;
  }
}
