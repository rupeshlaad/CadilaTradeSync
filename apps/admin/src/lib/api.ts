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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'cts_admin_access_token';

export const auth = {
  saveToken(t: string) { if (typeof window !== 'undefined') localStorage.setItem(TOKEN_KEY, t); },
  getToken() { return typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null; },
  clear() { if (typeof window !== 'undefined') localStorage.removeItem(TOKEN_KEY); },
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as any) };
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

type AdminTradingAccountDto = TradingAccountDto & { user?: { email: string; name: string | null } };
type AdminStrategyDto = StrategyDto & { tradingAccount?: { nickname: string; broker: any; user?: { email: string } } };

export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<PublicUser>('/auth/me'),

  admin: {
    listUsers: () => request<PublicUser[]>('/admin/users'),
    listTradingAccounts: () => request<AdminTradingAccountDto[]>('/admin/trading-accounts'),
    listStrategies: () => request<AdminStrategyDto[]>('/admin/strategies'),
    listFollowers: () => request<FollowerDto[]>('/admin/followers'),
    listSubscriptions: () => request<(SubscriptionDto & { followerUser?: { email: string; name: string | null } })[]>('/admin/subscriptions'),

    masterAccounts: {
      list: () => request<TradingAccountDto[]>('/admin/master-accounts'),
      get: (id: string) => request<TradingAccountDto>(`/admin/master-accounts/${id}`),
      create: (payload: CreateTradingAccountPayload) =>
        request<TradingAccountDto>('/admin/master-accounts', { method: 'POST', body: JSON.stringify(payload) }),
      update: (id: string, payload: UpdateTradingAccountPayload) =>
        request<TradingAccountDto>(`/admin/master-accounts/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
      remove: (id: string) => request<{ ok: true }>(`/admin/master-accounts/${id}`, { method: 'DELETE' }),
      enable: (id: string) => request<TradingAccountDto>(`/admin/master-accounts/${id}/enable`, { method: 'POST' }),
      disable: (id: string) => request<TradingAccountDto>(`/admin/master-accounts/${id}/disable`, { method: 'POST' }),
    },
  },
};
