export enum Role {
  ADMIN = 'ADMIN',
  USER = 'USER',
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
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

export const APP_NAME = 'Cadila TradeSync';
export const APP_SHORT_NAME = 'CTS';
