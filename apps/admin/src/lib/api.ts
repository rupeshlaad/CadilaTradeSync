'use client';

import type {
  PublicUser,
  AuthResponse,
  TradingAccountDto,
  StrategyDto,
  FollowerDto,
  SubscriptionDto,
  CreateTradingAccountPayload,
  UpdateTradingAccountPayload,
} from '@cts/shared';
import { Broker } from '@cts/shared';

export interface AdminInstrumentSummary {
  id: string;
  contractKey: string;
  exchange: string;
  segment: string;
  underlying: string;
  instrumentType: string;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
  lotSize: number;
  tickSize: number | null;
}

export interface AdminInstrumentSearchRow {
  broker: Broker;
  brokerSymbol: string;
  brokerToken: string | null;
  instrument: AdminInstrumentSummary;
}

export interface AdminInstrumentSearchResponse {
  count: number;
  items: AdminInstrumentSearchRow[];
}

export interface AdminInstrumentBrokerMapping {
  id: string;
  instrumentId: string;
  broker: Broker;
  brokerSymbol: string;
  brokerToken: string | null;
  exchangeSymbol?: string | null;
  exchangeToken?: string | null;
  createdAt?: string;
}

export interface AdminInstrumentResolved {
  id: string;
  contractKey: string;
  exchange: string;
  segment: string;
  underlying: string;
  instrumentType: string;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
  lotSize: number;
  tickSize: number | null;
  createdAt?: string;
  brokers: AdminInstrumentBrokerMapping[];
}

export interface AdminInstrumentTranslateResponse {
  instrument: AdminInstrumentSummary;
  source: { broker: Broker; brokerSymbol: string; brokerToken: string | null };
  target: { broker: Broker; brokerSymbol: string; brokerToken: string | null };
}

export interface AdminInstrumentSearchQuery {
  q: string;
  broker?: Broker;
  exchange?: string;
  segment?: string;
  instrumentType?: string;
  limit?: number;
}

/**
 * Sprint 5.4.1 — Manual Trading instrument autocomplete.
 * Mirrors ManualInstrumentSearchRow returned by the API.
 */
export interface ManualInstrumentSearchRow {
  instrumentId: string;
  tradingSymbol: string;
  brokerSymbol: string;
  displayName: string;
  exchange: string;
  segment: string;
  lotSize: number;
  tickSize: number | null;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
}

export interface ManualInstrumentSearchResponse {
  broker: Broker;
  q: string;
  count: number;
  items: ManualInstrumentSearchRow[];
}

