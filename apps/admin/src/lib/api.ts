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
  status: TradeEventStatus;
  brokerTimestamp: string | null;
  receivedAt: string;
  raw: unknown;
}

export interface TradeEventRecord {
  event: TradeEvent;
  validation: TradeEventValidationResult | null;
  rejectionReason: string | null;
}

export interface TradeEventPipelineSummary {
  bufferSize: number;
  bufferCapacity: number;
  counts: Record<TradeEventStatus, number>;
  latest: TradeEventRecord | null;
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
      latest: () =>
        request<{ record: TradeEventRecord | null }>(
          `/admin/trade-events/latest`,
        ),
    },
  },
};