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