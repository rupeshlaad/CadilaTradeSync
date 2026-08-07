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

## Sprint 6.2.7 (2026-06) — ICICI Direct stabilization (final code audit) — DONE (static)
Started from a BROKEN half-finished 6.2.7 WIP left uncommitted in the working
tree (build did not compile). Root causes found & fixed:

1. `manual-trade.service.ts::placeOnMaster` — the `if (broker === Broker.ZERODHA) {`
   guard was lost when the debug-log block was inserted → stray `}` closed the
   method early, FYERS/ICICI branches became invalid (BUILD BREAK). Restored.
2. `broker-lifecycle-normalizer.ts` — `normalizeRawOrder` called `normalizeIcici`
   which was NEVER defined (BUILD BREAK). Added `normalizeIcici` + `mapIciciStatus`
   (Executed→COMPLETE, Ordered/Requested/Queued→OPEN, Partially Executed→PARTIAL,
   Cancelled→CANCELLED, Rejected/Expired→REJECTED, action Buy/Sell→BUY/SELL,
   filledQty = quantity − pending_quantity). ROOT CAUSE of "trades executed
   directly in ICICI are NOT detected": before this, ICICI orders normalized to
   null and never reached the lifecycle → copy engine.
3. `master-watcher.service.ts` — polling was hardcoded to `Broker.ZERODHA`
   (session lookup + ZerodhaAdapter + ingest). ICICI/Fyers/Shoonya masters were
   never polled. Now resolves the account's OWN broker and builds the matching
   adapter (ICICI gets api key/secret + session token; Shoonya gets uid). Orders
   envelope handled (array / orderBook / data). SECOND ROOT CAUSE of the copy
   detection gap.
4. `icici-order.mapper.ts` — equity product now resolves to `cash` for ALL of
   CNC/MIS/NRML. Breeze rejects `margin` for nse/bse cash without account
   entitlement ("Product-type should be either 'cash','eatm' ..."). This is the
   exact reported rejection. Single `sanitizeUserRemark` (alphanumeric only) is
   the ONLY producer of `user_remark`; the "CTS Manual Trade" in the user's log
   was from a stale pre-6.2.6 build (mapper sanitizes it to `CTSManualTrade`).

Field audit vs official Breeze `place_order` (docs + Breeze-Python-SDK): stock_code,
exchange_code(UPPER), product(cash/futures/options + *plus), action(buy/sell),
order_type(limit/market/stoploss), quantity, price("" for market), stoploss(trigger),
validity(day/ioc), validity_date("" — no execution impact per docs),
disclosed_quantity("0"), expiry_date(ISO, derivatives only), right(call/put/others),
strike_price(options), user_remark(alphanumeric) — all compliant.

Verified: typecheck PASS; `pnpm -r build` 5/5 PASS; `node dist/main.js` boot
sanity PASS (all modules incl. master-watcher/normalizer resolve, crash only at
PrismaModule/DATABASE_URL); 27-case pure-logic harness PASS (product/order_type/
validity/price/stoploss/remark + ICICI order-status normalization).
Feature commit 8235c43; merge commit 6535ff1 on local `main`.

NOT verifiable in this pod (no Postgres/Redis, no user's daily Breeze session) —
must be confirmed by the user on their local run: live ICICI equity BUY/SELL,
CNC/MIS/LIMIT/MARKET/SL/SL-M, order-appears-in-broker, ICICI-terminal detection +
copy fan-out. INSTRUMENT-MASTER count reconciliation (SecurityMaster.zip vs
Instrument/InstrumentBroker) and the 100 equity/futures/options cross-broker
mapping validation ALSO require the DB + import run — NOT done statically; still
open. testing_agent NOT invoked: the app cannot boot past PrismaModule here.
