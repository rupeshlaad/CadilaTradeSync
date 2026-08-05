import axios from 'axios';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
} from '../broker.interface';

export class ShoonyaAdapter implements BrokerAdapter {
  /**
   * Sprint 6.1.3 — Only profile (UserDetails) is wired today; the remaining
   * data methods are stubs, so they are honestly reported as unsupported.
   */
  static readonly capabilities: BrokerCapabilities = {
    profile: true,
    exchanges: false,
    products: false,
    funds: false,
    margin: false,
    holdings: false,
    positions: false,
    orders: false,
    trades: false,
  };

  /** Sprint 6.1.5 — operational feature support. */
  static readonly features: BrokerFeatureSupport = {
    supportsProfile: true,
    supportsFunds: false,
    supportsMargins: false,
    supportsHoldings: false,
    supportsPositions: false,
    supportsOrders: false,
    supportsTrades: false,
    supportsPortfolio: false,
    supportsAutoLogin: true,
    supportsLogout: false,
    supportsSessionRefresh: false,
  };

  /**
   * Sprint 6.1.5 — onboarding requirements. Shoonya uses direct login
   * (API key + user id + password + TOTP + vendor code), not OAuth.
   */
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

  setSessionToken(token: string) {
    this.sessionToken = token;
  }

  getLoginUrl(): string {
    // Shoonya does not use OAuth like Zerodha/FYERS.
    // Login is handled using API credentials + TOTP.
    return '';
  }

  async exchangeToken(_: string): Promise<any> {
    throw new Error('Shoonya does not support OAuth token exchange.');
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
      "jData",
      JSON.stringify({
        source: "API",
        apkversion: "1.0.0",
        uid: payload.uid,
        pwd: payload.pwd,
        factor2: payload.factor2,
        vc: payload.vc,
        appkey: payload.appkey,
        imei: "CTS_SERVER",
      }),
    );

    console.log(body.toString());

    const response = await axios.post(
      `${this.baseUrl}/QuickAuth`,
      body.toString(),
    );

    console.log(response.data);

    return response.data;
  }

  async getProfile(): Promise<BrokerProfile> {
    const { data } = await axios.post(
      `${this.baseUrl}/UserDetails`,
      {
        jKey: this.sessionToken,
      },
    );

    return {
      broker: 'SHOONYA',
      userId: data.actid,
      userName: data.uname,
      email: '',
    };
  }

  async getMargins() {
    return {};
  }

  async getHoldings() {
    return [];
  }

  async getPositions() {
    return [];
  }

  async placeOrder(order: any) {
    return {};
  }

  async modifyOrder(orderId: string, order: any) {
    return {};
  }

  async cancelOrder(orderId: string) {
    return {};
  }

  async getOrders() {
    return [];
  }
}