export interface AdminInstrumentImportSummary {
  broker: Broker;
  downloaded: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

export interface AdminInstrumentImportOneResponse {
  success: boolean;
  broker: Broker;
  summary: AdminInstrumentImportSummary;
}

export interface AdminInstrumentImportAllResponse {
  success: boolean;
  brokers: Broker[];
  summaries: Record<string, AdminInstrumentImportSummary>;
}

export interface AdminInstrumentStatsResponse {
  counts: {
    canonical: number;
    brokerMappings: number;
    zerodha: number;
    fyers: number;
  };
  lastRefresh: {
    overall: string | null;
    zerodha: string | null;
    fyers: string | null;
  };
  lastSummaries: Record<string, AdminInstrumentImportSummary>;
}

// -----------------------------
// Strategy Execution (Phase 1)
// -----------------------------

export type ExecutionState =
  | 'DRAFT'
  | 'READY'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPED'
  | 'ERROR';

export type ExecutionValidationKey =
  | 'strategy_exists'
  | 'strategy_active'
  | 'master_account_exists'
  | 'broker_session_exists'
  | 'broker_session_healthy'
  | 'instrument_mappings_valid';

export interface StrategyExecutionValidationCheck {
  key: ExecutionValidationKey;
  ok: boolean;
  message: string;
}

export interface StrategyExecutionValidationResponse {
  ok: boolean;
  strategyId: string;
  checks: StrategyExecutionValidationCheck[];
  errors: StrategyExecutionValidationCheck[];
  validatedAt: string;
}

export interface StrategyExecutionContext {
  strategyId: string;
  masterAccountId: string;
  broker: Broker;
  status: ExecutionState;
  startedAt: string;
  lastHeartbeat: string;
  lastError?: string | null;
}

export interface StrategyExecutionStatusResponse {
  strategyId: string;
  state: ExecutionState;
  context: StrategyExecutionContext | null;
  lastValidation: StrategyExecutionValidationResponse | null;
}

// -----------------------------
// Trade Event Intake (Sprint 5.1)
// -----------------------------

export type TradeEventStatus =
  | 'RECEIVED'
  | 'NORMALIZED'
  | 'VALIDATED'
  | 'READY'
  | 'DUPLICATE'
  | 'REJECTED';

export type TradeEventSource =
  | 'ZERODHA_POSTBACK'
  | 'FYERS_POSTBACK'
  | 'BROKER_POLL'
  | 'MANUAL_ENTRY'
  | 'UNKNOWN';

export type TradeEventValidationKey =
  | 'shape_valid'
  | 'mandatory_fields_present'
  | 'supported_broker'
  | 'supported_trade_status'
  | 'master_account_exists'
  | 'master_account_connected'
  | 'broker_session_healthy'
  | 'strategy_exists'
  | 'strategy_running'
  | 'instrument_mapping_available'
  | 'not_duplicate';

export interface TradeEventValidationCheck {
  key: TradeEventValidationKey;
  ok: boolean;
  message: string;
}

export interface TradeEventValidationResult {
  ok: boolean;
  checks: TradeEventValidationCheck[];
  errors: TradeEventValidationCheck[];
  validatedAt: string;
}

export type TradeEventReadinessKey =
  | 'validation_passed'
  | 'has_enabled_followers';

export interface TradeEventReadinessCheck {
  key: TradeEventReadinessKey;
  ok: boolean;
  message: string;
}

export interface TradeEventReadinessResult {
  ready: boolean;
  checks: TradeEventReadinessCheck[];
  errors: TradeEventReadinessCheck[];
  reason: string | null;
  assessedAt: string;
}

export interface TradeEvent {
  id: string;
  source: TradeEventSource;
  broker: Broker;
  masterAccountId: string;
  strategyId: string | null;
  brokerOrderId: string;
  brokerExecutionId: string | null;
  brokerSymbol: string;
  instrumentId: string | null;
  contractKey: string | null;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number | null;
  rawStatus: string | null;
  status: TradeEventStatus;
  brokerTimestamp: string | null;
  receivedAt: string;
  raw: unknown;
}

export interface TradeEventRecord {
  event: TradeEvent;
  validation: TradeEventValidationResult | null;
  readiness: TradeEventReadinessResult | null;
  rejectionReason: string | null;
}

export interface TradeEventPipelineSummary {
  bufferSize: number;
  bufferCapacity: number;
  counts: Record<TradeEventStatus, number>;
  latest: TradeEventRecord | null;
}

// ---------------------------------------------------------------------------
// Execution events — real copy-trading fan-out telemetry recorded by
// CopyTradingService. This is the single source of truth for the admin
// Trade Monitor page. Types mirror apps/api/src/copy-trading/execution-event.ts.
// ---------------------------------------------------------------------------

export type ExecutionFollowerStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'SUCCESS'
  | 'FAILED'
  | 'SKIPPED';

export type ExecutionFailureType =
  | 'ORDER_REJECTED'
  | 'IP_WHITELIST'
  | 'INSTRUMENT_NOT_FOUND'
  | 'TOKEN_EXPIRED'
  | 'BROKER_ERROR'
  | 'VALIDATION_FAILED'
  | 'BROKER_UNSUPPORTED'
  | 'NO_BROKER_SESSION'
  | 'SYMBOL_MAPPING_MISSING'
  | 'UNKNOWN';

export type ExecutionEventOutcome =
  | 'NO_ACTIVE_STRATEGY'
  | 'NO_ENABLED_FOLLOWERS'
  | 'FANNED_OUT'
  | 'ERROR';

export interface FollowerExecution {
  id: string;
  followerId: string;
  followerName: string;
  followerEmail: string;
  followerAccountId: string;
  broker: string;
  status: ExecutionFollowerStatus;
  failureType: ExecutionFailureType | null;
  reason: string | null;
  brokerResponse: unknown | null;
  followerSymbol: string | null;
  quantity: number | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ExecutionEvent {
  id: string;
  timestamp: string;
  strategyId: string | null;
  strategyName: string | null;
  masterAccountId: string;
  masterAccountNickname: string | null;
  broker: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  productType: string;
  followersFound: number;
  followers: FollowerExecution[];
  outcome: ExecutionEventOutcome;
  errorReason: string | null;
}

export interface ExecutionEventSummary {
  totalRecorded: number;
  bufferSize: number;
  bufferCapacity: number;
  today: {
    events: number;
    successfulOrders: number;
    failedOrders: number;
    pendingOrders: number;
    followersExecuted: number;
  };
  latest: ExecutionEvent | null;
}

// ---------------------------------------------------------------------------
// Sprint 5.2 — permanent execution audit persistence.
// Types mirror apps/api/src/execution-history/execution-history.service.ts
// ---------------------------------------------------------------------------

export interface ExecutionHistoryRow {
  id: string;
  timestamp: string;
  strategyId: string | null;
  strategyName: string | null;
  masterAccountId: string;
  masterAccountName: string | null;
  masterBroker: string;
  masterSymbol: string;
  masterExchange: string | null;
  masterSegment: string | null;
  masterSide: 'BUY' | 'SELL' | string;
  masterQuantity: number;
  masterPrice: number | null;
  orderType: string | null;
  productType: string | null;
  tradeSource: string | null;
  status: string;
  totalFollowers: number;
  successfulFollowers: number;
  failedFollowers: number;
  skippedFollowers: number;
  processingTimeMs: number | null;
  createdAt: string;
}

export interface ExecutionHistoryFollowerRow {
  id: string;
  executionHistoryId: string;
  followerId: string | null;
  followerEmail: string | null;
  broker: string;
  brokerOrderId: string | null;
  status: string;
  failureType: string | null;
  failureReason: string | null;
  rawBrokerResponse: unknown | null;
  followerSymbol: string | null;
  executedQuantity: number | null;
  executedPrice: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ExecutionHistoryTimelineEntry {
  at: string;
  kind: string;
  label: string;
}

export interface ExecutionHistoryDetail extends ExecutionHistoryRow {
  followers: ExecutionHistoryFollowerRow[];
  timeline: ExecutionHistoryTimelineEntry[];
}

export interface ExecutionHistoryListResponse {
  items: ExecutionHistoryRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ExecutionHistorySummary {
  today: {
    trades: number;
    successful: number;
    failed: number;
    partial: number;
    noStrategy: number;
    noFollowers: number;
    errors: number;
    successPercent: number;
    failurePercent: number;
    followersExecuted: number;
    avgProcessingTimeMs: number | null;
  };
  topFailureReasons: Array<{
    failureType: string;
    count: number;
  }>;
}

export interface ExecutionHistoryListQuery {
  page?: number;
  limit?: number;
  strategy?: string;
  broker?: string;
  symbol?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: string;
}

// ---------------------------------------------------------------------------
// Sprint 5.3 — Position Lifecycle.
// Types mirror apps/api/src/position-lifecycle/lifecycle.types.ts
// ---------------------------------------------------------------------------

export type PositionLifecycleState =
  | 'PENDING'
  | 'PARTIALLY_FILLED'
  | 'OPEN'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXITING'
  | 'CLOSED';

export interface PositionLifecycleTimelineEntry {
  at: string;
  kind: string;
  label: string;
  details?: Record<string, unknown>;
}

export interface PositionFollowerLink {
  followerAccountId: string;
  followerId: string | null;
  followerEmail: string | null;
  broker: Broker;
  brokerOrderId: string;
  followerSymbol: string | null;
  quantity: number | null;
  createdAt: string;
  lastAction: string;
  lastActionAt: string;
  lastActionOk: boolean;
  lastActionMessage: string | null;
}

export interface PositionLifecycleSummary {
  key: string;
  broker: Broker;
  masterAccountId: string;
  brokerOrderId: string;
  strategyId: string | null;
  symbol: string;
  exchange: string | null;
  side: 'BUY' | 'SELL';
  quantity: number;
  filledQuantity: number;
  pendingQuantity: number;
  price: number | null;
  triggerPrice: number | null;
  orderType: string | null;
  productType: string | null;
  state: PositionLifecycleState;
  followerCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PositionLifecycleDetail extends PositionLifecycleSummary {
  followers: PositionFollowerLink[];
  timeline: PositionLifecycleTimelineEntry[];
}

export interface PositionLifecycleListResponse {
  count: number;
  items: PositionLifecycleSummary[];
}

// ---------------------------------------------------------------------------
// Sprint 5.4 — Manual Trade Execution.
// Types mirror apps/api/src/manual-trading/manual-trade.types.ts
// ---------------------------------------------------------------------------

export type ManualTradeStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXECUTING_FOLLOWERS'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED';

export type ManualTradeSide = 'BUY' | 'SELL';
export type ManualTradeOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type ManualTradeProduct = 'CNC' | 'MIS' | 'NRML';
export type ManualTradeValidity = 'DAY' | 'IOC';

export type ManualTradeValidationKey =
  | 'master_account_exists'
  | 'master_account_connected'
  | 'broker_session_healthy'
  | 'strategy_active'
  | 'strategy_belongs_to_master'
  | 'strategy_has_enabled_followers'
  | 'instrument_exists'
  | 'broker_symbol_mapping_exists'
  | 'required_fields_present';

export interface ManualTradeValidationCheck {
  key: ManualTradeValidationKey;
  ok: boolean;
  message: string;
}

export interface ManualTradeValidationResult {
  ok: boolean;
  checks: ManualTradeValidationCheck[];
  errors: ManualTradeValidationCheck[];
  validatedAt: string;
}

export interface ManualTradeFollowerOutcome {
  followerId: string;
  followerEmail: string;
  broker: string;
  status: 'PENDING' | 'EXECUTING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  failureType: string | null;
  reason: string | null;
  followerSymbol: string | null;
  quantity: number | null;
  brokerOrderId: string | null;
}

export interface ManualTradeRecord {
  id: string;
  masterAccountId: string;
  masterAccountName: string | null;
  strategyId: string;
  strategyName: string | null;
  broker: Broker;
  exchange: string;
  symbol: string;
  side: ManualTradeSide;
  orderType: ManualTradeOrderType;
  quantity: number;
  product: ManualTradeProduct;
  price: number | null;
  triggerPrice: number | null;
  validity: ManualTradeValidity;
  status: ManualTradeStatus;
  brokerOrderId: string | null;
  brokerResponse: unknown | null;
  rejectionReason: string | null;
  /** Structural classification of the failure (BROKER_ERROR, TOKEN_EXPIRED, …). */
  failureType: string | null;
  /** Stage at which the manual trade failed (broker_placement, broker_error, …). */
  failureStage: string | null;
  validation: ManualTradeValidationResult;
  executionEventId: string | null;
  followersFound: number;
  followers: ManualTradeFollowerOutcome[];
  successfulFollowers: number;
  failedFollowers: number;
  skippedFollowers: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaceManualTradePayload {
  masterAccountId: string;
  strategyId: string;
  exchange: string;
  symbol: string;
  side: ManualTradeSide;
  orderType: ManualTradeOrderType;
  quantity: number;
  product: ManualTradeProduct;
  price?: number;
  triggerPrice?: number;
  validity?: ManualTradeValidity;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'cts_admin_access_token';

export const auth = {
  saveToken(t: string) {
    if (typeof window !== 'undefined') localStorage.setItem(TOKEN_KEY, t);
  },
  getToken() {
    return typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
  },
  clear() {
    if (typeof window !== 'undefined') localStorage.removeItem(TOKEN_KEY);
  },
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as any),
  };

