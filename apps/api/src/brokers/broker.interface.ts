export interface BrokerProfile {
  broker: string;
  userId: string;
  userName: string;
  email?: string;
  /** Sprint 6.1.2 — optional broker-reported entitlements (null when unsupported). */
  exchanges?: string[];
  products?: string[];
  /** Sprint 6.1.4 — richer live-profile fields (only when the SDK exposes them). */
  mobile?: string;
  accountType?: string;
  rmsStatus?: string;
  segments?: string[];
  profileStatus?: string;
}

/**
 * Sprint 6.1.3 — Declares which broker-data capabilities an adapter actually
 * implements. Used to distinguish "Not Supported by Broker" from genuinely
 * empty/failed data so the UI never fabricates values. This is the reusable
 * capability surface future modules (Holdings / Positions / Orders / Trades /
 * Portfolio / Live P&L) can consume without broker-specific branching.
 */
export interface BrokerCapabilities {
  profile: boolean;
  exchanges: boolean;
  products: boolean;
  funds: boolean;
  margin: boolean;
  holdings: boolean;
  positions: boolean;
  orders: boolean;
  trades: boolean;
}

/**
 * Sprint 6.1.5 — Operational feature support declared by each adapter and
 * consumed for capability-driven dashboard rendering (never keyed on broker
 * name in the UI).
 */
export interface BrokerFeatureSupport {
  supportsProfile: boolean;
  supportsFunds: boolean;
  supportsMargins: boolean;
  supportsHoldings: boolean;
  supportsPositions: boolean;
  supportsOrders: boolean;
  supportsTrades: boolean;
  supportsPortfolio: boolean;
  supportsAutoLogin: boolean;
  supportsLogout: boolean;
  supportsSessionRefresh: boolean;
}

/**
 * Sprint 6.1.5 — Onboarding requirements declared by each adapter. Drives the
 * dynamic connect form (no broker-specific UI duplication).
 */
export interface BrokerOnboardingRequirements {
  requiresOAuth: boolean;
  requiresApiKey: boolean;
  requiresSecret: boolean;
  requiresPassword: boolean;
  requiresPIN: boolean;
  requiresTOTP: boolean;
  requiresStaticIP: boolean;
  requiresRedirect: boolean;
  requiresVendorCode: boolean;
  supportsAutoLogin: boolean;
  supportsTokenRefresh: boolean;
  supportsMFA: boolean;
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