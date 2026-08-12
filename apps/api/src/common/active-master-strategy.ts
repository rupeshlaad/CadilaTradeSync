import { Prisma, StrategyStatus } from '@prisma/client';

/**
 * THE single canonical predicate for "the ACTIVE master strategy driving a
 * master account's copy fan-out". Previously three call sites diverged —
 * `CopyTradingService.handleTrade` and `PositionLifecycleService.lookupStrategyId`
 * required `masterAccount: true`, while `MasterWatcherService.syncMaster` did
 * NOT — so a post-placement sync could early-return (no strategy) even though
 * copy trading would have run. This helper aligns all three to one filter.
 */
export function activeMasterStrategyWhere(
  tradingAccountId: string,
): Prisma.StrategyWhereInput {
  return {
    tradingAccountId,
    masterAccount: true,
    enabled: true,
    status: StrategyStatus.ACTIVE,
  };
}
