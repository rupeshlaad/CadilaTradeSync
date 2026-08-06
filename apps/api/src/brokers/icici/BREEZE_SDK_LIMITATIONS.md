# Sprint 6.2.0 — ICICI Direct (Breeze API) SDK Limitation Report

All limitations below are **official Breeze API v1 constraints**, not CTS
implementation gaps. Base URL: `https://api.icicidirect.com/breezeapi/api/v1/`.

---

## 1. No token refresh / no auto-login

- **SDK restriction:** Breeze issues a single API session token via an
  interactive login redirect (`/apiuser/login?api_key=…`). There is no
  refresh-token grant and no non-interactive credential login.
- **Reason:** SEBI mandates a fresh, user-authenticated session token each
  trading day; ICICI enforces this server-side.
- **Impact:** `supportsSessionRefresh = false`, `supportsAutoLogin = false`.
  Users must re-run the OAuth login daily. The session-health engine flags the
  token EXPIRED after midnight IST.
- **Possible future solution:** A user-scheduled, browser-assisted daily
  re-login prompt (cannot be fully automated within Breeze's rules).

## 2. Session expires daily at midnight IST

- **SDK restriction:** The API session token is invalidated at 00:00 IST (or
  after 24h).
- **Reason:** Same SEBI daily-session mandate.
- **Impact:** `BrokerSession.expiresAt` is set to the next midnight IST so the
  shared lifecycle marks EXPIRED correctly.
- **Possible future solution:** None (broker policy).

## 3. No logout / session-invalidate endpoint

- **SDK restriction:** Breeze exposes no API to explicitly revoke a session.
- **Reason:** Not provided by the vendor.
- **Impact:** `supportsLogout = false`. CTS "Disconnect" only removes the local
  session row; broker authorization lapses naturally at midnight.
- **Possible future solution:** None until ICICI ships a revoke endpoint.

## 4. Order & Trade lists require exchange_code + date range

- **SDK restriction:** `order_list` and `trade_list` mandate an
  `exchange_code` plus `from_date`/`to_date`; they cannot return an
  all-exchange, all-time view in a single call.
- **Reason:** Breeze API contract.
- **Impact:** The dashboard adapter defaults to `exchange_code = NSE` for the
  current trading day. Orders/trades on BSE/NFO/etc. or historical ranges are
  not shown in the standard dashboard view.
- **Possible future solution:** Add exchange/date filters to the dashboard and
  fan out one call per exchange, then merge.

## 5. Demat holdings carry no live price / P&L (worked around)

- **SDK restriction:** `dematholdings` returns quantities and ISIN/stock codes
  but not LTP, market value, or P&L.
- **Reason:** Holdings and market data are separate Breeze endpoints.
- **Resolution (Sprint 6.2.2):** The adapter uses `portfolioholdings`
  (which returns `current_market_price` alongside `stock_code`, `quantity`,
  `average_price`). When a live price is missing it is enriched via the
  official `quotes` endpoint. Value (`qty × ltp`) and P&L
  (`(ltp − avg) × qty`) are then derived in BrokerService — never fabricated.
  If neither the holdings API nor the quotes API returns a price, LTP / value /
  P&L stay null and the UI shows "Not provided by broker".
- **Efficiency:** Breeze has no bulk-quote endpoint (single stock_code per
  call, ~10 req/sec limit), so quote lookups are deduped/cached per symbol
  within a request (a stock in both holdings and positions is fetched once).

## 6. GET requests carry a JSON body

- **SDK restriction:** Authenticated Breeze GET endpoints expect the request
  parameters in a JSON **body** (not the query string), and the checksum is
  computed over that body.
- **Reason:** Breeze design.
- **Impact:** The adapter sends `axios.request({ method: 'GET', data, headers })`.
  Some intermediaries strip GET bodies; a server-to-server call path is
  required.
- **Possible future solution:** None (matches the official SDK behaviour).

## 7. Checksum + tight clock-skew requirement

- **SDK restriction:** Every authenticated call needs
  `X-Checksum = "token " + SHA256(X-Timestamp + jsonBody + secret_key)` with
  `X-Timestamp` in ISO8601 UTC and milliseconds forced to `.000Z`; requests
  fail if the server clock drifts materially.
- **Reason:** Request integrity + replay protection.
- **Impact:** The adapter reuses one timestamp for both the header and the
  checksum. Host clock must be NTP-synced.
- **Possible future solution:** None (security requirement).

## 8. Rate limits

- **SDK restriction:** ~75 calls/minute and ~2000 calls/day.
- **Reason:** Vendor throttling.
- **Impact:** The dashboard fetches profile/funds/holdings/positions/orders/
  trades concurrently (6 calls) per refresh; heavy multi-account polling can
  approach the limit.
- **Possible future solution:** Response caching + a per-account refresh
  throttle.

## 9. Market orders auto-converted (execution scope only)

- **SDK restriction:** Breeze does not accept plain market orders; they are
  converted to aggressive limit orders.
- **Reason:** Vendor risk control.
- **Impact:** None for Sprint 6.2.0 (order execution is intentionally out of
  scope; `placeOrder`/`modifyOrder`/`cancelOrder` are stubs).
- **Possible future solution:** Implement the aggressive-limit conversion when
  order execution is onboarded for ICICI.
