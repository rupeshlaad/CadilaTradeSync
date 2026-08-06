export enum Role {
  ADMIN = 'ADMIN',
  USER = 'USER',
}

export enum Broker {
  ZERODHA = 'ZERODHA',
  FYERS = 'FYERS',
  ANGEL_ONE = 'ANGEL_ONE',
  UPSTOX = 'UPSTOX',
  DHAN = 'DHAN',
  ICICI_DIRECT = 'ICICI_DIRECT',
  SHOONYA = 'SHOONYA',
}

export const BROKER_LABELS: Record<Broker, string> = {
  [Broker.ZERODHA]: 'Zerodha',
  [Broker.FYERS]: 'Fyers',
  [Broker.ANGEL_ONE]: 'Angel One',
  [Broker.UPSTOX]: 'Upstox',
  [Broker.DHAN]: 'Dhan',
  [Broker.ICICI_DIRECT]: 'ICICI Direct',
  [Broker.SHOONYA]: 'Shoonya',
};

/**
 * Broker registry — the brokers with a live adapter + instrument importer
 * wired into the platform. Single source of truth for every broker-picker
 * (instrument search, cross-broker translation, import controls) so no UI
 * hardcodes the supported set. The remaining Broker enum members
 * (ANGEL_ONE / UPSTOX / DHAN) are reserved and have no adapter yet.
 */
export const ACTIVE_BROKERS: Broker[] = [
  Broker.ZERODHA,
  Broker.FYERS,
  Broker.ICICI_DIRECT,
  Broker.SHOONYA,
];

export function isActiveBroker(broker: Broker): boolean {
  return ACTIVE_BROKERS.includes(broker);
}


export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
  EXPIRED = 'EXPIRED',
}

export enum Visibility {
  PRIVATE = 'PRIVATE',
  PUBLIC = 'PUBLIC',
}

export enum StrategyStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ARCHIVED = 'ARCHIVED',
}

