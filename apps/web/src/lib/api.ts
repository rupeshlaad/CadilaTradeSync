'use client';

import type {
  PublicUser,
  AuthResponse,
  TradingAccountDto,
  CreateTradingAccountPayload,
  UpdateTradingAccountPayload,
  StrategyDto,
  CreateStrategyPayload,
  UpdateStrategyPayload,
  FollowerDto,
  SubscribeStrategyPayload,
  SubscriptionDto,
} from '@cts/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'cts_access_token';

export const auth = {
  saveToken(token: string) {
    if (typeof window !== 'undefined') localStorage.setItem(TOKEN_KEY, token);
  },
  getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(TOKEN_KEY);
  },
  clear() {
    if (typeof window !== 'undefined') localStorage.removeItem(TOKEN_KEY);
  },
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(Array.isArray(err.message) ? err.message.join(', ') : err.message || 'Request failed');
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // ---------- Auth ----------
  register: (email: string, password: string, name?: string) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<PublicUser>('/auth/me'),

  // ---------- Trading Accounts ----------
  tradingAccounts: {
    list: () => request<TradingAccountDto[]>('/trading-accounts'),
    get: (id: string) => request<TradingAccountDto>(`/trading-accounts/${id}`),
    create: (payload: CreateTradingAccountPayload) =>
      request<TradingAccountDto>('/trading-accounts', { method: 'POST', body: JSON.stringify(payload) }),
    update: (id: string, payload: UpdateTradingAccountPayload) =>
      request<TradingAccountDto>(`/trading-accounts/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    remove: (id: string) => request<{ ok: true }>(`/trading-accounts/${id}`, { method: 'DELETE' }),
    enable: (id: string) => request<TradingAccountDto>(`/trading-accounts/${id}/enable`, { method: 'POST' }),
    disable: (id: string) => request<TradingAccountDto>(`/trading-accounts/${id}/disable`, { method: 'POST' }),
    // Sprint 6.1 / 6.1.2 — broker session lifecycle for follower accounts.
    disconnect: (id: string) =>
      request<{ ok: boolean; broker: string; connectionStatus: string }>(
        `/trading-accounts/${id}/disconnect`,
        { method: 'POST' },
      ),
    sessionHealth: (id: string) =>
      request<import('@cts/shared').BrokerSessionHealthDto>(
        `/trading-accounts/${id}/session-health`,
      ),
    // Sprint 6.1.2 — live broker verification (profile / entitlements / funds).
    brokerInfo: (id: string) =>
      request<import('@cts/shared').BrokerVerifyInfoDto>(
        `/trading-accounts/${id}/broker-info`,
      ),
    // Sprint 6.1.5 — full SDK-driven operational dashboard.
    dashboard: (id: string) =>
      request<import('@cts/shared').BrokerDashboardDto>(
        `/trading-accounts/${id}/dashboard`,
      ),
    // Sprint 6.1.5 — granular per-section live refresh.
    section: (id: string, section: import('@cts/shared').BrokerDashboardSection) =>
      request<import('@cts/shared').BrokerSectionResponse>(
        `/trading-accounts/${id}/section/${section}`,
      ),
    // Sprint 6.1.5 — broker capability/onboarding catalog.
    brokerCatalog: () =>
      request<import('@cts/shared').BrokerCatalogEntry[]>(
        `/trading-accounts/meta/broker-catalog`,
      ),
  },

  // ---------- Follower Onboarding & Dashboard header (Sprint 6.1) ----------
  follower: {
    onboardingStatus: () =>
      request<import('@cts/shared').FollowerOnboardingStatusDto>(
        '/follower/onboarding-status',
      ),
    dashboardSummary: () =>
      request<import('@cts/shared').FollowerDashboardSummaryDto>(
        '/follower/dashboard-summary',
      ),
  },


  // ---------- Strategies ----------
  strategies: {
    list: () => request<StrategyDto[]>('/strategies'),
    marketplace: () => request<StrategyDto[]>('/strategies/marketplace'),
    get: (id: string) => request<StrategyDto>(`/strategies/${id}`),
    // Sprint 6.0 — Strategy Intelligence summary (presentation-only).
    summary: (id: string) =>
      request<import('@cts/shared').StrategySummaryDto>(
        `/strategies/${encodeURIComponent(id)}/summary`,
      ),
    create: (payload: CreateStrategyPayload) =>
      request<StrategyDto>('/strategies', { method: 'POST', body: JSON.stringify(payload) }),
    update: (id: string, payload: UpdateStrategyPayload) =>
      request<StrategyDto>(`/strategies/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    remove: (id: string) => request<{ ok: true }>(`/strategies/${id}`, { method: 'DELETE' }),
  },

  // ---------- Followers ----------
  followers: {
    listAsOwner: () => request<FollowerDto[]>('/followers/my-strategies'),
    listMine: () => request<FollowerDto[]>('/followers/mine'),
    subscribe: (payload: SubscribeStrategyPayload) =>
      request<FollowerDto>('/followers/subscribe', { method: 'POST', body: JSON.stringify(payload) }),
    unsubscribe: (id: string) => request<{ ok: true }>(`/followers/${id}`, { method: 'DELETE' }),
  },

  // ---------- Subscriptions ----------
  subscriptions: {
    list: () => request<SubscriptionDto[]>('/subscriptions'),
    cancel: (id: string) => request<SubscriptionDto>(`/subscriptions/${id}`, { method: 'DELETE' }),
  },
};
