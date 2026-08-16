import { ConfigService } from '@nestjs/config';

/**
 * Sprint 1 — Single source for the JWT secret with NO insecure fallback.
 * Production configuration MUST fail fast if JWT_SECRET is missing or a known
 * placeholder, instead of silently signing tokens with "change-me".
 */
const FORBIDDEN_SECRETS = new Set(['change-me', 'changeme', 'secret', '']);

export function getJwtSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET');
  if (!secret || FORBIDDEN_SECRETS.has(secret.trim().toLowerCase())) {
    throw new Error(
      'JWT_SECRET is not configured (or uses an insecure placeholder). ' +
        'Set a strong, unique JWT_SECRET in the API environment before starting.',
    );
  }
  return secret;
}

export function getJwtExpiresIn(config: ConfigService): string {
  return config.get<string>('JWT_EXPIRES_IN', '7d');
}
