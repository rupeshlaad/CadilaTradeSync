/**
 * Sprint 6.2.8 — `user_remark` sanitizer (single source of truth).
 *
 * The ICICI Direct (Breeze) `place_order` API rejects a `user_remark` that
 * contains spaces or special characters ("CTS Manual Trade" / "CTS Exit" both
 * fail). Breeze accepts only a short alphanumeric tag. Every producer of an
 * ICICI order payload runs its remark through THIS function so the rejection
 * can never regress from a stray literal anywhere in the codebase.
 */

const DEFAULT_REMARK = 'CTSTrade';

/** Breeze practical cap for user_remark; keep the tag short + alphanumeric. */
const MAX_LENGTH = 20;

export function sanitizeUserRemark(
  input?: string | null,
  fallback: string = DEFAULT_REMARK,
): string {
  const cleaned = String(input ?? '').replace(/[^A-Za-z0-9]/g, '');
  const safeFallback = fallback.replace(/[^A-Za-z0-9]/g, '') || DEFAULT_REMARK;
  const result = cleaned.length > 0 ? cleaned : safeFallback;
  return result.slice(0, MAX_LENGTH);
}
