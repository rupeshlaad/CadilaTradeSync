export interface BrokerProfile {
  broker: string;
  userId: string;
  userName: string;
  email?: string;
  /** Sprint 6.1.2 — optional broker-reported entitlements (null when unsupported). */
  exchanges?: string[];
  products?: string[];
}

export interface BrokerAdapter {
  getLoginUrl(): string;

  exchangeToken(token: string): Promise<any>;

  getProfile(): Promise<BrokerProfile>;

  getMargins(): Promise<any>;

  getHoldings(): Promise<any>;

  getPositions(): Promise<any>;

  placeOrder(order: any): Promise<any>;

  modifyOrder(orderId: string, order: any): Promise<any>;

  cancelOrder(orderId: string): Promise<any>;

  getOrders(): Promise<any>;
}