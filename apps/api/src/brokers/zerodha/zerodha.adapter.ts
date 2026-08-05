import { KiteConnect } from 'kiteconnect';
import { BrokerAdapter, BrokerProfile } from '../broker.interface';

export class ZerodhaAdapter implements BrokerAdapter {
  private kite: any;

  constructor() {
    this.kite = new KiteConnect({
      api_key: process.env.ZERODHA_API_KEY!,
    });
  }

  setAccessToken(accessToken: string) {
    this.kite.setAccessToken(accessToken);
  }

  getLoginUrl(): string {
    return this.kite.getLoginURL();
  }

  async exchangeToken(token: string): Promise<any> {
    const session = await this.kite.generateSession(
      token,
      process.env.ZERODHA_API_SECRET!
    );

    this.kite.setAccessToken(session.access_token);

    return session;
  }

  async getProfile(): Promise<BrokerProfile> {
    const p: any = await this.kite.getProfile();

    return {
      broker: 'ZERODHA',
      userId: p.user_id,
      userName: p.user_name,
      email: p.email,
      exchanges: Array.isArray(p.exchanges) ? p.exchanges : undefined,
      products: Array.isArray(p.products) ? p.products : undefined,
    };
  }

  async getMargins() {
    return this.kite.getMargins();
  }

  async getHoldings() {
    return this.kite.getHoldings();
  }

  async getPositions() {
    return this.kite.getPositions();
  }

  async placeOrder(order: any) {
    return this.kite.placeOrder('regular', order);
  }

  async modifyOrder(orderId: string, order: any) {
    return this.kite.modifyOrder('regular', orderId, order);
  }

  async cancelOrder(orderId: string) {
    return this.kite.cancelOrder('regular', orderId);
  }

  async getOrders() {
   return this.kite.getOrders();
  }
  async getTrades() {
   return this.kite.getTrades();
  }
}