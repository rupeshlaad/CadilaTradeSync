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