import axios from 'axios';
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
  UnsupportedResult,
} from '../broker.interface';

/**
 * Sprint 6.2.0 — Shoonya (Finvasia Noren) OAuth adapter.
 *
 * Shoonya officially retired the password + TOTP `QuickAuth` login
 * (`/NorenWClientTP/QuickAuth`) and moved to an OAuth 2.0 authorization-code
 * flow on the new `/NorenWClientAPI/` base, per the official OAuth SDK
 * (github.com/Shoonya-API-OAuth-Python/Shoonya_API_OAuth) and the Noren OAuth
 * docs. This adapter mirrors the Fyers/Upstox OAuth adapters:
 *
 *   1. `getLoginUrl(state?)` → the hosted authorize URL
 *      `https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id=<clientId>`.
 *      After the user logs in, Shoonya redirects to the app's registered
 *      redirect URI with `?code=<auth_code>`.
 *   2. `exchangeToken(code)` → POSTs `jData={code, checksum}` to
 *      `/NorenWClientAPI/GenAcsTok`, where
 *      `checksum = SHA256(apiKey + secretCode + code)` (no spaces). Returns the
 *      daily `access_token` (+ refresh_token / uid / actid / uname).
 *   3. Every authenticated read is a Noren POST of
 *      `jData=<json>&jKey=<access_token>` with an
 *      `Authorization: Bearer <access_token>` header (the OAuth access token
 *      replaces the legacy `susertoken`).
 *
 * Data endpoints (UserDetails, Limits, Holdings, PositionBook, OrderBook,
 * TradeBook, Logout) are unchanged from the Noren contract — only the base URL,
 * the login mechanism and the token header changed. The Sprint 6.1.8 network
 * resilience (retry + typed gateway-outage error on 502/HTML) is preserved.
 */
export class ShoonyaAdapter implements BrokerAdapter {
  static readonly capabilities: BrokerCapabilities = {
    profile: true,
    exchanges: true,
    products: false,
    funds: true,
    margin: true,
    holdings: true,
    positions: true,
    orders: true,
    trades: true,
  };

  static readonly features: BrokerFeatureSupport = {
    supportsProfile: true,
    supportsFunds: true,
    supportsMargins: true,
    supportsHoldings: true,
    supportsPositions: true,
    supportsOrders: true,
    supportsTrades: true,
    supportsPortfolio: true,
    // Sprint 6.2.0 — OAuth is interactive (redirect + user login), so there is
    // no silent auto-login. A fresh OAuth login is required daily.
    supportsAutoLogin: false,
    supportsLogout: true,
    supportsSessionRefresh: false,
  };

  static readonly onboarding: BrokerOnboardingRequirements = {
    // Sprint 6.2.0 — migrated from QuickAuth (password/TOTP/vendor) to OAuth.
    requiresOAuth: true,
    requiresApiKey: true, // Shoonya OAuth API key (client_id).
    requiresSecret: true, // Shoonya OAuth secret code.
    requiresPassword: false,
    requiresPIN: false,
    requiresTOTP: false,
    requiresStaticIP: false,
    requiresRedirect: true,
    requiresVendorCode: false,
    supportsAutoLogin: false,
    supportsTokenRefresh: false,
    supportsMFA: false,
  };

  // Sprint 6.2.0 — new OAuth API host (QuickAuth on NorenWClientTP is retired).
  private readonly baseUrl = 'https://api.shoonya.com/NorenWClientAPI';
  private readonly oauthAuthorizeUrl =
    'https://api.shoonya.com/OAuthlogin/authorize/oauth';

  // Sprint 6.1.8 — network resilience against intermittent Noren gateway
  // failures (api.shoonya.com nginx front returns HTTP 502 / connection
  // resets during broker-side upstream flaps). These are transport-layer
  // failures, not request-format bugs.
  private readonly timeoutMs = 15000;
  private readonly maxAttempts = 3;

  // Per-account OAuth credentials (never env-based) — used only for the token
  // exchange checksum + the authorize URL. Authenticated reads use the token.
  private apiKey = '';
  private secretCode = '';

  private readonly logger = new Logger('ShoonyaAdapter');

  private accessToken = '';
  private uid = '';
  private actid = '';

