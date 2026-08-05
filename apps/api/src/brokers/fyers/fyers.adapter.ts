import { fyersModel } from 'fyers-api-v3';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
} from '../broker.interface';

export class FyersAdapter implements BrokerAdapter {
  /**
   * Sprint 6.1.3 — Reflects what THIS adapter currently implements, not the
   * broker's theoretical API. Profile + order placement/book are wired;
   * funds/margin/holdings/positions/trades are not implemented here yet, so
   * they are honestly reported as unsupported ("Not Supported by Broker").
   */
  static readonly capabilities: BrokerCapabilities = {
    profile: true,
    exchanges: false,
    products: false,
    funds: false,
    margin: false,
    holdings: false,
    positions: false,
    orders: true,
    trades: false,
  };

  /** Sprint 6.1.5 — operational feature support (only what the adapter wires). */
  static readonly features: BrokerFeatureSupport = {
    supportsProfile: true,
    supportsFunds: false,
    supportsMargins: false,
    supportsHoldings: false,
    supportsPositions: false,
    supportsOrders: true,
    supportsTrades: false,
    supportsPortfolio: false,
    supportsAutoLogin: false,
    supportsLogout: false,
    supportsSessionRefresh: true,
  };

  /** Sprint 6.1.5 — onboarding requirements (OAuth app id/secret + redirect). */
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
    supportsAutoLogin: false,
    supportsTokenRefresh: true,
    supportsMFA: false,
  };

  private fyers: any;

  constructor() {
    this.fyers = new fyersModel();

    this.fyers.setAppId(process.env.FYERS_APP_ID!);
    this.fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI!);
  }

  setAccessToken(accessToken: string) {
    this.fyers.setAccessToken(accessToken);
  }

  getLoginUrl(): string {
    return this.fyers.generateAuthCode();
  }

  async exchangeToken(token: string): Promise<any> {
    const session = await this.fyers.generate_access_token({
      client_id: process.env.FYERS_APP_ID!,
      secret_key: process.env.FYERS_SECRET_ID!,
      auth_code: token,
    });

    this.fyers.setAccessToken(session.access_token);

    return session;
  }

  async getProfile(): Promise<BrokerProfile> {
    const p = await this.fyers.get_profile();
    
    return {
      broker: 'FYERS',
      userId: p.data.fy_id,
      userName: p.data.name,
      email: p.data.email_id,
    };
  }

  async getMargins() {
    throw new Error('Not implemented');
  }

  async getHoldings() {
    throw new Error('Not implemented');
  }

  async getPositions() {
    throw new Error('Not implemented');
  }

  async placeOrder(order: any) {
    return this.fyers.place_order(order);
  }

  async modifyOrder(orderId: string, order: any) {
    // Fyers modify_order accepts a single payload that embeds the
    // order id via `id`. Callers pass the id both as the first
    // argument (matching the BrokerAdapter interface used by
    // ZerodhaAdapter) and inside `order.id`; we accept either.
    const payload = order?.id ? order : { ...order, id: orderId };
    return this.fyers.modify_order(payload);
  }

  async cancelOrder(orderId: string) {
    return this.fyers.cancel_order({ id: orderId });
  }

  async getOrders() {
   return this.fyers.getOrders();
 }

  async searchSymbol(symbol: string) {
    return this.fyers.search_symbol(symbol);
  }
}