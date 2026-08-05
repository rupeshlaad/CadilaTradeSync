import axios from 'axios';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
  UnsupportedResult,
} from '../broker.interface';

/**
 * Sprint 6.1.6 — Full Shoonya (Finvasia Noren) adapter.
 *
 * Noren REST endpoints are POST calls with a body of
 * `jData=<json>&jKey=<susertoken>` (application/x-www-form-urlencoded). Data
 * endpoints require `uid` and `actid` in jData, both derived from the stored
 * account user id (== Noren account id for retail accounts). Every documented
 * account endpoint is wired: UserDetails, Limits, Holdings, PositionBook,
 * OrderBook, TradeBook, Logout.
 */
export class ShoonyaAdapter implements BrokerAdapter {
  static readonly capabilities: BrokerCapabilities = {
    profile: true,
    exchanges: true,
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
    supportsAutoLogin: true,
    supportsLogout: true,
    supportsSessionRefresh: false,
  };

  static readonly onboarding: BrokerOnboardingRequirements = {
    requiresOAuth: false,
    requiresApiKey: true,
    requiresSecret: false,
    requiresPassword: true,
    requiresPIN: false,
    requiresTOTP: true,
    requiresStaticIP: false,
    requiresRedirect: false,
    requiresVendorCode: true,
    supportsAutoLogin: true,
    supportsTokenRefresh: false,
    supportsMFA: true,
  };

  private readonly baseUrl = 'https://api.shoonya.com/NorenWClientTP';
  private sessionToken = '';
  private uid = '';
  private actid = '';

  setSessionToken(token: string) {
    this.sessionToken = token;
  }

  /** Sprint 6.1.6 — user/account id required by every Noren data endpoint. */
  setUserId(userId: string) {
    this.uid = userId;
    this.actid = userId;
  }

  getLoginUrl(): string {
    // Shoonya uses direct API login (credentials + TOTP), not OAuth.
    return '';
  }

  async exchangeToken(_: string): Promise<any> {
    throw new Error('Shoonya does not support OAuth token exchange.');
  }

  /** Core Noren POST helper: jData + jKey, form-encoded. */
  private async post(path: string, jData: Record<string, any>): Promise<any> {
    const body = `jData=${JSON.stringify(jData)}&jKey=${this.sessionToken}`;
    const { data } = await axios.post(`${this.baseUrl}/${path}`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (data && data.stat && data.stat !== 'Ok' && !Array.isArray(data)) {
      throw new Error(data.emsg || `Shoonya error on ${path}`);
    }
    return data;
  }

  async login(payload: {
    uid: string;
    pwd: string;
    factor2: string;
    vc: string;
    appkey: string;
  }) {
    const body = new URLSearchParams();
    body.append(
      'jData',
      JSON.stringify({
        source: 'API',
        apkversion: '1.0.0',
        uid: payload.uid,
        pwd: payload.pwd,
        factor2: payload.factor2,
        vc: payload.vc,
        appkey: payload.appkey,
        imei: 'CTS_SERVER',
      }),
    );
    const response = await axios.post(
      `${this.baseUrl}/QuickAuth`,
      body.toString(),
    );
    return response.data;
  }

  async getProfile(): Promise<BrokerProfile> {
    const data = await this.post('UserDetails', { uid: this.uid });
    return {
      broker: 'SHOONYA',
      userId: data.actid ?? this.uid,
      userName: data.uname ?? '',
      email: data.email ?? '',
      exchanges: Array.isArray(data.exarr) ? data.exarr : undefined,
      accountType: data.actid ? 'INDIVIDUAL' : undefined,
      profileStatus: data.stat === 'Ok' ? 'ACTIVE' : undefined,
    };
  }

  async getMargins() {
    return this.post('Limits', { uid: this.uid, actid: this.actid });
  }

  async getFunds() {
    return this.post('Limits', { uid: this.uid, actid: this.actid });
  }

  async getHoldings() {
    // prd = product type; 'C' (CNC) is the standard delivery holdings product.
    return this.post('Holdings', {
      uid: this.uid,
      actid: this.actid,
      prd: 'C',
    });
  }

  async getPositions() {
    return this.post('PositionBook', { uid: this.uid, actid: this.actid });
  }

  async getOrders() {
    return this.post('OrderBook', { uid: this.uid });
  }

  async getTrades() {
    return this.post('TradeBook', { uid: this.uid, actid: this.actid });
  }

  async getPortfolio() {
    return this.getHoldings();
  }

  async getExchanges(): Promise<string[] | null> {
    const data = await this.post('UserDetails', { uid: this.uid });
    return Array.isArray(data.exarr) ? data.exarr : null;
  }

  async getProducts(): Promise<string[] | null> {
    return null; // Not distinctly enumerated by the Noren profile payload.
  }

  async logout(): Promise<UnsupportedResult | { supported: true; data?: any }> {
    const data = await this.post('Logout', { uid: this.uid });
    return { supported: true, data };
  }

  async refreshSession(): Promise<
    UnsupportedResult | { supported: true; data?: any }
  > {
    return {
      supported: false,
      reason:
        'Shoonya (Noren) has no token refresh; a fresh TOTP login is required daily.',
    };
  }

  async placeOrder(_order: any) {
    return {};
  }

  async modifyOrder(_orderId: string, _order: any) {
    return {};
  }

  async cancelOrder(_orderId: string) {
    return {};
  }
}
