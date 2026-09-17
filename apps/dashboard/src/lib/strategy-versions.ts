import { getStrategies, getStrategy, type StrategyVersion } from "./api";

export interface StrategyVersionWithStrategy extends StrategyVersion {
  strategyName: string;
  strategyKey: string;
}

/**
 * Flattens every strategy's versions into a single list, each tagged with
 * its parent strategy's name/key. Used to populate the "strategy version"
 * dropdown on the create-backtest form and to label backtests by strategy
 * version in list views instead of showing raw UUIDs.
 */
export async function getAllStrategyVersions(): Promise<StrategyVersionWithStrategy[]> {
  const strategies = await getStrategies();
  const withVersions = await Promise.all(
    strategies.map(async (strategy) => {
      const full = await getStrategy(strategy.id);
      return full.versions.map((version) => ({
        ...version,
        strategyName: strategy.name,
        strategyKey: strategy.key,
      }));
    }),
  );
  return withVersions.flat();
}
