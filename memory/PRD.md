# CTS — External repo sprint work (context note)

This Emergent session operates on the EXTERNAL GitHub project
`rupeshlaad/CadilaTradeSync` (pnpm monorepo: NestJS 11 API + Next.js 15
web/admin + Prisma 6 + PostgreSQL + Redis). The working clone lives at
`/root/CadilaTradeSync` (NOT the `/app` scaffold). Full product PRD is in
`/root/CadilaTradeSync/memory/PRD.md`.

Environment rules for this project (user-imposed): static code changes +
workspace builds only. Do NOT run Postgres/Redis/Docker/dev servers, do NOT
run Prisma migrations, do NOT invoke runtime/browser tests. Validation gate:
`pnpm --filter @cts/api typecheck` + `pnpm -r build` + `node dist/main.js`
boot sanity (expected to crash at PrismaModule on missing DATABASE_URL after
all modules resolve). Git: feature branch → `--no-ff` merge into local `main`;
GitHub push done by the user via "Save to Github" / their local remote.

## Sprint 6.2.6 (2026-06) — ICICI Direct production order payload compliance — DONE (static)
- Root cause of manual order-placement failure: Breeze rejects `user_remark`
  containing spaces/special chars. Payload sent `'CTS Manual Trade'`
  (order-actions Exit sent `'CTS Exit'`).
- Added shared broker order-mapping layer `apps/api/src/brokers/order-mapping`:
  `internal-order.ts` (broker-neutral DTO), `user-remark.ts`
  (`sanitizeUserRemark`, alphanumeric-only), `zerodha/fyers/icici-order.mapper.ts`.
- ICICI Breeze payload now fully compliant: sanitized remark; instrument-aware
  product (cash/margin/futures/futureplus/options/optionplus); right /
  strike_price / expiry_date populated for derivatives; uppercased
  exchange_code; SL-M emulated as marketable stoploss (price = trigger).
- Removed duplicated broker mappers from ManualTradeService, OrderActionsService,
  CopyTradingService, PositionSynchronizationService — one mapping source.
  Fixed inverted Fyers SL/SL-M codes in position-sync (SL=4, SL-M=3).
- Validator now surfaces `resolvedInstrument` to drive the ICICI payload.
- Verified: typecheck PASS, `pnpm -r build` 5/5 PASS, boot sanity PASS.
- Feature commit 5fd4c39; merge ab07735 on local `main`.
- NOT verified live: manual order placement against real Breeze prod (requires
  the user's daily Breeze session + running Postgres) — to confirm on local run.
- Testing agent intentionally NOT invoked (user instruction + app not runnable
  in this pod without DB and a live broker session).