  const token = auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const message = Array.isArray(err.message)
      ? err.message.join(', ')
      : err.message || 'Request failed';
    const error = new Error(message) as Error & { body?: any; status?: number };
    error.body = err;
    error.status = res.status;
    throw error;
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

type AdminTradingAccountDto = TradingAccountDto & {
  user?: { email: string; name: string | null };
};

type AdminStrategyDto = StrategyDto & {
  tradingAccount?: { nickname: string; broker: any; user?: { email: string } };
};

export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<PublicUser>('/auth/me'),

  admin: {
    listUsers: () => request<PublicUser[]>('/admin/users'),

    listTradingAccounts: () =>
      request<AdminTradingAccountDto[]>('/admin/trading-accounts'),

    tradingAccounts: {
      list: () =>
        request<AdminTradingAccountDto[]>('/admin/trading-accounts'),

      get: (id: string) =>
        request<TradingAccountDto>(`/admin/trading-accounts/${id}`),

      create: (payload: CreateTradingAccountPayload) =>
        request<TradingAccountDto>('/admin/trading-accounts', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),

      update: (id: string, payload: UpdateTradingAccountPayload) =>
        request<TradingAccountDto>(`/admin/trading-accounts/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }),

      remove: (id: string) =>
        request<{ ok: true }>(`/admin/trading-accounts/${id}`, {
          method: 'DELETE',
        }),
    },

    listStrategies: () => request<AdminStrategyDto[]>('/admin/strategies'),

    strategies: {
      create: (payload: any) =>
        request('/admin/strategies', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),

      update: (id: string, payload: any) =>
        request(`/admin/strategies/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }),

      remove: (id: string) =>
        request(`/admin/strategies/${id}`, {
          method: 'DELETE',
        }),
    },