export enum SubscriptionStatus {
  TRIAL = 'TRIAL',
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

export enum AccountType {
  MASTER = 'MASTER',
  FOLLOWER = 'FOLLOWER',
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  isActive?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthTokens {
  accessToken: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

export interface AuthResponse {
  user: PublicUser;
  tokens: AuthTokens;
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
  error?: string;
}

export interface TradingAccountDto {
  id: string;
  userId: string;
  broker: Broker;
  platform: string;
  nickname: string;
  clientId: string;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  hasPassword: boolean;
  hasTotpSecret: boolean;
  staticIpPrimary: string | null;
  staticIpSecondary: string | null;
  connectionStatus: ConnectionStatus;
  enabled: boolean;
  healthScore: number;
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTradingAccountPayload {
  broker: Broker;
  platform: string;
  nickname: string;
  clientId: string;

  apiKey?: string;
  apiSecret?: string;

  vendorCode?: string;

  password?: string;
  totpSecret?: string;

  staticIpPrimary?: string;
  staticIpSecondary?: string;
}

export type UpdateTradingAccountPayload = Partial<CreateTradingAccountPayload> & { enabled?: boolean };

export interface StrategyDto {
  id: string;
  tradingAccountId: string;
  strategyName: string;
  description: string | null;
  enabled: boolean;
  visibility: Visibility;
  masterAccount: boolean;
  baseQuantity: number;
  maxFollowers: number;
  status: StrategyStatus;
  createdAt: string;
  updatedAt: string;
  followerCount?: number;
  tradingAccount?: Pick<TradingAccountDto, 'nickname' | 'broker'>;
}

export interface CreateStrategyPayload {
  tradingAccountId: string;
  strategyName: string;
  description?: string;
  visibility?: Visibility;
  masterAccount?: boolean;
  baseQuantity?: number;
  maxFollowers?: number;
  status?: StrategyStatus;
  enabled?: boolean;
}

export type UpdateStrategyPayload = Partial<CreateStrategyPayload>;

export interface FollowerDto {
  id: string;
  strategyId: string;
  followerUserId: string;
  tradingAccountId: string;
  multiplier: number;
  maximumLoss: number | null;
  maximumDailyLoss: number | null;
  enabled: boolean;
  createdAt: string;
  strategy?: Pick<StrategyDto, 'strategyName' | 'visibility' | 'status'>;
  tradingAccount?: Pick<TradingAccountDto, 'nickname' | 'broker'>;
  followerUser?: Pick<PublicUser, 'email' | 'name'>;
}

export interface SubscribeStrategyPayload {
  strategyId: string;
  tradingAccountId: string;
  multiplier: number;
  maximumLoss?: number;
  maximumDailyLoss?: number;
}

export interface SubscriptionDto {
  id: string;
  followerUserId: string;
  strategyId: string;
  status: SubscriptionStatus;
  startDate: string;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
  strategy?: Pick<StrategyDto, 'strategyName' | 'visibility'>;
}

export const APP_NAME = 'Candila TradeSync';
export const APP_SHORT_NAME = 'CTS';

// ---------------------------------------------------------------------------
// Sprint 6.0 — Strategy Intelligence Dashboard (Phase 1 — presentation).
//
// Reusable, presentation-oriented DTO exposed by GET /strategies/:id/summary
// (user-scoped, marketplace-visible when the strategy is PUBLIC) and
// GET /admin/strategies/:id/summary (admin-scoped). Consumed by the Master
// Portal strategy detail page and the Follower Marketplace detail page —
// same payload, same shared components.
//
// Historical Strategy Performance will be imported in a future sprint.
// Live Strategy Performance will be generated from ExecutionHistory in a
// future sprint. Every performance / risk field is nullable today so the
// shared UI can render "Not Available" without fabricated values.
// ---------------------------------------------------------------------------

export type StrategyRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Static profile fields extracted directly from the Strategy row. The
 * `strategyCode` is derived from the id (short prefix) so the UI can
 * display a human-friendly identifier without a schema change.
 */
export interface StrategyProfileDto {
  id: string;
  strategyName: string;
  strategyCode: string;
  description: string | null;
  status: StrategyStatus;
  visibility: Visibility;
  riskLevel: StrategyRiskLevel | null;
  supportedBrokers: Broker[];
  supportedMarkets: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Aggregate counts (existing data only — no calculations). "Active
 * subscribers" == Subscription rows with status ACTIVE. "Active
 * followers" == enabled Follower rows. "Active master accounts" ==
 * count of distinct enabled MASTER trading accounts backing the
 * strategy. Each is nullable when the data is genuinely unavailable
 * so the UI can render "Not Available".
 */
export interface StrategyOverviewDto {
  activeSubscribers: number | null;
  activeMasterAccounts: number | null;
  activeFollowers: number | null;
  currentStatus: StrategyStatus;
}

/**
 * Performance placeholders. Every field is null in Phase 1. `lastUpdated`
 * is null until the future performance-import sprint lands.
 */
export interface StrategyPerformanceDto {
  todayReturn: number | null;
  weeklyReturn: number | null;
  monthlyReturn: number | null;
  overallReturn: number | null;
  winRate: number | null;
  totalTrades: number | null;
  capitalManaged: number | null;
  lastUpdated: string | null;
}

/**
 * Risk placeholder. Every field is null / empty in Phase 1 — the UI
 * renders "Data will be available after performance import." when
 * neither drawdown nor volatility is set.
 */
export interface StrategyRiskDto {
  riskLevel: StrategyRiskLevel | null;
  maxDrawdown: number | null;
  volatility: number | null;
  notes: string[];
}

/**
 * Recent activity slot. Kept as a list of opaque items so the shape can
 * be extended (e.g. from ExecutionHistory) in a future sprint without a
 * type break for existing consumers.
 */
export interface StrategyRecentActivityItem {
  at: string;
  kind: string;
  label: string;
}

export interface StrategyRecentActivityDto {
  items: StrategyRecentActivityItem[];
}

export interface StrategySummaryDto {
  profile: StrategyProfileDto;
  overview: StrategyOverviewDto;
  performance: StrategyPerformanceDto;
  risk: StrategyRiskDto;
  recentActivity: StrategyRecentActivityDto;
}

// ---------------------------------------------------------------------------
// Sprint 6.1 — Follower Onboarding & Dashboard header DTOs
// ---------------------------------------------------------------------------

export interface FollowerOnboardingStep {
  key: 'PROFILE' | 'BROKER' | 'RISK' | 'STRATEGY' | 'READY';
  label: string;
  complete: boolean;
}

export interface FollowerOnboardingStatusDto {
  steps: FollowerOnboardingStep[];
  completedCount: number;
  totalCount: number;
  readyForTrading: boolean;
}

export interface FollowerDashboardSummaryDto {
  userName: string | null;
  userEmail: string | null;
  totalBrokers: number;
  connectedBrokers: number;
  activeStrategies: number;
  activeSubscriptions: number;
  lastSync: string | null;
}

/**
 * Sprint 6.1 — Broker connection state visualised by the shared
 * BrokerConnectionBadge. Superset of the current backend
 * `ConnectionStatus` enum so the UI can also render ephemeral
 * "RECONNECTING" transitions the frontend tracks locally during the
 * OAuth roundtrip.
 */
export type BrokerConnectionState =
  | 'CONNECTED'
  | 'EXPIRED'
  | 'DISCONNECTED'
  | 'RECONNECTING'
  | 'ERROR';

// ---------------------------------------------------------------------------
// Sprint 6.1.2 — Follower Broker Lifecycle Stabilization
//
// One source of truth for broker session state. The backend derives all
// of the fields below from the persisted TradingAccount + BrokerSession
// rows (BrokerService), so refresh / logout / restart cannot desync the
// UI from the database. No field is fabricated — anything the broker does
// not expose is returned as null and rendered as "—" by the UI.
// ---------------------------------------------------------------------------

/**
 * Session health lifecycle states. Derived from persisted broker session
 * state (and, for the live verify probe, from the broker's own response).
 */
export type BrokerSessionHealthState =
  | 'CONNECTED'
  | 'EXPIRED'
  | 'INVALID_TOKEN'
  | 'REAUTHENTICATION_REQUIRED'
  | 'NEVER_CONNECTED'
  | 'DISCONNECTED';

export const BROKER_SESSION_HEALTH_LABELS: Record<BrokerSessionHealthState, string> = {
  CONNECTED: 'Connected',
  EXPIRED: 'Expired',
  INVALID_TOKEN: 'Invalid Token',
  REAUTHENTICATION_REQUIRED: 'Reauthentication Required',
  NEVER_CONNECTED: 'Never Connected',
  DISCONNECTED: 'Disconnected',
};

/** Access-token liveness classification for a broker session. */
export type BrokerTokenStatus = 'VALID' | 'EXPIRED' | 'INVALID' | 'NONE';

// ---------------------------------------------------------------------------
// Sprint 6.1.5 — Capability-driven, SDK-driven operational broker dashboard.
// ---------------------------------------------------------------------------

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

export interface BrokerCatalogEntry {
  broker: Broker;
  capabilities: BrokerCapabilities;
  features: BrokerFeatureSupport;
  onboarding: BrokerOnboardingRequirements;
}

export interface BrokerHoldingRow {
  symbol: string;
  exchange: string | null;
  quantity: number | null;
  averagePrice: number | null;
  ltp: number | null;
  currentValue: number | null;
  pnl: number | null;
}

export interface BrokerPositionRow {
  symbol: string;
  exchange: string | null;
  product: string | null;
  quantity: number | null;
  averagePrice: number | null;
  ltp: number | null;
  pnl: number | null;
}

export interface BrokerOrderRow {
  orderId: string;
  symbol: string;
  side: string | null;
  quantity: number | null;
  price: number | null;
  status: string | null;
  orderType: string | null;
  time: string | null;
}

export interface BrokerTradeRow {
  tradeId: string;
  orderId: string | null;
  symbol: string;
  side: string | null;
  quantity: number | null;
  price: number | null;
  time: string | null;
}

export interface BrokerPortfolioSummary {
  instruments: number;
  totalValue: number | null;
  totalPnl: number | null;
}

export interface BrokerDashboardHealth {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  sessionHealthState: BrokerSessionHealthState;
  tokenStatus: BrokerTokenStatus;
  broker: Broker;
  clientId: string;
  accountHolder: string | null;
  brokerUserId: string | null;
  loginTime: string | null;
  lastHeartbeat: string | null;
  sessionActive: boolean;
  tokenExpired: boolean | null;
}

export interface BrokerDashboardErrors {
  profile: string | null;
  margins: string | null;
  holdings: string | null;
  positions: string | null;
  orders: string | null;
  trades: string | null;
}

/** Full SDK-driven broker dashboard (GET /trading-accounts/:id/dashboard). */
export interface BrokerDashboardDto {
  broker: Broker;
  clientId: string;
  capabilities: BrokerCapabilities;
  features: BrokerFeatureSupport;
  health: BrokerDashboardHealth;
  profile: BrokerLiveProfileDto;
  funds: BrokerFundsSummaryDto[] | null;
  holdings: BrokerHoldingRow[] | null;
  positions: BrokerPositionRow[] | null;
  orders: BrokerOrderRow[] | null;
  trades: BrokerTradeRow[] | null;
  portfolio: BrokerPortfolioSummary | null;
  errors: BrokerDashboardErrors;
}

export type BrokerDashboardSection =
  | 'profile'
  | 'funds'
  | 'holdings'
  | 'positions'
  | 'orders'
  | 'trades';

/** Granular section refresh (GET /trading-accounts/:id/section/:section). */
export interface BrokerSectionResponse<T = unknown> {
  section: BrokerDashboardSection;
  supported: boolean;
  data: T | null;
  error: string | null;
}

/**
 * Response of GET /trading-accounts/:id/session-health (follower) and
 * GET /admin/master-accounts/:id/session-health (master). Cheap, clock-based
 * probe that never round-trips to the broker.
 */
export interface BrokerSessionHealthDto {
  broker: Broker;
  clientId: string;
  /** Broker-reported account holder name (from the last successful login). */
  accountHolder: string | null;
  /** Broker-reported user/client id (from the last successful login). */
  brokerUserId: string | null;
  connectionStatus: ConnectionStatus;
  sessionHealthState: BrokerSessionHealthState;
  tokenStatus: BrokerTokenStatus;
  loginTime: string | null;
  connectionTime: string | null;
  lastHeartbeat: string | null;
  expiresAt: string | null;
  sessionActive: boolean;
  tokenExpired: boolean | null;
}

/**
 * Normalized funds/margin snapshot extracted (never fabricated) from the
 * broker margins payload when the broker supports it.
 */
export interface BrokerFundsSummaryDto {
  segment: string;
  available: number | null;
  used: number | null;
  net: number | null;
  /** Sprint 6.1.4 — detailed funds/margin breakdown (null when not exposed). */
  availableCash: number | null;
  usedMargin: number | null;
  availableMargin: number | null;
  openingBalance: number | null;
  collateral: number | null;
}

/**
 * Sprint 6.1.4 — Live broker profile. Every field is nullable; a null value
 * is rendered as "Not provided by broker" (never fabricated, never "--").
 */
export interface BrokerLiveProfileDto {
  userName: string | null;
  email: string | null;
  mobile: string | null;
  accountType: string | null;
  rmsStatus: string | null;
  exchanges: string[] | null;
  products: string[] | null;
  segments: string[] | null;
  profileStatus: string | null;
}

/**
 * Sprint 6.1.3 — Declares which broker-data capabilities an adapter actually
 * implements, so the UI can render "Not Supported by Broker" instead of a
 * fabricated or ambiguous empty value. Reusable by future Holdings /
 * Positions / Orders / Trades / Portfolio / Live P&L modules.
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
 * Response of GET /trading-accounts/:id/broker-info (follower live verify).
 * Retrieves broker account information through the existing broker adapter
 * immediately after OAuth so the follower can confirm CTS is truly linked.
 */
export interface BrokerVerifyInfoDto {
  broker: Broker;
  clientId: string;
  accountHolder: string | null;
  brokerUserId: string | null;
  email: string | null;
  connectionStatus: ConnectionStatus;
  sessionHealthState: BrokerSessionHealthState;
  tokenStatus: BrokerTokenStatus;
  loginTime: string | null;
  connectionTime: string | null;
  lastSync: string | null;
  /** Broker-declared data capabilities (single source for "Not Supported"). */
  capabilities: BrokerCapabilities;
  /** True when the live profile probe returned data. */
  profileAvailable: boolean;
  /** Sprint 6.1.4 — full live profile (nullable fields → "Not provided by broker"). */
  liveProfile: BrokerLiveProfileDto;
  exchanges: string[] | null;
  products: string[] | null;
  funds: BrokerFundsSummaryDto[] | null;
  marginAvailable: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Sprint 6.1.4 — Master Portal follower operational overview.
// Aggregated from existing tables/services (User, Follower, Subscription,
// TradingAccount, BrokerSession via BrokerService, ExecutionHistory). No new
// schema. Broker credentials/secrets are NEVER included.
// ---------------------------------------------------------------------------

export interface FollowerBrokerAccountSummary {
  id: string;
  broker: Broker;
  brokerLabel: string;
  nickname: string;
  clientId: string;
  accountHolder: string | null;
  connectionStatus: ConnectionStatus;
  sessionHealthState: BrokerSessionHealthState;
  tokenStatus: BrokerTokenStatus;
  enabled: boolean;
  loginTime: string | null;
  lastSync: string | null;
  connectedSince: string | null;
}

export interface FollowerSubscriptionSummary {
  followerId: string;
  strategyId: string;
  strategyName: string | null;
  strategyStatus: StrategyStatus | null;
  subscriptionStatus: SubscriptionStatus | null;
  subscriptionDate: string | null;
  copyTradingEnabled: boolean;
  multiplier: number;
  maximumLoss: number | null;
  maximumDailyLoss: number | null;
}

export interface FollowerTradingSummary {
  totalOrders: number;
  successfulOrders: number;
  failedOrders: number;
  skippedOrders: number;
  lastTradeAt: string | null;
  openPositions: number | null;
  currentPnl: number | null;
  lifetimePnl: number | null;
}

export interface FollowerOverviewDto {
  profile: {
    userId: string;
    fullName: string | null;
    email: string;
    mobile: string | null;
    registrationDate: string | null;
    accountStatus: 'ACTIVE' | 'INACTIVE';
    lastLogin: string | null;
    lastActivity: string | null;
    country: string | null;
    subscriptionPlan: string | null;
  };
  brokerAccounts: FollowerBrokerAccountSummary[];
  subscriptions: FollowerSubscriptionSummary[];
  trading: FollowerTradingSummary;
}