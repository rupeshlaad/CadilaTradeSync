# CTS Test Credentials (local Sprint 3.1 test environment)

## Services running locally
- API:   http://localhost:4000   (NestJS, `pnpm start:dev` in apps/api)
- Admin: http://localhost:3001   (Next.js dev, `pnpm dev` in apps/admin)
- PostgreSQL: localhost:5432 (started via `service postgresql start`)

## Admin user (already ADMIN role in DB)
- Email:    admin@cts.local
- Password: Admin@12345

Login endpoint: POST http://localhost:4000/auth/login  (JSON: {"email","password"})
Auth token is stored client-side in localStorage under `cts.admin.token`.
Admin dashboard requires this token to fetch data (see apps/admin/src/lib/api.ts).

## Notes
- Redis is NOT running; ioredis reconnect errors in API log are safe to ignore
  for this sprint (do not affect OAuth callback redirect behaviour or the
  Master Accounts page).
- Zerodha API keys are dummy values — real OAuth cannot complete end-to-end.
  Only the failure-redirect paths and URL-error-hydration are directly testable.
