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
### Sprint 6.2.4 (2026-08-06): ICICI Direct standardization — COMPLETE
- Root cause of Master vs User data divergence: the two portals called
  different service methods. Follower `GET /trading-accounts/:id/dashboard`
  → `getBrokerDashboard()` (normalized DTO); Master
  `GET /admin/master-accounts/:id/dashboard` → raw `getDashboard()` (SDK
  envelopes). The admin dashboard page then re-mapped raw broker fields itself
  (Zerodha-shaped keys), so ICICI's `stock_code`/`current_market_price` showed
  as blank symbols, no derived P&L/value, incomplete profile. Two pipelines, one
  of which bypassed normalization.
- Fix (one pipeline): Master dashboard endpoint now returns
  `getBrokerDashboard()` + added `:id/section/:section`; admin dashboard page
  renders the shared `@cts/ui` `BrokerDashboardPanel` fed the normalized
  `BrokerDashboardDto` (all portal-specific mapping deleted). Both portals now
  render identical data for every broker.
- Add Broker standardized: shared `BrokerAccountForm` (`@cts/ui`) consumed by
  both portals; conditional credential fields (vendorCode/password/TOTP) driven
  by one `brokerFieldVisibility` map. Only the connect/auth action differs.
  Master accounts now persist `vendorCode`; master `redact()` no longer leaks
  `encryptedVendorCode`.
- Instrument download for ICICI Direct (Breeze SecurityMaster.zip) and Shoonya
  (`<EXCH>_symbols.txt.zip`) via a dependency-free `zip-reader.ts` (zlib
  inflateRaw). Same importer contract/flow as Zerodha/Fyers; wired into
  InstrumentModule, admin + legacy import controllers, stats snapshot
  (icici/shoonya counts + lastRefresh), and the admin Instruments UI
  (Import ICICI / Import Shoonya buttons + stat cards).
- Verified: `pnpm --filter @cts/api typecheck` + `pnpm -r build` (5/5) + boot
  sanity (all modules resolve) all pass. Live broker-master schema mapping for
  ICICI/Shoonya to be confirmed on the user's local run with real endpoints.
- Feature commit ce8b5b8, merge 954a9c3.


### Sprint 6.2.3 (2026-06-08): ICICI Direct SDK compliance — 401 fix — COMPLETE
- Root cause: `ensureSession()` base64-decoded the customerdetails `session_token`
  and used the part after `:` as `X-SessionToken`. Breeze REST requires the raw
  base64 `session_token` blob verbatim (decoded `user_id:key` split is only for
  websocket auth). Split form → 401 on every checksum call
  (funds/holdings/positions/orders/trades); profile worked (customerdetails has
  no X-SessionToken).
- Fix (adapter only): use the base64 blob verbatim for `X-SessionToken`; decode
  only to extract `user_id`. Added per-call request/response logging
  (endpoint/method/masked headers/body/status/raw response).
- Live probe vs real Breeze prod confirmed: split→"Index was outside the bounds
  of the array" (malformed); base64 blob→"Public Key does not exist" (format
  accepted, only placeholder app key fails). Real creds will authenticate.
- Commit 3e9ec05, merge 891f577. Full live data verification pending user run
  with real Breeze session.

- P1: Dashboard UI columns for order `product`/`filledQuantity` and trade
  `product` (normalizers already emit them; UI does not yet render).
- P2: Orders/trades exchange + date-range filters (Breeze needs exchange_code +
  from/to; currently defaults to NSE + current day).
- P2: ICICI order execution (placeOrder/modify/cancel are stubs; Breeze
  auto-converts market → aggressive limit).
- P2: Response caching + per-account refresh throttle for Breeze rate limits.
