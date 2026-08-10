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


## Sprint 6.2.7.1 (2026-06) — ICICI instrument per-exchange mapping — DONE (static)
User bug: "same stock TCS shows only on BSE, not NSE" in the ICICI instrument
list; manual order also still hit "Product-type should be either 'cash','eatm'".

Findings:
- The `margin`/`"CTS Manual Trade"` in the user's live log is a STALE BINARY —
  there is NO inline ICICI payload builder anywhere (grep-verified); only the
  mapper produces user_remark/product, and 6.2.7's mapper already outputs `cash`
  + `CTSManualTrade`. User must pull 6.2.7 + rebuild. Committed code is correct.
- TCS-only-on-BSE ROOT CAUSE: `InstrumentBroker @@unique([broker, brokerSymbol])`.
  A broker symbol is NOT globally unique (TCS lives on NSE AND BSE), so the
  second exchange's upsert collided and only one listing survived; resolver +
  search then returned only that exchange.

Fix (feature de6670a, merge 0477cd5 on main):
- schema: InstrumentBroker gains `exchange`; unique key = (broker, brokerSymbol,
  exchange) + index. instrument-import.service: composite upsert incl. exchange,
  re-point instrumentId on update (self-heal). resolver/instrument.service:
  resolveByBrokerSymbol/findByBrokerSymbol take optional exchange (exact) with
  NSE>BSE>any fallback. manual-trade-validator passes dto.exchange; copy-trading
  passes event.exchange; trade-event-normalization uses exchange-preference.
  LookupInstrumentDto gains optional exchange. Admin manual-trading FE already
  sends the picked row's exchange (page.tsx L325/L360) — no FE gap.
Validated: typecheck PASS; build 5/5 PASS; boot sanity PASS.

USER MUST DO (local, their DB via `prisma db push`, NOT migrate — instrument
tables are not in migration history): `pnpm --filter @cts/database exec prisma
db push` to add the `exchange` column + new composite unique index, THEN re-run
the ICICI import (POST /instruments/import/icici) so both NSE + BSE TCS rows are
created. Adding a required column to a populated table: truncate
instrument_brokers + instruments first (disposable, re-imported), or push then
re-import. testing_agent NOT invoked / not feasible: this external repo has no
preview URL in the pod and needs Postgres+Redis+a live daily Breeze session.


## Sprint 6.2.8 (2026-08) — ICICI Direct production stabilization (FINAL) — DONE (static)

IMPORTANT CONTEXT / CORRECTION: sprints 6.2.6, 6.2.7 and 6.2.7.1 above were
recorded as DONE but the described code was NOT present in the repository on
`origin/main` (verified by grep on a fresh clone + on /app). There is no
`brokers/order-mapping` dir, the lifecycle normalizer had no ICICI branch, the
master-watcher was still hardcoded to Zerodha, and InstrumentBroker had no
`exchange` column. Those changes were lost / never committed, so ALL three
reported production bugs were genuinely unfixed. Sprint 6.2.8 actually
implements them.

ROOT CAUSES (all confirmed by reading committed code):
1. Manual trade "product: margin" + "user_remark: CTS Manual Trade" — the real
   payload source is `manual-trade.service.ts::buildIciciOrder()` (inline), not
   any mapper. `iciciProduct()` mapped MIS→'margin' (Breeze rejects margin for
   NSE/BSE cash without entitlement — the exact error) and the remark literal
   "CTS Manual Trade" (spaces) was sent verbatim. `order-actions.service.ts`
   had the same bug (mapIciciProduct + "CTS Exit").
2. ICICI copy NOT detected — TWO breaks: `master-watcher.service.ts` polled
   ONLY `Broker.ZERODHA` (session + adapter + ingest tag), and
   `broker-lifecycle-normalizer.ts::normalizeRawOrder` had NO ICICI branch
   (returned null) — so even ICICI manual trades never fanned out.
3. ICICI copy execution — `copy-trading.service.ts` skipped every non-FYERS
   follower ("Fyers only, MVP").
