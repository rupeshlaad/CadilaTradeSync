export interface TradeEvent {
  broker: string;

  tradingAccountId: string;

  orderId: string;

  exchange: string;

  symbol: string;

  side: 'BUY' | 'SELL';

  quantity: number;

  orderType: string;

  product: string;

  price: number;

  /**
   * Trigger / stop-loss price for SL / SL-M orders. Optional + nullable so
   * every existing constructor stays valid; forwarded to the follower fan-out
   * so SL / SL-M master orders mirror correctly instead of collapsing to a
   * price-less MARKET.
   */
  triggerPrice?: number | null;

  status: string;

  timestamp: Date;

  /**
   * Origin of the trade event, forwarded to the execution recorder as
   * `tradeSource` so the Trade Monitor / execution-history audit trail
   * can distinguish broker-detected polls from admin-initiated manual
   * placements. Defaults to `BROKER_POLL` when unset for backward
   * compatibility with the existing master-watcher path.
   */
  source?: string;
}