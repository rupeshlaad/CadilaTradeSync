# CTS — Copy Trading SaaS (PRD)

## Product
pnpm monorepo copy-trading platform. Master (admin) and Follower (web) portals
built on Next.js 15; NestJS 11 API; PostgreSQL + Prisma 6; Redis. Multi-broker:
Zerodha, Fyers, Shoonya, ICICI Direct (Breeze API).

## Architecture
```
/app
├── apps/
│   ├── admin/  Next.js Master portal
│   ├── web/    Next.js Follower portal
│   └── api/    NestJS backend
├── packages/{shared, ui}
└── database/prisma
```
Shared broker engine: `apps/api/src/brokers/broker.service.ts` — broker-aware
lookups, adapter selection, and SDK-driven normalization (funds/holdings/
positions/orders/trades). Dashboard UI: `packages/ui/src/follower/broker-dashboard.tsx`.

### Project rules (env constraints)
- DO NOT start Postgres/Redis/Docker/dev servers or run Prisma migrations here.
- Verify via `pnpm --filter @cts/api typecheck`, `pnpm -r build`, and a boot
  sanity check (`node apps/api/dist/main.js` — expected to crash on DB connect
  after modules resolve).
- pnpm is not persisted across pod restarts: re-activate via
  `corepack enable && corepack prepare pnpm@latest --activate`.
- Git writes: commit on a feature branch, merge `--no-ff` into local `main`;
  user pushes via the "Save to Github" button.

## Implemented
- Sprint 6.1.x: broker-aware session lifecycle, capability/onboarding metadata,
  SDK-driven dashboard normalization for Zerodha/Fyers/Shoonya.
- Sprint 6.2.0/6.2.1: ICICI Direct (Breeze) adapter + manual API-Session
  authentication (replaced OAuth, which failed locally on SameSite=None).
  Endpoint: `POST /api/brokers/icici/connect-session`.
- **Sprint 6.2.2 (2026-06-08): ICICI Direct live dashboard data — COMPLETE.**
  - Holdings via `portfolioholdings`; LTP from `current_market_price` or
    quotes-enriched; `currentValue = qty×ltp`, `pnl = (ltp−avg)×qty` derived.
  - Positions: quote-enriched LTP; derive P&L when broker omits it.
  - Orders: added `product` (product_type) + `filledQuantity`
    (quantity − pending_quantity).
  - Trades: added `product`; price=`average_cost`, time=`trade_date`.
  - Adapter: per-request quote cache dedupes LTP lookups (Breeze has no bulk
    quote endpoint; ~10 req/sec limit).
  - Verified: typecheck + `pnpm -r build` + boot sanity all pass.
    Live broker calls tested locally by user against real Breeze sessions.

## Backlog / Roadmap
- P1: Dashboard UI columns for order `product`/`filledQuantity` and trade
  `product` (normalizers already emit them; UI does not yet render).
- P2: Orders/trades exchange + date-range filters (Breeze needs exchange_code +
  from/to; currently defaults to NSE + current day).
- P2: ICICI order execution (placeOrder/modify/cancel are stubs; Breeze
  auto-converts market → aggressive limit).
- P2: Response caching + per-account refresh throttle for Breeze rate limits.
