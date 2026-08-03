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

  status: string;

  timestamp: Date;
}