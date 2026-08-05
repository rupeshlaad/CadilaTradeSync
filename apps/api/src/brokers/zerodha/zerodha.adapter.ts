import { KiteConnect } from 'kiteconnect';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
} from '../broker.interface';

export class ZerodhaAdapter implements BrokerAdapter {
  /** Sprint 6.1.3 — Kite exposes the full trading surface. */
  static readonly capabilities: BrokerCapabilities = {
    profile: true,
    exchanges: true,
    products: true,
    funds: true,
    margin: true,
    holdings: true,
    positions: true,
    orders: true,
    trades: true,
  };

  /** Sprint 6.1.5 — operational feature support (Kite SDK). */
  static readonly features: BrokerFeatureSupport = {
    supportsProfile: true,
    supportsFunds: true,
    supportsMargins: true,
    supportsHoldings: true,
    supportsPositions: true,
    supportsOrders: true,
    supportsTrades: true,
    supportsPortfolio: true,
    supportsAutoLogin: true,
    supportsLogout: false,
    supportsSessionRefresh: false,
  };

  /** Sprint 6.1.5 — onboarding requirements (OAuth + API key/secret). */
  static readonly onboarding: BrokerOnboardingRequirements = {
    requiresOAuth: true,
    requiresApiKey: true,
    requiresSecret: true,
    requiresPassword: false,
    requiresPIN: false,
    requiresTOTP: false,
    requiresStaticIP: false,
    requiresRedirect: true,
    requiresVendorCode: false,
    supportsAutoLogin: true,
    supportsTokenRefresh: false,
    supportsMFA: true,
  };

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
      // Kite exposes user_type + exchange list; mobile / RMS / profile status
      // are not part of the profile payload, so they are intentionally left
      // undefined ("Not provided by broker") rather than fabricated.
      accountType: p.user_type ?? undefined,
      segments: Array.isArray(p.exchanges) ? p.exchanges : undefined,
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

  // Sprint 6.1.6 — standardized surface (Kite exposes the full trading API).
  async getFunds() {
    return this.kite.getMargins();
  }
  async getPortfolio() {
    return this.kite.getHoldings();
  }
  async getExchanges(): Promise<string[] | null> {
    const p: any = await this.kite.getProfile();
    return Array.isArray(p.exchanges) ? p.exchanges : null;
  }
  async getProducts(): Promise<string[] | null> {
    const p: any = await this.kite.getProfile();
    return Array.isArray(p.products) ? p.products : null;
  }
  async logout() {
    // Kite exposes invalidate_access_token via REST but the Node SDK does not
    // wrap a logout; tokens simply expire daily.
    return {
      supported: false as const,
      reason: 'Kite Connect Node SDK does not expose a logout/invalidate call.',
    };
  }
  async refreshSession() {
    return {
      supported: false as const,
      reason: 'Kite Connect requires a fresh daily login; no token refresh flow.',
    };
  }
}