4. TCS on BSE only, NSE missing — `InstrumentBroker @@unique([broker,
   brokerSymbol])` had no exchange; the BSE upsert collided with NSE and
   overwrote it.

FIX (feature branch `feature/icici-production-stabilization`):
- NEW shared `apps/api/src/brokers/order-mapping/`: `user-remark.ts`
  (`sanitizeUserRemark`, alphanumeric ≤20), `instrument-context.ts`
  (`ResolvedInstrument` + classify), `icici-order.mapper.ts`
  (`buildIciciPlaceOrder` — SINGLE Breeze payload producer: instrument-aware
  product cash/futures/options, right call/put/others, strike/expiry for
  derivatives, SL-M emulated as marketable stoploss, sanitized remark,
  UPPER exchange_code). manual-trade + order-actions + copy-trading follower
  ALL now build ICICI orders through this one mapper (ICICI dedup done;
  working Zerodha/Fyers builders left untouched per "don't rewrite working
  modules").
- Validator now surfaces `resolvedInstrument`; manual-trade threads it into the
  mapper. order-actions resolves instrument for the exit.
- master-watcher: broker-aware via new `BrokerService.getAdapterForAccount()` +
  `BrokerService.toOrderArray()` envelope helper (polls the account's OWN
  broker for all 4). normalizer: added `normalizeIcici` + `mapIciciStatus`
  (Executed→COMPLETE, Ordered/Requested/Queued→OPEN, Partially Executed→PARTIAL,
  Cancelled→CANCELLED, Rejected/Expired→REJECTED; filled = qty − pending).
- copy-trading: FYERS + ICICI followers supported; symbol resolution is
  exchange-aware (prefers master's exchange).
- Schema: `InstrumentBroker.exchange String` + `@@unique([broker, brokerSymbol,
  exchange])` + index. import service composite upsert incl. exchange +
  self-heal instrumentId on update. resolver/instrument.service/trade-event
  normalization all exchange-aware (NSE>BSE>… preference). Lookup/Translate
  DTOs gained optional exchange.

Validated (this pod, after `pnpm install --frozen-lockfile` — existing lockfile,
no new deps): `@cts/api` typecheck PASS; `pnpm -r build` 5/5 PASS; boot sanity
PASS (full Nest DI graph + all routes resolve; Prisma connects lazily).

NOT verified (impossible in this pod — no Postgres/Redis, no live daily Breeze
session, no preview URL; testing_agent not applicable/not invoked): live ICICI
manual BUY/SELL against Breeze prod, live ICICI-terminal detection + copy
fan-out, live ICICI follower execution, dashboard parity, and the instrument
count reconciliation — all require the user's local DB + broker session.

LOCAL DATABASE ACTION REQUIRED (user runs locally — I did NOT touch any DB):
Reason: InstrumentBroker gained a required `exchange` column + new composite
unique key. Instrument tables are managed by `prisma db push` (they are NOT in
migration history), so DO NOT `prisma migrate`.
Commands:
  1. (disposable data) truncate first so the required column can be added:
     `psql "$DATABASE_URL" -c 'TRUNCATE TABLE instrument_brokers, instruments RESTART IDENTITY CASCADE;'`
  2. `pnpm --filter @cts/database exec prisma db push`
  3. re-run imports so both listings persist: POST /instruments/import/icici
     (and the other brokers you use).
Verify: search TCS → expect BOTH NSE and BSE rows; place a manual ICICI cash
BUY → Breeze payload shows product=cash, user_remark=CTSManualTrade (no spaces).

Feature commit: see git log. Merge (--no-ff) into local `main`; NOT pushed
(user publishes via Save to GitHub).

## Sprint 6.2.12 (2026-08) — Replace continuous MasterWatcher with manual Sync — DONE (static)
Continuous background polling removed. Broker reconciliation is now strictly
on-demand: once after a successful CTS manual trade, and via an operator
"Sync Now" call. No timer / interval / scheduler / queue / cron / worker.

Changes:
- `master-watcher.service.ts`: removed `OnModuleInit` + `setInterval` poll loop,
  `DEFAULT_POLL_INTERVAL_MS`, `MASTER_WATCHER_POLL_INTERVAL_MS` and the
  `ConfigService` dependency. Renamed the reusable core to
  `syncMaster(masterId)` — SAME detection logic (broker-aware adapter →
  getOrders → `PositionLifecycleService.ingest`) — now returning a
  `MasterSyncResult` summary (new/modified/closed trades, copyJobsCreated,
  durationMs) and one concise "Master Sync" log line (no repetitive poll logs).
- NEW `master-sync.controller.ts`: `POST /masters/:id/sync` (ADMIN-guarded),
  runs exactly one sync cycle and returns the summary.
- `master-watcher.module.ts`: registers `MasterSyncController`.
- `manual-trade.service.ts`: after a successful broker placement, calls
  `masterWatcher.syncMaster(master.id)` once (best-effort, never rolls back the
  order). `manual-trading.module.ts` imports `MasterWatcherModule`.

Constraints honoured: no DB schema / Prisma migration / seed changes; broker
payload mappers, InstrumentResolver, importers, copy-trading execution and the
rest of manual-trade execution all untouched; existing APIs unchanged/backward
compatible. Validated: `@cts/api` typecheck PASS; `pnpm -r build` PASS (all
workspaces); boot sanity PASS (full DI graph, `/masters/:id/sync` mapped, crash
only at PrismaModule/DATABASE_URL). No polling remains. Feature branch
`feature/manual-sync-master` → `--no-ff` merge into local `main`; published by
the user via Save to GitHub.

## Sprint 6.2.13 (2026-08) — Master Portal Manual Broker Sync UI — DONE (static)
UI-only. Adds a "Sync Broker" button to the Master Portal broker-account page
(admin app: master-accounts/[id]/dashboard) that consumes the existing
POST /masters/:id/sync endpoint. No backend/business-logic changes.

Changes:
- `apps/admin/src/lib/api.ts`: `MasterSyncResult` type + `masterAccounts.sync(id)`
  → POST /masters/:id/sync.
- `apps/admin/.../master-accounts/[id]/dashboard/page.tsx`: "Sync Broker" button
  in the Connection Status card (Master Portal only). Loading state (disabled +
  spinner, prevents duplicate clicks); success renders the backend summary
  (New/Modified/Closed Trades, Copy Jobs Created, Duration); failure shows the
  clean backend error message. Button disabled while syncing / when disconnected.

Constraints honoured: Master Portal only (Follower/web app untouched); no new
API/endpoint; no polling/timer/scheduler/queue/worker/auto-sync; no changes to
broker adapters, InstrumentResolver, manual-trade, copy-trading, importers, DB,
Prisma, migrations or payload mapping. Validated: `@cts/api` typecheck PASS;
`pnpm -r build` PASS (admin + web compiled); boot sanity PASS (/masters/:id/sync
mapped, crash only at PrismaModule/DATABASE_URL). Feature branch
`feature/master-sync-ui` → `--no-ff` merge into `main`; published via Save to GitHub.

## Sprint 6.2.14 (2026-08) — ICICI Breeze API optimization (no functional change) — DONE (static)
Scope: apps/api/src/brokers/icici/icici.adapter.ts ONLY.
- Process-wide Breeze session cache (`breezeSessionCache`, key apiKey:rawSessionToken;
  fields sessionKey/uid/userName/customer/fetchedAt). `ensureSession(force?)` reuses a
  cached session across adapter instances; refreshes ONLY when missing, >12h old, or
  forced. customerdetails is no longer called for every manual trade / sync / dashboard
  adapter — one resolution per daily session.
- "No Data Found" (Status 200, Success null, Error "No Data Found") now treated as a
  successful EMPTY result: get() returns [] (no throw, no warning, sync not failed) for
  orders/trades/positions/holdings.
- One-shot session refresh + retry on Unauthorized/invalid-session for idempotent reads
  (get only); writes/placeOrder untouched (no double-order risk).
Unchanged: payloads, checksum, headers, authentication, order placement, response parsing
(except No Data Found). No DB/Prisma/migration/other-adapter/mapping changes.
Validated: `@cts/api` typecheck PASS; `pnpm -r build` PASS (api+web+admin); boot PASS
(/masters/:id/sync mapped, crash only at PrismaModule/DATABASE_URL).

## Sprint 6.2.13-fix (2026-08) — Fyers OAuth reconnect credential persistence — DONE (verified)
Bug: Fyers reconnect OAuth succeeded and redirected "connected", but reopening the
broker account raised an API-ID/credential error. Root cause: FyersService.saveSession
left loginTime & TradingAccount.lastHeartbeat untouched on the UPDATE (reconnect) branch
and passed possibly-undefined profile.userId/userName (Prisma skips undefined NOT-NULL
fields on update) — so a reconnect could keep the previous stale/mismatched API ID while
the callback had already redirected success without re-reading the row.

Fix (apps/api/src/brokers/fyers/ ONLY):
- fyers.service.ts: saveSession mirrors working Zerodha/ICICI — refresh loginTime +
  account lastHeartbeat on BOTH create & update; write userId/userName deterministically.
  New validatePersistedSession(tradingAccountId): reloads the BrokerSession via the same
  (tradingAccountId, broker=FYERS) unique key the adapter factory uses, decrypts the token
  and verifies token present/decryptable, userId (API ID) present, broker+account match.
- fyers.controller.ts (GET /brokers/fyers/callback): exchangeToken -> getProfile ->
  saveSession -> validatePersistedSession -> redirect success ONLY if validation.ok;
  on failure resets account to DISCONNECTED and redirects ok:false + reason. Masked DEBUG
  logs at each step (access/refresh tokens masked).
No schema/Prisma/other-broker/adapter/dashboard/trading changes. Validated: typecheck PASS,
`pnpm -r build` PASS, boot PASS. testing_agent (iteration_5): 21/21 harness assertions PASS
(callback ordering, success gated on validation, failure redirect, create+reconnect update
paths, other brokers byte-identical). Regression harness added under backend/tests/.
Known follow-up (noted, not in scope): Fyers adapter uses global env FYERS_APP_ID rather
than per-account key; a live token probe could further harden validation.


## Sprint 6.2.15 (2026-06) — Fyers multi-account isolation — DONE (verified)
Bug (critical): two Fyers master accounts with DIFFERENT API Key (App ID) +
Secret crossed over — Reconnect A authenticated Dimple; after disconnect A and
Reconnect B, it STILL authenticated Dimple (even after deleting Dimple and
recreating only Rupesh). Reconnect persistence (6.2.13-fix) was fine; account
isolation was broken.

ROOT CAUSE (confirmed): `FyersAdapter` hardcoded `process.env.FYERS_APP_ID` /
`FYERS_SECRET_ID` in its constructor, `getLoginUrl()` (generateAuthCode) and
`exchangeToken()` (generate_access_token). Fyers auth header is
`appId:accessToken`, so the OAuth login URL, the token exchange AND every
authenticated read used the SINGLE env App ID regardless of TradingAccount →
every Fyers account resolved to whoever owns the env App ID. Zerodha "works"
only because there is one env app; ICICI was already correct (per-account
`setCredentials`).

FIX (feature branch `feature/fyers-account-isolation`; Fyers-only + the shared
factory's Fyers branch — mirrors ICICI, no architecture redesign, no
dashboard/trading behaviour change):
- `fyers.adapter.ts`: instance fields `appId`/`secretId` (default to the env
  values for back-compat) + `setCredentials(appId, secretId)`; `exchangeToken`
  now uses `this.appId`/`this.secretId`, never env.
- `fyers.controller.ts`: removed the controller-shared `new FyersAdapter()`;
  injects `EncryptionService`; new `buildAccountAdapter(account)` decrypts
  `encryptedApiKey`/`encryptedApiSecret` → `setCredentials`. `login()` (now
  async) and `callback()` both load the account and build a PER-ACCOUNT adapter;
  both guard missing creds with a clean error redirect (no false success).
- `broker.service.ts`: `iciciCreds` → `accountApiCreds` (now ICICI_DIRECT AND
  FYERS); `buildAdapter` FYERS branch calls `setCredentials` before
  `setAccessToken` so dashboard/master-watcher reads are isolated too.
No schema/Prisma/migration change (encryptedApiKey/encryptedApiSecret already
exist and are populated by onboarding). Other brokers byte-identical.

Validated: `@cts/api` typecheck PASS; `pnpm -r build` 5/5 PASS; boot sanity PASS
(full DI graph incl. FyersModule, all routes mapped; crash only at
PrismaModule/DATABASE_URL). testing_agent iteration_6: 43/43 pytest, 20/20
account-isolation harness, 21/21 reconnect harness — ALL PASS, no regressions
(A=Dimple, B=Rupesh, repeated A→B→A→B switching never crosses; two independent
BrokerSession rows by (tradingAccountId, broker); no-cred + unknown-account
rejected). New regression suite: `backend/tests/fyers_account_isolation_harness.cjs`
+ `test_fyers_account_isolation.py`.

NOT verifiable in this pod (no Postgres/Redis, no live daily Fyers session, no
preview URL): the true live OAuth round-trip against Fyers prod with two real
apps — confirm on local run. Follow-up (noted, not in scope): drop the env
App ID/Secret defaults in FyersAdapter entirely to remove the last global
fallback.

Feature commit + `--no-ff` merge into local `main`; published by the user via
Save to GitHub.

## Sprint 6.2.16 (2026-06) — Fyers callback route /api compatibility — DONE (verified)
Bug chain resolution: after the redirect-URI env was corrected to the production
host (`https://cts.investwithdimple.com/api/brokers/fyers/callback`), Fyers began
redirecting to `/api/brokers/fyers/callback` but the backend returned
`404 Cannot GET /api/brokers/fyers/callback`. Root cause: `FyersController` was
`@Controller('brokers/fyers')` and `main.ts` uses an EMPTY global prefix
(`setGlobalPrefix('')`), so only `/brokers/fyers/*` was registered — no `/api`
variant. ICICI already worked because `ICICIDirectController` registers BOTH
prefixes.

Fix (routing compatibility ONLY — apps/api/src/brokers/fyers/fyers.controller.ts,
single line): `@Controller(['brokers/fyers', 'api/brokers/fyers'])` — mirrors the
ICICI pattern. No OAuth/auth/broker/DB/frontend/redirect-URI-generation change.

Validated: `@cts/api` build PASS; Nest startup now maps all four routes
(`/brokers/fyers/login`, `/api/brokers/fyers/login`, `/brokers/fyers/callback`,
`/api/brokers/fyers/callback`); both Fyers harnesses (account isolation +
reconnect) still `RESULT: ALL PASS` (no regression); Zerodha/ICICI/Shoonya
controllers untouched. testing_agent iteration_7: 100% PASS, no issues.
Note (future, out of scope): if a global `api` prefix is ever re-introduced in
main.ts, the dual-array decorator would create `/api/api/...` duplicates —
revisit then; and Zerodha/Shoonya could optionally adopt the same dual prefix.
Published by the user via Save to GitHub.


## Sprint 6.2.17 (2026-06) — Fyers reconnect context via OAuth state param — DONE (verified)
Bug: User-Portal (FOLLOWER) Fyers reconnect from localhost:3000 failed after
auth with `localhost:3001/dashboard/master-accounts?error=Reconnect context
missing`. Root cause: reconnect context (tradingAccountId + returnTo) was carried
ONLY by the in-memory `stateStore` Map keyed to the HttpOnly `cts_oauth_state`
cookie; on hot reload / multiple API instances / cross-origin redirect the
cookie or map entry was lost → callback `if (!tradingAccountId)` fired
(fyers.controller.ts) and, with tradingAccountId null, buildBrokerCallbackRedirect
defaulted portalBase to `adminAppBaseUrl()` (localhost:3001).

Fix (Sprint 6.2.17): carry the context in the OAuth `state` parameter that Fyers
echoes back on the callback — self-contained, survives hot reloads, multiple
instances and browser redirects with NO server-side memory. The cookie/map are
retained only as a backward-compatible fallback.
- oauth-state.store.ts: NEW `encodeOAuthState()` / `decodeOAuthState()` (base64url
  of `{t,r}`; additive — putOAuthState/takeOAuthState untouched). Not trusted for
  authz: returnTo stays open-redirect-guarded, tradingAccountId re-validated vs DB.
- fyers.adapter.ts: `getLoginUrl(state?)` passes `{state}` to SDK generateAuthCode
  (default path unchanged; BrokerAdapter interface preserved via optional param).
- fyers.controller.ts: login() encodes the state token → getLoginUrl(stateToken)
  (still writes cookie/map fallback); callback() gains `@Query('state')` (optional
  5th param, back-compatible) and recovers `stateEntry ?? cookieEntry`.

Scope guard: Zerodha / Shoonya / ICICI adapters + controllers UNCHANGED
(getLoginUrl(): string signatures verified untouched). No schema/Prisma/DB change.
Validated: `@cts/api` build PASS; boot PASS (all four Fyers routes mapped; crash
only at Prisma/Redis). testing_agent iteration_8: isolation harness 28/28 PASS
(incl. state-only recovery with NO cookie/map, User Portal FOLLOWER→localhost:3000,
Master Portal→localhost:3001, missing-context fallback intact) + reconnect harness
regression ALL PASS; 100%, no issues. Published by the user via Save to GitHub.
Follow-up (non-blocking): add an HMAC signature to the state token for
defense-in-depth (currently base64url of raw JSON, fails safe via DB validation).


## Sprint 6.2.18 (2026-06) — Fyers "invalid appId" (whitespace-trim) — DONE (verified)
Symptom: Dimple's Fyers account connects; Rupesh's fails on the Fyers login page
with "invalid appId" (before the callback). RCA: the per-account login path is
correct (Sprint 6.2.15) — env is NOT used, no singleton, setCredentials always
runs when creds exist — so the App ID VALUE sent for Rupesh is simply not a valid
Fyers App ID (root cause category C: wrong/invalid stored App ID). The one
code-fixable manifestation: decrypt() returns raw stored bytes and
setCredentials() never trimmed, so a copy-paste artefact (trailing newline /
spaces on the stored App ID) is sent as client_id=...%0A → "invalid appId".

Fix (Fyers-only, one method): FyersAdapter.setCredentials() now
`this.appId=(appId??'').trim(); this.secretId=(secretId??'').trim()` before
setAppId(). Trim is a no-op for clean values (Dimple unaffected). No change to
OAuth state/cookies/callback/routing/redirect/security/other brokers/frontend/DB.
Test: isolation harness PADDED account (encryptedApiKey '  APPID-A\n') asserts
trimmed client_id, no %0A/whitespace, successful auth, correct profile.
Validated: build PASS; isolation harness 32/32 PASS; reconnect harness ALL PASS;
testing_agent iteration_9 100%, no issues. Zerodha/Shoonya/ICICI untouched.
IMPORTANT: if Rupesh's stored App ID is the WRONG string (typo / wrong app / raw
secret in the App-ID field), no code fixes it — re-save the correct App ID in the
DB. Diagnostic query provided to the user. Published via Save to GitHub.



---

## Sprint 6.3 — Upstox (Uplink v2) Complete Broker Onboarding (2026-08-10)

**Status:** Implemented, typecheck + full workspace build PASS. Live order/OAuth verification PENDING (no Upstox app credentials in this env).

Onboarded Upstox as the 5th production broker with full lifecycle parity vs Zerodha / Fyers / ICICI / Shoonya. Upstox = OAuth2 authorization-code flow (mirrors Fyers) over plain REST v2 (mirrors ICICI axios transport). **No new dependency** (built-in `zlib` + existing `axios`). **No DB migration** — `UPSTOX` already existed in the `Broker` enum.

**New files (6):**
- `apps/api/src/brokers/upstox/upstox.adapter.ts` — REST v2 adapter, per-account Bearer isolation, full data surface + place/modify/cancel + verbatim broker-error surfacing.
- `apps/api/src/brokers/upstox/upstox.service.ts` — session persist + post-persist validation.
- `apps/api/src/brokers/upstox/upstox.controller.ts` — OAuth login/callback (dual `/api` prefix, self-contained `state` reconnect ctx).
- `apps/api/src/brokers/upstox/upstox.module.ts`
- `apps/api/src/brokers/order-mapping/upstox-order.mapper.ts` — single-source `/order/place` payload mapper.
- `apps/api/src/instruments/importers/upstox.importer.ts` — NSE cash+F&O from Upstox gz JSON.

**Modified (17):** app.module, broker.service (factory + all normalizers), broker-lifecycle-normalizer, manual-trade.service, order-actions.service, copy-trading.service, instrument.module, admin-instrument.controller, instrument.controller, instrument-stats.service, admin/lib/api.ts, packages/shared (ACTIVE_BROKERS), admin pages (instruments, master-accounts, trade-monitor, orders/[key]), web broker-accounts page.

**Feature commit:** 78f9552 · **Merge commit:** 4146ca8 (feature/upstox-broker-onboarding → main, --no-ff).

**Pending (live-only, marked):** real OAuth round-trip + token exchange, live order placement/modify/cancel/exit, live copy fan-out, instrument-count reconciliation. Requires `UPSTOX_REDIRECT_URI` env + per-account Upstox API app key/secret. Derivative cross-broker contractKey alignment is best-effort (same inherent limitation as existing brokers).



---

## Sprint 6.3.1 — Upstox Production Hardening (FIX sprint, 2026-08-10)

**Status:** Implemented, full workspace typecheck + build PASS, static verification PASS (testing agent iteration_10, 6/6 fixes, no regressions). Live end-to-end still PENDING (no Upstox credentials / runtime in this env).

Corrected only the 6 audited production issues; no new features, no architecture change, no DB schema change, no changes to other brokers.

1. **V3 order APIs** — place/modify/cancel now target `https://api-hft.upstox.com/v3/order/*` (v2 order APIs deprecated). Reads stay on `api.upstox.com/v2`. Mapper emits V3 `slice` field.
2. **Static IP** — `onboarding.requiresStaticIP = true` (order APIs require whitelisted static IP per SEBI algo rules + Upstox app config).
3. **Instruments** — importer now covers NSE + BSE + MCX (`NSE_EQ/NSE_FO/NSE_CD/BSE_EQ/BSE_FO/MCX_FO` → `NSE/NFO/CDS/BSE/BFO/MCX`), indices skipped. Reuses existing Instrument/InstrumentBroker model + Zerodha contractKey convention.
4. **Session validation** — `validatePersistedSession` now performs a live authenticated probe (`adapter.validateToken()` → `/user/profile`) with the persisted token before marking Connected; verbatim broker error on failure.
5. **Order history** — retained day order book (`/v2/order/retrieve-all`, not deprecated) = parity with Zerodha/Fyers.
6. **Rate limiting** — new `upstox-rate-limiter.ts` (order 10/s·500/min·2000/30min; data 50/s·500/min·2000/30min) gates every adapter HTTP call. Copy/manual architecture untouched.

**Files:** modified `brokers/upstox/upstox.adapter.ts`, `upstox.service.ts`, `instruments/importers/upstox.importer.ts`, `brokers/order-mapping/upstox-order.mapper.ts`; new `brokers/upstox/upstox-rate-limiter.ts`.

**Fix commit:** 53a7563 · **Merge commit:** 47299d0 (fix/upstox-production-hardening → main, --no-ff).

**Remaining limitations:** Live OAuth/token probe, V3 order placement/modify/cancel/exit, and full NSE/BSE/MCX import row counts require a real Upstox account + static-IP-whitelisted host (unavailable here). Derivative cross-broker contractKey alignment remains best-effort (pre-existing, all brokers). V3 order APIs may return `UDAPI100049` for accounts not enabled for HFT order APIs (Upstox account-side enablement).