    listFollowers: () => request<FollowerDto[]>('/admin/followers'),

    listSubscriptions: () =>
      request<
        (SubscriptionDto & {
          followerUser?: { email: string; name: string | null };
        })[]
      >('/admin/subscriptions'),

    masterAccounts: {
      list: () => request<TradingAccountDto[]>('/admin/master-accounts'),

      get: (id: string) =>
        request<TradingAccountDto>(`/admin/master-accounts/${id}`),

      dashboard: (id: string) =>
        request<any>(`/admin/master-accounts/${id}/dashboard`),

      sessionHealth: (id: string) =>
        request<any>(`/admin/master-accounts/${id}/session-health`),

      disconnect: (id: string) =>
        request<{ ok: true; broker: string; connectionStatus: string }>(
          `/admin/master-accounts/${id}/disconnect`,
          { method: 'POST' },
        ),

      create: (payload: CreateTradingAccountPayload) =>
        request<TradingAccountDto>('/admin/master-accounts', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),

      update: (id: string, payload: UpdateTradingAccountPayload) =>
        request<TradingAccountDto>(`/admin/master-accounts/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }),

      remove: (id: string) =>
        request<{ ok: true }>(`/admin/master-accounts/${id}`, {
          method: 'DELETE',
        }),

      enable: (id: string) =>
        request<TradingAccountDto>(`/admin/master-accounts/${id}/enable`, {
          method: 'POST',
        }),

      disable: (id: string) =>
        request<TradingAccountDto>(`/admin/master-accounts/${id}/disable`, {
          method: 'POST',
        }),
    },

    instruments: {
      search: (query: AdminInstrumentSearchQuery) => {
        const params = new URLSearchParams();
        params.set('q', query.q);
        if (query.broker) params.set('broker', query.broker);
        if (query.exchange) params.set('exchange', query.exchange);
        if (query.segment) params.set('segment', query.segment);
        if (query.instrumentType) params.set('instrumentType', query.instrumentType);
        if (query.limit != null) params.set('limit', String(query.limit));
        return request<AdminInstrumentSearchResponse>(
          `/admin/instruments/search?${params.toString()}`,
        );
      },

      /**
       * Sprint 5.4.1 — Broker-scoped, relevance-ranked search that
       * powers the Manual Trading symbol autocomplete.
       */
      manualSearch: (
        broker: Broker,
        q: string,
        opts: { limit?: number; signal?: AbortSignal } = {},
      ) => {
        const params = new URLSearchParams({ broker, q });
        if (opts.limit != null) params.set('limit', String(opts.limit));
        return request<ManualInstrumentSearchResponse>(
          `/admin/instruments/manual-search?${params.toString()}`,
          opts.signal ? { signal: opts.signal } : undefined,
        );
      },

      lookup: (broker: Broker, symbol: string) => {
        const params = new URLSearchParams({ broker, symbol });
        return request<AdminInstrumentSearchRow>(
          `/admin/instruments/lookup?${params.toString()}`,
        );
      },

      resolve: (contractKey: string) => {
        const params = new URLSearchParams({ contractKey });
        return request<AdminInstrumentResolved>(
          `/admin/instruments/resolve?${params.toString()}`,
        );
      },

      translate: (fromBroker: Broker, fromSymbol: string, toBroker: Broker) => {
        const params = new URLSearchParams({ fromBroker, fromSymbol, toBroker });
        return request<AdminInstrumentTranslateResponse>(
          `/admin/instruments/translate?${params.toString()}`,
        );
      },

      listBrokers: (instrumentId: string) =>
        request<AdminInstrumentBrokerMapping[]>(
          `/admin/instruments/${instrumentId}/brokers`,
        ),

      importOne: (broker: Broker) =>
        request<AdminInstrumentImportOneResponse>(
          `/admin/instruments/import/${broker}`,
          { method: 'POST' },
        ),

      importAll: () =>
        request<AdminInstrumentImportAllResponse>(
          `/admin/instruments/import`,
          { method: 'POST' },
        ),

      stats: () =>
        request<AdminInstrumentStatsResponse>(`/admin/instruments/stats`),
    },

    strategyExecution: {
      status: (strategyId: string) =>
        request<StrategyExecutionStatusResponse>(
          `/admin/strategy-execution/${strategyId}/status`,
        ),
      validate: (strategyId: string) =>
        request<StrategyExecutionValidationResponse>(
          `/admin/strategy-execution/${strategyId}/validate`,
          { method: 'POST' },
        ),
      start: (strategyId: string) =>
        request<StrategyExecutionStatusResponse>(
          `/admin/strategy-execution/${strategyId}/start`,
          { method: 'POST' },
        ),
      pause: (strategyId: string) =>
        request<StrategyExecutionStatusResponse>(
          `/admin/strategy-execution/${strategyId}/pause`,
          { method: 'POST' },
        ),
      resume: (strategyId: string) =>
        request<StrategyExecutionStatusResponse>(
          `/admin/strategy-execution/${strategyId}/resume`,
          { method: 'POST' },
        ),
      stop: (strategyId: string) =>
        request<StrategyExecutionStatusResponse>(
          `/admin/strategy-execution/${strategyId}/stop`,
          { method: 'POST' },
        ),
    },

    tradeEvents: {
      summary: () =>
        request<TradeEventPipelineSummary>(`/admin/trade-events/summary`),
      recent: (limit = 20) =>
        request<{ items: TradeEventRecord[] }>(
          `/admin/trade-events/recent?limit=${limit}`,
        ),
      ready: (limit = 20) =>
        request<{ items: TradeEventRecord[] }>(
          `/admin/trade-events/ready?limit=${limit}`,
        ),
      latest: () =>
        request<{ record: TradeEventRecord | null }>(
          `/admin/trade-events/latest`,
        ),
    },

    executionEvents: {
      summary: () =>
        request<ExecutionEventSummary>(`/admin/execution-events/summary`),
      recent: (limit = 50) =>
        request<{ items: ExecutionEvent[] }>(
          `/admin/execution-events/recent?limit=${limit}`,
        ),
      byId: (id: string) =>
        request<{ event: ExecutionEvent | null }>(
          `/admin/execution-events/${encodeURIComponent(id)}`,
        ),
    },

    executionHistory: {
      summary: () =>
        request<ExecutionHistorySummary>(`/admin/execution-history/summary`),
      list: (query: ExecutionHistoryListQuery = {}) => {
        const params = new URLSearchParams();
        const q = query as Record<string, unknown>;
        for (const key of Object.keys(q)) {
          const v = q[key];
          if (v === undefined || v === null || v === '') continue;
          params.set(key, String(v));
        }
        const qs = params.toString();
        return request<ExecutionHistoryListResponse>(
          `/admin/execution-history${qs ? `?${qs}` : ''}`,
        );
      },
      byId: (id: string) =>
        request<ExecutionHistoryDetail>(
          `/admin/execution-history/${encodeURIComponent(id)}`,
        ),
    },

    positionLifecycle: {
      positions: (status?: 'OPEN') => {
        const qs = status ? `?status=${status}` : '';
        return request<PositionLifecycleListResponse>(
          `/admin/position-lifecycle/positions${qs}`,
        );
      },
      position: (key: string) =>
        request<PositionLifecycleDetail>(
          `/admin/position-lifecycle/positions/${encodeURIComponent(key)}`,
        ),
    },

    manualTrading: {
      place: (payload: PlaceManualTradePayload) =>
        request<ManualTradeRecord>(`/admin/manual-trading/place`, {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      recent: (limit = 20) =>
        request<{ items: ManualTradeRecord[] }>(
          `/admin/manual-trading/recent?limit=${limit}`,
        ),
      byId: (id: string) =>
        request<ManualTradeRecord>(
          `/admin/manual-trading/${encodeURIComponent(id)}`,
        ),
    },
  },
};