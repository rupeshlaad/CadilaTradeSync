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
  // Sprint 6.2.15 — per-account Fyers credentials. Default to the legacy env
  // values so an adapter built without setCredentials() is byte-identical to
  // the previous single-account behaviour; a per-account adapter overrides them
  // via setCredentials().
  private appId: string = process.env.FYERS_APP_ID ?? '';
  private secretId: string = process.env.FYERS_SECRET_ID ?? '';

  constructor() {
    this.fyers = new fyersModel();
    this.fyers.setAppId(this.appId);
    this.fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI!);
  }

  /**
   * Sprint 6.2.15 — account isolation. Mirrors ICICIDirectAdapter.setCredentials:
   * every Fyers TradingAccount uses its OWN App ID (api key) + Secret ID
   * (api secret), never the global FYERS_APP_ID/FYERS_SECRET_ID. The App ID
   * drives the OAuth login URL, the generate_access_token exchange AND the
   * authenticated request header (`appId:accessToken`), so it must be set on
   * the SDK instance before any of login / exchange / read is called. This is
   * what makes two Fyers accounts (e.g. Dimple vs Rupesh) resolve to their own
   * profile instead of whichever account owns the env App ID.
   */
  setCredentials(appId: string, secretId: string) {
    // Sprint 6.2.18 — trim the per-account App ID + Secret. Fyers rejects a
    // client_id with stray whitespace/newline (a common copy-paste artefact
    // from the developer portal) as "invalid appId" on the login page. Dimple's
    // App ID was pasted clean and works; a contaminated value (e.g. a trailing
    // newline) is sent as client_id=...%0A and fails. Trimming is safe for
    // every account and never alters a clean value.
    this.appId = (appId ?? '').trim();
    this.secretId = (secretId ?? '').trim();
    this.fyers.setAppId(this.appId);
  }

  setAccessToken(accessToken: string) {
    this.fyers.setAccessToken(accessToken);
  }

  getLoginUrl(state?: string): string {
    // Sprint 6.2.17 — pass the self-contained OAuth state token so the broker
    // echoes it back on the callback (reconnect context survives without any
    // server-side memory). When omitted, the SDK default is used (unchanged).
    return state
      ? this.fyers.generateAuthCode({ state })
      : this.fyers.generateAuthCode();
  }

  async exchangeToken(token: string): Promise<any> {
    const session = await this.fyers.generate_access_token({
      client_id: this.appId,
      secret_key: this.secretId,
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
