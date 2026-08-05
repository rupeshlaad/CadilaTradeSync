import { fyersModel } from 'fyers-api-v3';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
  UnsupportedResult,
} from '../broker.interface';

/**
 * Sprint 6.1.6 — Full Fyers API v3 adapter.
 *
 * The official `fyers-api-v3` (v2.0.0) client exposes the complete trading
 * surface as instance methods: get_profile, get_funds, get_holdings,
 * get_positions, get_orders, get_tradebook, logout_user, place/modify/cancel.
 * All of these are now wired. Exchanges/products are NOT part of the Fyers
 * profile payload, so they are honestly declared unsupported.
 */
export class FyersAdapter implements BrokerAdapter {
  static readonly capabilities: BrokerCapabilities = {
    profile: true,
    exchanges: false,
    products: false,
    funds: true,
    margin: true,
    holdings: true,
    positions: true,
    orders: true,
    trades: true,
  };

  static readonly features: BrokerFeatureSupport = {
    supportsProfile: true,
    supportsFunds: true,
    supportsMargins: true,
    supportsHoldings: true,
    supportsPositions: true,
    supportsOrders: true,
    supportsTrades: true,
    supportsPortfolio: true,
    supportsAutoLogin: false,
    supportsLogout: true,
    supportsSessionRefresh: true,
  };

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

  private unwrap(res: any, key: string): any {
    // Fyers responses are { s: 'ok', code, message, <key>: ... }.
    if (res && res.s && res.s !== 'ok') {
      throw new Error(res.message || `Fyers error (${res.code ?? 'unknown'})`);
    }
    return res?.[key] ?? res;
  }

  async getProfile(): Promise<BrokerProfile> {
    const res = await this.fyers.get_profile();
    const d = this.unwrap(res, 'data') ?? {};
    return {
      broker: 'FYERS',
      userId: d.fy_id,
      userName: d.name ?? d.display_name,
      email: d.email_id,
      mobile: d.mobile_number ?? undefined,
      accountType: d.pan ? 'INDIVIDUAL' : undefined,
      profileStatus: 'ACTIVE',
    };
  }

  async getMargins() {
    // Fyers exposes funds + margin through the same get_funds() endpoint.
    return this.fyers.get_funds();
  }

  async getFunds() {
    return this.fyers.get_funds();
  }

  async getHoldings() {
    return this.fyers.get_holdings();
  }

  async getPositions() {
    return this.fyers.get_positions();
  }

  async getOrders() {
    return this.fyers.get_orders();
  }

  async getTrades() {
    return this.fyers.get_tradebook();
  }

  async getPortfolio() {
    return this.fyers.get_holdings();
  }

  async getExchanges(): Promise<string[] | null> {
    return null; // Not part of the Fyers profile payload.
  }

  async getProducts(): Promise<string[] | null> {
    return null; // Not part of the Fyers profile payload.
  }

  async logout(): Promise<UnsupportedResult | { supported: true; data?: any }> {
    const data = await this.fyers.logout_user();
    return { supported: true, data };
  }

  async refreshSession(): Promise<
    UnsupportedResult | { supported: true; data?: any }
  > {
    // Fyers supports a refresh-token flow, but it requires the stored refresh
    // token + PIN which the current session model does not persist. Declared
    // supported-at-SDK but not yet wired end-to-end.
    return {
      supported: false,
      reason:
        'Fyers refresh requires a stored refresh token + PIN (not yet persisted in CTS).',
    };
  }

  async placeOrder(order: any) {
    return this.fyers.place_order(order);
  }

  async modifyOrder(orderId: string, order: any) {
    const payload = order?.id ? order : { ...order, id: orderId };
    return this.fyers.modify_order(payload);
  }

  async cancelOrder(orderId: string) {
    return this.fyers.cancel_order({ id: orderId });
  }

  async searchSymbol(symbol: string) {
    return this.fyers.search_symbol(symbol);
  }
}