  /**
   * Sprint 6.2.0 — per-account OAuth credentials: `apiKey` is the Shoonya
   * OAuth Client ID (sent as `client_id` in the authorize URL and used as the
   * first checksum component), `secretCode` is the OAuth secret code. Trimmed
   * to drop copy-paste artefacts (trailing newline/spaces) that would otherwise
   * corrupt the authorize URL / checksum.
   */
  setCredentials(apiKey: string, secretCode: string) {
    this.apiKey = (apiKey ?? '').trim();
    this.secretCode = (secretCode ?? '').trim();
  }

  /**
   * The OAuth access token is what every authenticated Noren call carries
   * (as the `Authorization: Bearer` header and the `jKey` body field). Kept
   * named `setSessionToken` so the shared BrokerService adapter factory wiring
   * is unchanged (it treats the stored access token as the session token).
   */
  setSessionToken(token: string) {
    this.accessToken = token;
  }

  setAccessToken(token: string) {
    this.accessToken = token;
  }

  /** Sprint 6.1.6 — user/account id required by every Noren data endpoint. */
  setUserId(userId: string) {
    this.uid = userId;
    this.actid = userId;
  }

  getLoginUrl(state?: string): string {
    // Shoonya support confirmed the authorize endpoint parameter is `client_id`
    // (the value is the developer-portal Client ID, stored on the account as
    // its API key). NOTE: parameter NAME is client_id; the value is this.apiKey.
    const params = new URLSearchParams({ client_id: this.apiKey });
    // Shoonya may not echo `state` back on the callback; it is included as a
    // best-effort, self-contained reconnect-context carrier. The controller
    // always writes the cookie/map fallback too, so a dropped `state` is safe.
    if (state) params.set('state', state);
    return `${this.oauthAuthorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange the single-use OAuth authorization `code` for the daily access
   * token via `GenAcsTok`. `checksum = SHA256(apiKey + secretCode + code)`
   * (no spaces) per the official OAuth SDK/docs. Body is raw
   * `jData=<json>` (no jKey yet — there is no token before this call).
   */
  async exchangeToken(code: string): Promise<any> {
    if (!this.apiKey || !this.secretCode) {
      throw new Error(
        'Shoonya OAuth API key/secret code missing on this account.',
      );
    }
    const checksum = createHash('sha256')
      .update(`${this.apiKey}${this.secretCode}${code}`)
      .digest('hex');
    const jData = { code, checksum };
    const body = `jData=${JSON.stringify(jData)}`;
    const data = await this.httpPost(`${this.baseUrl}/GenAcsTok`, body);
    if (!data || data.stat !== 'Ok' || !data.access_token) {
      throw new Error(data?.emsg || 'Shoonya OAuth token exchange failed');
    }
    // Cache the token + account id so the immediately-following profile/data
    // calls on this adapter instance succeed.
    this.accessToken = data.access_token;
    this.setUserId(data.actid ?? data.uid ?? '');
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      uid: data.uid,
      actid: data.actid,
      userId: data.actid ?? data.uid,
      userName: data.uname,
      email: data.email,
      raw: data,
    };
  }

  /**
   * Resilient Noren HTTP POST (Sprint 6.1.8).
   *
   * Noren's gateway (nginx at api.shoonya.com) intermittently returns HTTP
   * 5xx **HTML** error pages and drops connections while its upstream flaps.
   * We therefore set an explicit timeout, retry transient failures with
   * backoff, and detect non-JSON (HTML) bodies → raise a typed, actionable
   * `SHOONYA_GATEWAY_UNAVAILABLE` error instead of leaking raw HTML.
   *
   * When `authToken` is supplied it is sent as `Authorization: Bearer <token>`
   * (Sprint 6.2.0 OAuth) — omitted for the unauthenticated GenAcsTok exchange.
   */
  private async httpPost(
    url: string,
    body: string,
    authToken?: string,
    reqContentType: string = 'application/x-www-form-urlencoded',
  ): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await axios.post(url, body, {
          headers: {
            'Content-Type': reqContentType,
            Accept: 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          timeout: this.timeoutMs,
          validateStatus: () => true,
          transformResponse: [(d) => d], // keep raw so we can classify HTML
        });

        const status = res.status;
        const contentType = String(res.headers?.['content-type'] ?? '');
        const raw = res.data;
        const looksHtml =
          contentType.includes('text/html') ||
          (typeof raw === 'string' && /^\s*<(?:!doctype|html)/i.test(raw));

        // Gateway / upstream failure → retry, then surface a clear message.
        if (status >= 500 || looksHtml) {
          lastError = gatewayUnavailableError(status, raw);
          if (attempt < this.maxAttempts) {
            await delay(attempt * 700);
            continue;
          }
          throw lastError;
        }

        // Parse the JSON body ourselves (transformResponse kept it raw).
        if (typeof raw === 'string') {
          try {
            return raw.length ? JSON.parse(raw) : {};
          } catch {
            // A 2xx that is not valid JSON is still a gateway/content problem.
            throw gatewayUnavailableError(status, raw);
          }
        }
        return raw;
      } catch (err: any) {
        // Network-level failures (ECONNRESET / ETIMEDOUT / socket hang up).
        if (isRetryableNetworkError(err)) {
          lastError = err;
          if (attempt < this.maxAttempts) {
            await delay(attempt * 700);
            continue;
          }
          throw gatewayUnavailableError(0, err?.message ?? 'network error');
        }
        throw err;
      }
    }

    throw lastError ?? new Error('Shoonya request failed');
  }

  /**
   * Core authenticated Noren POST helper. Every endpoint uses
   * `jData=<raw json>&jKey=<access_token>` (jData is NOT url-encoded) plus the
   * OAuth Bearer header (Sprint 6.2.0).
   */
  private async post(path: string, jData: Record<string, any>): Promise<any> {
    const body = `jData=${JSON.stringify(jData)}&jKey=${this.accessToken}`;
    const data = await this.httpPost(
      `${this.baseUrl}/${path}`,
      body,
      this.accessToken,
    );
    if (Array.isArray(data)) return data;
    if (data && data.stat && data.stat !== 'Ok') {
      const emsg = String(data.emsg ?? '');
      // Noren returns Not_ok + "no data"/"no record" for genuinely empty
      // books — treat that as an empty result, not an error (no fabrication).
      if (/no data|no record|not found|no.*position|no.*holding/i.test(emsg)) {
        return [];
      }
      throw new Error(emsg || `Shoonya error on ${path}`);
    }
    return data;
  }

  /** Sprint 6.2.0 — live authenticated probe used by post-persist validation. */
  async validateToken(): Promise<{ userId?: string }> {
    const data = await this.post('UserDetails', { uid: this.uid });
    return { userId: data?.actid ?? this.uid };
  }

  async getProfile(): Promise<BrokerProfile> {
    const data = await this.post('UserDetails', { uid: this.uid });
    return {
      broker: 'SHOONYA',
      userId: data.actid ?? this.uid,
      userName: data.uname ?? '',
      email: data.email ?? '',
      exchanges: Array.isArray(data.exarr) ? data.exarr : undefined,
      accountType: data.actid ? 'INDIVIDUAL' : undefined,
      profileStatus: data.stat === 'Ok' ? 'ACTIVE' : undefined,
    };
  }

  async getMargins() {
    return this.post('Limits', { uid: this.uid, actid: this.actid });
  }

  async getFunds() {
    return this.post('Limits', { uid: this.uid, actid: this.actid });
  }

  async getHoldings() {
    // prd = product type; 'C' (CNC) is the standard delivery holdings product.
    return this.post('Holdings', {
      uid: this.uid,
      actid: this.actid,
      prd: 'C',
    });
  }

  async getPositions() {
    return this.post('PositionBook', { uid: this.uid, actid: this.actid });
  }

  async getOrders() {
    return this.post('OrderBook', { uid: this.uid });
  }

  async getTrades() {
    return this.post('TradeBook', { uid: this.uid, actid: this.actid });
  }

  async getPortfolio() {
    return this.getHoldings();
  }

  async getExchanges(): Promise<string[] | null> {
    const data = await this.post('UserDetails', { uid: this.uid });
    return Array.isArray(data.exarr) ? data.exarr : null;
  }

  async getProducts(): Promise<string[] | null> {
    return null; // Not distinctly enumerated by the Noren profile payload.
  }

  async logout(): Promise<UnsupportedResult | { supported: true; data?: any }> {
    const data = await this.post('Logout', { uid: this.uid });
    return { supported: true, data };
  }

  async refreshSession(): Promise<
    UnsupportedResult | { supported: true; data?: any }
  > {
    return {
      supported: false,
      reason:
        'Shoonya (Noren) OAuth has no silent refresh; a fresh OAuth login is required daily.',
    };
  }

  /**
   * Sprint — Shoonya copy-execution translation + placement.
   *
   * Places an order on the Noren `PlaceOrder` endpoint. ALL Shoonya-specific
   * translation lives HERE (never in the copy-trading engine): the broker-
   * neutral order produced by the follower translator is mapped into the exact
   * Noren field set.
   *
   *   product   MIS/INTRADAY/I → 'I' · CNC/DELIVERY/C → 'C' · NRML/NORMAL/MARGIN/M → 'M'
   *   side      BUY → 'B' · SELL → 'S'
   *   orderType MARKET → 'MKT' (prc '0') · LIMIT → 'LMT' (prc from price)
   *
   * Field set is aligned with the official ShoonyaApi-py `place_order` payload:
   *   ordersource, uid, actid, trantype, prd, exch, tsym (URL-encoded),
   *   qty, dscqty, prctyp, prc, trgprc (SL only), ret, remarks, amo.
   * `tsym` is URL-encoded exactly as the official SDK does
   * (`urllib.parse.quote_plus`) so symbols like `M&M-EQ` are not truncated.
   *
   * DIAGNOSTICS: the EXACT final Noren request (endpoint + every field + the
   * complete jData JSON) is logged immediately BEFORE transmission, and the raw
   * broker response immediately AFTER — so a live rejection (e.g. the reported
   * "ALGO_CHK: MKT Order type not allowed for API order") can be captured
   * verbatim for a Finvasia support case. Logging never mutates the payload and
   * never swallows the response.
   */
  async placeOrder(order: any) {
    if (!this.accessToken) {
      throw new Error('Shoonya session token missing — reconnect the broker.');
    }
    if (!this.uid) {
      throw new Error('Shoonya account id (uid) missing on this session.');
    }

    const exch = String(order?.exchange ?? order?.exch ?? 'NSE').trim().toUpperCase();
    const rawTsym = String(order?.tradingSymbol ?? order?.tsym ?? order?.symbol ?? '').trim();
    if (!rawTsym) {
      throw new Error('Shoonya order is missing a trading symbol (tsym).');
    }
    // Official SDK URL-encodes the trading symbol inside the jData JSON
    // (quote_plus). The transport (`post`) does NOT re-encode the jData string,
    // so encoding here matches the SDK byte-for-byte. Idempotent for plain
    // symbols like TATASTEEL-EQ; correct for M&M-EQ → M%26M-EQ.
    const tsym = encodeURIComponent(rawTsym);

    const qtyNum = Number(order?.quantity ?? order?.qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      throw new Error(`Invalid quantity "${order?.quantity ?? order?.qty}" for Shoonya order.`);
    }

    const sideRaw = String(order?.side ?? order?.trantype ?? '').trim().toUpperCase();
    const trantype = sideRaw === 'SELL' || sideRaw === 'S' ? 'S' : 'B';

    // Price type. Copy fan-out places MARKET; LIMIT/SL retained for manual/
    // future callers. MARKET stays MARKET (never silently converted to LIMIT).
    const otRaw = String(order?.orderType ?? order?.prctyp ?? 'MARKET').trim().toUpperCase();
    let prctyp: 'MKT' | 'LMT' | 'SL-MKT' | 'SL-LMT';
    if (otRaw === 'LIMIT' || otRaw === 'LMT') prctyp = 'LMT';
    else if (otRaw === 'SL-LMT' || otRaw === 'SL') prctyp = 'SL-LMT';
    else if (otRaw === 'SL-MKT' || otRaw === 'SL-M') prctyp = 'SL-MKT';
    else prctyp = 'MKT';
    const isLimitPriced = prctyp === 'LMT' || prctyp === 'SL-LMT';
    const isTriggered = prctyp === 'SL-MKT' || prctyp === 'SL-LMT';

    const prd = ShoonyaAdapter.mapProduct(order?.product);
    if (!prd) {
      throw new Error(
        `Invalid product "${order?.product}" for Shoonya. ` +
          `Supported: MIS/INTRADAY, CNC/DELIVERY, NRML/NORMAL.`,
      );
    }

    const priceNum = Number(order?.price ?? order?.prc ?? 0);
    const prc = isLimitPriced && Number.isFinite(priceNum) ? String(priceNum) : '0';

    const trigNum = Number(order?.triggerPrice ?? order?.trgprc ?? 0);

    const ret = String(order?.validity ?? order?.ret ?? 'DAY').trim().toUpperCase();

    // Free-text tag, alphanumeric only (Noren rejects some special chars).
    const remarks = String(order?.remarks ?? 'CTSCopy').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'CTSCopy';

    // AMO flag: 'YES' only when explicitly requested; otherwise a regular order.
    const amo = String(order?.amo ?? '').trim().toUpperCase() === 'YES' ? 'YES' : 'NO';

    // Noren PlaceOrder body — aligned field-for-field with the official OAuth
    // SDK (NorenRestApiPy 0.0.37, injectOAuthHeader/place_order). The SDK
    // ALWAYS sends `trgprc` and `algo_id` (the latter's absence is the strongest
    // candidate for the server-side `ALGO_CHK` rejection). Order mirrors the SDK.
    const jData: Record<string, any> = {
      ordersource: 'API',
      uid: this.uid,
      actid: this.actid || this.uid,
      trantype,
      prd,
      exch,
      tsym,
      qty: String(Math.trunc(qtyNum)),
      dscqty: '0',
      prctyp,
      prc,
      // SDK includes trgprc unconditionally (str(trigger_price)); '0' for
      // non-stop-loss orders, trigger value for SL variants.
      trgprc: isTriggered && Number.isFinite(trigNum) ? String(trigNum) : '0',
      ret,
      remarks,
      // SDK sends algo_id unconditionally (null unless an algo order). Present
      // (null) so the Noren ALGO_CHK gate can classify this as a non-algo order.
      algo_id: null,
    };
    // AMO: SDK omits the field entirely unless set; only add it when 'YES'.
    if (amo === 'YES') {
      jData.amo = 'YES';
    }

    this.logPlaceOrderRequest(jData);

    try {
      // Transmit EXACTLY like the official OAuth SDK: body is `jData=<json>`
      // with NO `&jKey` (auth is the Bearer header) and Content-Type
      // `application/json; charset=utf-8`. Reads keep their own transport
      // (post()) untouched.
      const body = `jData=${JSON.stringify(jData)}`;
      const res = await this.httpPost(
        `${this.baseUrl}/PlaceOrder`,
        body,
        this.accessToken,
        'application/json; charset=utf-8',
      );
      if (res && res.stat && res.stat !== 'Ok') {
        throw new Error(String(res.emsg ?? '') || 'Shoonya error on PlaceOrder');
      }
      this.logPlaceOrderResponse(jData, res, null);
      return res;
    } catch (err: any) {
      this.logPlaceOrderResponse(jData, null, err);
      throw err;
    }
  }

  /**
   * DIAGNOSTICS (log-only) — the EXACT final Noren PlaceOrder request, printed
   * immediately before transmission. Access token is NEVER logged (it travels
   * as the `jKey` body field + Bearer header inside `post`, not in jData).
   */
  private logPlaceOrderRequest(jData: Record<string, any>): void {
    const endpoint = `${this.baseUrl}/PlaceOrder`;
    const f = (k: string) => (jData[k] === undefined ? '(not sent)' : String(jData[k]));
    const block = [
      '=============================================',
      '[ShoonyaAdapter] NOREN PLACE ORDER — REQUEST',
      '=============================================',
      `Method            : POST`,
      `Endpoint          : ${endpoint}`,
      `Content-Type      : application/json; charset=utf-8`,
      `Authorization     : Bearer ***MASKED***`,
      `Body shape        : jData=<json>   (no jKey — OAuth Bearer auth, matches official SDK)`,
      `ordersource       : ${f('ordersource')}`,
      `uid               : ${f('uid')}`,
      `actid             : ${f('actid')}`,
      `trantype          : ${f('trantype')}`,
      `prd               : ${f('prd')}`,
      `exch              : ${f('exch')}`,
      `tsym (encoded)    : ${f('tsym')}`,
      `qty               : ${f('qty')}`,
      `dscqty            : ${f('dscqty')}`,
      `prctyp            : ${f('prctyp')}`,
      `prc               : ${f('prc')}`,
      `trgprc            : ${f('trgprc')}`,
      `ret               : ${f('ret')}`,
      `remarks           : ${f('remarks')}`,
      `amo               : ${f('amo')}`,
      `algo_id           : ${f('algo_id')}`,
      `Complete jData    : ${safeJson(jData)}`,
      `Raw HTTP body     : jData=${safeJson(jData)}`,
      '=============================================',
    ].join('\n');
    this.logger.log('\n' + block);
  }

  /** DIAGNOSTICS (log-only) — the raw broker response / error, post-transmission. */
  private logPlaceOrderResponse(
    jData: Record<string, any>,
    res: unknown,
    err: any,
  ): void {
    const block = [
      '=============================================',
      '[ShoonyaAdapter] NOREN PLACE ORDER — RESPONSE',
      '=============================================',
      `tsym              : ${String(jData?.tsym ?? '-')}`,
      `prctyp            : ${String(jData?.prctyp ?? '-')}`,
      err
        ? `Outcome           : ERROR`
        : `Outcome           : OK (stat=${(res as any)?.stat ?? '-'}, norenordno=${(res as any)?.norenordno ?? '-'})`,
      err
        ? `Error message     : ${err?.message ?? String(err)}`
        : `Raw response      : ${safeJson(res)}`,
      err ? `Error type        : ${err?.error_type ?? err?.name ?? '-'}` : '',
      '=============================================',
    ]
      .filter(Boolean)
      .join('\n');
    this.logger.log('\n' + block);
  }

  /**
   * Map a CTS-internal / cross-broker product onto a Noren product code, or
   * null when unresolvable (the caller rejects BEFORE the broker API call).
   */
  static mapProduct(product: unknown): 'C' | 'M' | 'I' | null {
    const p = String(product ?? '').trim().toUpperCase();
    switch (p) {
      case 'MIS':
      case 'INTRADAY':
      case 'I':
        return 'I';
      case 'CNC':
      case 'DELIVERY':
      case 'C':
        return 'C';
      case 'NRML':
      case 'NORMAL':
      case 'MARGIN':
      case 'M':
        return 'M';
      default:
        return null;
    }
  }

  async modifyOrder(_orderId: string, _order: any) {
    return {};
  }

  async cancelOrder(_orderId: string) {
    return {};
  }
}

/** Small async delay used for retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Safe JSON stringify for diagnostic logging (never throws). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Axios/node network errors that are safe to retry (transient transport). */
function isRetryableNetworkError(err: any): boolean {
  const code = String(err?.code ?? '').toUpperCase();
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNREFUSED'
  ) {
    return true;
  }
  const msg = String(err?.message ?? '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  );
}

/**
 * Build a clear, actionable error for a Noren gateway/upstream failure so CTS
 * surfaces a human message (never a raw HTML blob). `status` 0 == no HTTP
 * response (network failure). Carries `error_type` + `brokerStatus` so callers
 * can distinguish a broker outage from a credential rejection.
 */
function gatewayUnavailableError(status: number, rawBody: unknown): Error {
  const isHtml =
    typeof rawBody === 'string' && /<(?:!doctype|html|center|title)/i.test(rawBody);
  const statusText =
    status === 502
      ? 'HTTP 502 Bad Gateway'
      : status === 503
      ? 'HTTP 503 Service Unavailable'
      : status === 504
      ? 'HTTP 504 Gateway Timeout'
      : status >= 500
      ? `HTTP ${status}`
      : status === 0
      ? 'no response (connection failed/timed out)'
      : `HTTP ${status}`;

  const detail = isHtml ? ' (received an HTML gateway page, not a JSON API response)' : '';
  const err = new Error(
    `Shoonya (Finvasia Noren) API gateway at api.shoonya.com is temporarily unavailable — ${statusText}${detail}. ` +
      `This is a broker-side outage, not a problem with your OAuth API key or secret. Please retry in a few minutes.`,
  );
  (err as any).error_type = 'SHOONYA_GATEWAY_UNAVAILABLE';
  (err as any).brokerStatus = status || undefined;
  return err;
}
