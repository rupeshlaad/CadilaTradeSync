'use client';
import { PublicUser, AuthResponse } from '@cts/shared';

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
  return res.json();
}

export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<PublicUser>('/auth/me'),
  listUsers: () => request<PublicUser[]>('/users'),
};
