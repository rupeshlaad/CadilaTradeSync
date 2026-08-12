import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from '../brokers/zerodha/zerodha.adapter';
import { FyersAdapter } from '../brokers/fyers/fyers.adapter';
import { ICICIDirectAdapter } from '../brokers/icici/icici.adapter';
import { UpstoxAdapter } from '../brokers/upstox/upstox.adapter';

import { ExecutionEventRecorderService } from '../copy-trading/execution-event.recorder';
import { classifyFailure } from '../copy-trading/execution-event.recorder';
import type { ExecutionEvent } from '../copy-trading/execution-event';
import { PositionLifecycleService } from '../position-lifecycle/position-lifecycle.service';
import { MasterWatcherService } from '../master-watcher/master-watcher.service';

import { ManualTradeValidatorService } from './manual-trade-validator.service';
import { PlaceManualTradeDto } from './manual-trade.dto';
import {
  ManualTradeFollowerOutcome,
  ManualTradeRecord,
  ManualTradeStatus,
} from './manual-trade.types';
import {
  marketProtectionPercent,
  supportsMarketProtection,
} from './broker-rules';
import {
  buildIciciPlaceOrder,
  resolveIciciProduct,
} from '../brokers/order-mapping/icici-order.mapper';
import { buildUpstoxPlaceOrder } from '../brokers/order-mapping/upstox-order.mapper';
import { ResolvedInstrument } from '../brokers/order-mapping/instrument-context';

const BUFFER_CAPACITY = 100;
const MANUAL_TRADE_SOURCE = 'MANUAL';

/** Terminal manual-trade statuses — once reached, later ExecutionEvents
 *  for the same broker order are idempotently ignored. */
const TERMINAL_STATUSES: ReadonlySet<ManualTradeStatus> = new Set([
  ManualTradeStatus.REJECTED,
  ManualTradeStatus.COMPLETED,
  ManualTradeStatus.PARTIAL,
  ManualTradeStatus.FAILED,
]);

/**
 * Sprint 5.4 — Manual Trade Execution.
 *
 * Admin-initiated master trade orchestrator. Responsibilities:
 *
 *   1. Delegate structural validation to `ManualTradeValidatorService`.
 *   2. Place the order on the master broker via the existing adapter
 *      (`ZerodhaAdapter` / `FyersAdapter`) — no duplicated broker logic.
 *   3. Route the resulting broker order into the position-lifecycle
 *      pipeline via `PositionLifecycleService.ingest(..., MANUAL)` so
 *      the manual trade travels through the EXACT SAME execution
 *      pipeline as broker-detected trades (lifecycle state machine →
 *      CopyTradingService → ExecutionHistory → Trade Monitor).
 *   4. Track the manual-trade in an in-memory ledger so the UI can
 *      render Pending / Accepted / Executing / Completed / Partial /
 *      Failed / Rejected status without hitting the database.
 *
 * The service subscribes to `ExecutionEventRecorderService.onCommit`
 * so it can correlate the eventual CopyTradingService fan-out result
 * back to the manual-trade record and finalise its status.
 */
@Injectable()
export class ManualTradeService implements OnModuleInit {
  private readonly logger = new Logger(ManualTradeService.name);
  private readonly records = new Map<string, ManualTradeRecord>();
  /** Broker orderId → manual trade id, for O(1) correlation on commit. */
  private readonly byBrokerOrderId = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly validator: ManualTradeValidatorService,
    private readonly lifecycle: PositionLifecycleService,
    private readonly masterWatcher: MasterWatcherService,
    private readonly recorder: ExecutionEventRecorderService,
  ) {}

  onModuleInit() {
    // Correlate manual trade → follower fan-out outcome. The recorder
    // fires this every time CopyTradingService commits an ExecutionEvent
    // (whether from the master watcher, the lifecycle sync engine, or
    // the manual trade path). Correlation is by masterBrokerOrderId —
    // the fan-out for a manual order may arrive tagged `MANUAL`
    // (immediate COMPLETE_FILL) or `BROKER_POLL` (fill detected by the
    // post-placement master-watcher reconciliation).
    this.recorder.onCommit((event) => this.handleExecutionCommit(event));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async place(dto: PlaceManualTradeDto): Promise<ManualTradeRecord> {
    // 1) Validate
    const validation = await this.validator.validate(dto);

    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ManualTradeRecord = {
      id,
      masterAccountId: dto.masterAccountId,
      masterAccountName: validation.resolvedMaster?.nickname ?? null,
      strategyId: dto.strategyId,
      strategyName: validation.resolvedStrategy?.name ?? null,
      broker: (validation.resolvedMaster?.broker as Broker) ?? Broker.ZERODHA,
      exchange: dto.exchange,
      symbol: dto.symbol,
      side: dto.side,
      orderType: dto.orderType,
      quantity: dto.quantity,
      product: dto.product,
      price: dto.price ?? null,
      triggerPrice: dto.triggerPrice ?? null,
      validity: dto.validity ?? 'DAY',
      marketProtection:
        validation.resolvedMaster &&
        supportsMarketProtection(validation.resolvedMaster.broker) &&
        dto.orderType === 'MARKET'
          ? dto.marketProtection ?? 'AUTO'
          : null,
      status: ManualTradeStatus.PENDING,
      brokerOrderId: null,
      brokerResponse: null,
      rejectionReason: null,
      failureType: null,
      failureStage: null,
      validation,
      executionEventId: null,
      followersFound: validation.resolvedStrategy?.followerCount ?? 0,
      followers: [],
      successfulFollowers: 0,
      failedFollowers: 0,
      skippedFollowers: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.remember(record);

    if (!validation.ok) {
      record.status = ManualTradeStatus.REJECTED;
      record.rejectionReason = validation.errors
        .map((e) => `${e.key}: ${e.message}`)
        .join('; ');
      record.failureType = 'VALIDATION_FAILED';
      record.failureStage = 'preflight_validation';
      record.updatedAt = new Date().toISOString();
      throw new BadRequestException({
        message: record.rejectionReason,
        manualTradeId: record.id,
        stage: 'preflight_validation',
        failureType: record.failureType,
        brokerMessage: null,
        timestamp: record.updatedAt,
        errors: validation.errors,
        record,
      });
    }

    const master = validation.resolvedMaster!;
    const instrument: ResolvedInstrument | null =
      validation.resolvedInstrument ?? null;

    // 2) Place on master broker via the existing adapter.
    let placementResponse: unknown;
    let brokerOrderId: string | null = null;
    try {
      const result = await this.placeOnMaster(
        master.id,
        master.broker,
        dto,
        instrument,
      );
      placementResponse = result.response;
      brokerOrderId = result.brokerOrderId;
    } catch (err: any) {
      // Broker adapter surfaced an exception (auth failure, network,
      // rate limit, KiteConnect / Fyers rejection). Preserve the FULL
      // broker message end-to-end — the UI must show exactly what the
      // broker said (e.g. "No IPs configured for this app.", "Trading
      // in NSE is not allowed using NRML product type.").
      const brokerMessage =
        pickBrokerMessage(err) ?? err?.message ?? 'Master broker placement failed';
      const failureType = classifyFailure({
        message: brokerMessage,
        response: err,
      });
      record.status = ManualTradeStatus.FAILED;
      record.rejectionReason = brokerMessage;
      record.failureType = failureType;
      record.failureStage = 'broker_error';
      record.brokerResponse = safeErrorSnapshot(err);
      record.updatedAt = new Date().toISOString();
      this.logger.error(
        `Manual trade ${record.id} FAILED at broker placement: ${brokerMessage}`,
      );
      throw new BadRequestException({
        message: brokerMessage,
        manualTradeId: record.id,
        stage: 'broker_error',
        failureType,
        brokerMessage,
        timestamp: record.updatedAt,
        brokerResponse: record.brokerResponse,
        record,
      });
    }

    record.brokerResponse = placementResponse;
    record.brokerOrderId = brokerOrderId;
    record.updatedAt = new Date().toISOString();

    if (!brokerOrderId) {
      // Adapter returned a non-throwing rejection payload (e.g.
      // `{ s: 'error', message: '...' }` from Fyers, or a Zerodha
      // response without an order_id). Bubble up the exact broker
      // text — never a generic placeholder.
      const brokerMessage =
        extractRejectionReason(placementResponse) ??
        'Master broker did not return a valid order id';
      const failureType = classifyFailure({
        message: brokerMessage,
        response: placementResponse,
      });
      record.status = ManualTradeStatus.REJECTED;
      record.rejectionReason = brokerMessage;
      record.failureType = failureType;
      record.failureStage = 'broker_placement';
      this.logger.warn(
        `Manual trade ${record.id} REJECTED by master broker: ${brokerMessage}`,
      );
      throw new BadRequestException({
        message: brokerMessage,
        manualTradeId: record.id,
        stage: 'broker_placement',
        failureType,
        brokerMessage,
        timestamp: record.updatedAt,
        brokerResponse: placementResponse,
        record,
      });
    }

    record.status = ManualTradeStatus.ACCEPTED;
    record.updatedAt = new Date().toISOString();
    this.byBrokerOrderId.set(brokerOrderKey(master.broker, brokerOrderId), record.id);

    // 3) Route into the position-lifecycle pipeline — exact same
    //    entry point the master watcher uses. Any broker order that
    //    is COMPLETE at this point triggers the CopyTradingService
    //    fan-out; otherwise the lifecycle layer tracks it and the
    //    master watcher poll will handle the eventual fill.
    record.status = ManualTradeStatus.EXECUTING_FOLLOWERS;
    record.updatedAt = new Date().toISOString();

    try {
      const rawOrder = await this.fetchPlacedOrder(
        master.id,
        master.broker,
        brokerOrderId,
      );
      const surrogate =
        rawOrder ??
        this.buildOptimisticOrder(
          dto,
          brokerOrderId,
          placementResponse,
          master.broker,
          instrument,
        );

      await this.lifecycle.ingest(
        {
          broker: master.broker,
          tradingAccountId: master.id,
          tradeSource: MANUAL_TRADE_SOURCE,
        },
        surrogate,
      );
    } catch (err: any) {
      // Lifecycle ingest failure MUST NOT roll back the broker order —
      // the order is on the exchange. We surface the failure on the
      // manual trade record so the UI can flag it, and rely on the
      // next master-watcher poll to re-attempt ingestion.
      this.logger.warn(
        `Manual trade ${record.id} placed on broker but lifecycle ingest failed: ${err?.message ?? err}`,
      );
      record.rejectionReason = `Lifecycle ingest error — ${err?.message ?? 'unknown'} (order placed on broker)`;
      record.updatedAt = new Date().toISOString();
    }

    // Sprint 6.2.12 — with the continuous master poller removed, run one
    // reconciliation cycle against the master's broker right after a
    // successful placement so the authoritative broker order state (and any
    // resulting copy fan-out) is picked up immediately. A sync failure must
    // never roll back the placed order.
    try {
      await this.masterWatcher.syncMaster(master.id);
    } catch (err: any) {
      this.logger.warn(
        `Manual trade ${record.id} placed on broker but post-placement sync failed: ${err?.message ?? err}`,
      );
    }

    return this.get(record.id) ?? record;
  }

  get(id: string): ManualTradeRecord | null {
    return this.records.get(id) ?? null;
  }

  listRecent(limit = 20): ManualTradeRecord[] {
    const capped = Math.min(Math.max(limit, 1), BUFFER_CAPACITY);
    const arr = Array.from(this.records.values());
    arr.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return arr.slice(0, capped);
  }

  // -------------------------------------------------------------------------
  // Broker placement (reuses existing adapters — no duplicate broker logic)
  // -------------------------------------------------------------------------

  private async placeOnMaster(
    tradingAccountId: string,
    broker: Broker,
    dto: PlaceManualTradeDto,
    instrument?: ResolvedInstrument | null,
  ): Promise<{ response: unknown; brokerOrderId: string | null }> {
    const session = await this.prisma.brokerSession.findFirst({
      where: { tradingAccountId, broker },
    });
    if (!session) {
      throw new NotFoundException(
        `No broker session for master account ${tradingAccountId} on ${broker}`,
      );
    }
    const accessToken = this.encryption.decrypt(session.encryptedAccessToken);

    if (broker === Broker.ZERODHA) {
      const adapter = new ZerodhaAdapter();
      adapter.setAccessToken(accessToken);
      const order = buildZerodhaOrder(dto);
      const response = await adapter.placeOrder(order);
      return { response, brokerOrderId: extractZerodhaOrderId(response) };
    }

    if (broker === Broker.FYERS) {
      // Fyers account isolation for placement: the authenticated header is
      // `appId:accessToken`, so the order MUST be placed with THIS account's
      // own App ID (api key) + Secret ID — the same credentials the OAuth
      // token was minted under — never the global FYERS_APP_ID env value.
      const account = await this.prisma.tradingAccount.findUnique({
        where: { id: tradingAccountId },
      });
      const adapter = new FyersAdapter();
      adapter.setCredentials(
        account?.encryptedApiKey
          ? this.encryption.decrypt(account.encryptedApiKey)
          : '',
        account?.encryptedApiSecret
          ? this.encryption.decrypt(account.encryptedApiSecret)
          : '',
      );
      adapter.setAccessToken(accessToken);
      const order = buildFyersOrder(dto);
      // TEMPORARY DIAGNOSTICS — attach account context so the Fyers order log
      // (FyersAdapter.placeOrder) records TradingAccountId / Broker User ID /
      // source module. Logging only: does not alter the order, adapter or flow.
      adapter.setOrderDiagnosticContext({
        tradingAccountId,
        brokerUserId: session.userId ?? null,
        sourceModule: 'ManualTradeService.placeOnMaster (MANUAL)',
        environment: process.env.NODE_ENV ?? null,
        accessTokenExpiry: session.expiresAt
          ? session.expiresAt.toISOString()
          : null,
      });
      const response = await adapter.placeOrder(order);
      return { response, brokerOrderId: extractFyersOrderId(response) };
    }

    if (broker === Broker.ICICI_DIRECT) {
      // ICICI Direct (Breeze) needs the account api key/secret alongside the
      // session token to sign the checksum-authenticated place_order call.
      const account = await this.prisma.tradingAccount.findUnique({
        where: { id: tradingAccountId },
      });
      const adapter = new ICICIDirectAdapter();
      adapter.setCredentials(
        account?.encryptedApiKey
          ? this.encryption.decrypt(account.encryptedApiKey)
          : '',
        account?.encryptedApiSecret
          ? this.encryption.decrypt(account.encryptedApiSecret)
          : '',
      );
      adapter.setSessionToken(accessToken);
      const order = buildIciciPlaceOrder({
        stockCode: dto.symbol,
        exchange: dto.exchange,
        side: dto.side,
        orderType: dto.orderType,
        quantity: dto.quantity,
        price: dto.price ?? null,
        triggerPrice: dto.triggerPrice ?? null,
        validity: dto.validity ?? 'DAY',
        instrument: instrument ?? null,
        remark: 'CTS Manual Trade',
      });
      const response = await adapter.placeOrder(order);
      return { response, brokerOrderId: extractIciciOrderId(response) };
    }

    if (broker === Broker.UPSTOX) {
      // Sprint 6.3 — Upstox uses a per-account Bearer token; the /order/place
      // payload is keyed on the `instrument_token` (Upstox instrument key),
      // which we persisted as InstrumentBroker.brokerToken during import.
      const account = await this.prisma.tradingAccount.findUnique({
        where: { id: tradingAccountId },
      });
      const adapter = new UpstoxAdapter();
      adapter.setCredentials(
        account?.encryptedApiKey
          ? this.encryption.decrypt(account.encryptedApiKey)
          : '',
        account?.encryptedApiSecret
          ? this.encryption.decrypt(account.encryptedApiSecret)
          : '',
      );
      adapter.setAccessToken(accessToken);
      const instrumentToken = await this.resolveUpstoxInstrumentToken(
        dto.symbol,
        dto.exchange,
      );
      const order = buildUpstoxPlaceOrder({
        instrumentToken,
        side: dto.side,
        orderType: dto.orderType,
        quantity: dto.quantity,
        product: dto.product,
        price: dto.price ?? null,
        triggerPrice: dto.triggerPrice ?? null,
        validity: dto.validity ?? 'DAY',
        tag: 'CTSManual',
      });
      const response = await adapter.placeOrder(order);
      return { response, brokerOrderId: extractUpstoxOrderId(response) };
    }

    throw new BadRequestException(
      `Broker ${broker} not supported for manual trade placement`,
    );
  }

  private async resolveUpstoxInstrumentToken(
    symbol: string,
    exchange: string,
  ): Promise<string> {
    const mapping = await this.prisma.instrumentBroker.findFirst({
      where: { broker: Broker.UPSTOX, brokerSymbol: symbol, exchange },
      select: { brokerToken: true },
    });
    // Fall back to the raw symbol when no mapping/token exists — Upstox will
    // reject it with an explicit message the UI surfaces verbatim.
    return mapping?.brokerToken ?? symbol;
  }

  private async fetchPlacedOrder(
    tradingAccountId: string,
    broker: Broker,
    brokerOrderId: string,
  ): Promise<any | null> {
    try {
      const session = await this.prisma.brokerSession.findFirst({
        where: { tradingAccountId, broker },
      });
      if (!session) return null;
      const accessToken = this.encryption.decrypt(session.encryptedAccessToken);

      if (broker === Broker.ZERODHA) {
        const adapter = new ZerodhaAdapter();
        adapter.setAccessToken(accessToken);
        const orders = await adapter.getOrders();
        if (!Array.isArray(orders)) return null;
        return (
          orders.find((o: any) => String(o?.order_id) === brokerOrderId) ??
          null
        );
      }

      if (broker === Broker.FYERS) {
        // Fyers account isolation: read-back of the just-placed order is an
        // authenticated (`appId:accessToken`) call too, so bind THIS account's
        // own App ID + Secret, never the global env App ID.
        const account = await this.prisma.tradingAccount.findUnique({
          where: { id: tradingAccountId },
        });
        const adapter = new FyersAdapter();
        adapter.setCredentials(
          account?.encryptedApiKey
            ? this.encryption.decrypt(account.encryptedApiKey)
            : '',
          account?.encryptedApiSecret
            ? this.encryption.decrypt(account.encryptedApiSecret)
            : '',
        );
        adapter.setAccessToken(accessToken);
        const orders = await adapter.getOrders();
        const list = orders?.orderBook ?? orders?.data ?? orders;
        if (!Array.isArray(list)) return null;
        return (
          list.find((o: any) => String(o?.id) === brokerOrderId) ?? null
        );
      }

      if (broker === Broker.ICICI_DIRECT) {
        const account = await this.prisma.tradingAccount.findUnique({
          where: { id: tradingAccountId },
        });
        const adapter = new ICICIDirectAdapter();
        adapter.setCredentials(
          account?.encryptedApiKey
            ? this.encryption.decrypt(account.encryptedApiKey)
            : '',
          account?.encryptedApiSecret
            ? this.encryption.decrypt(account.encryptedApiSecret)
            : '',
        );
        adapter.setSessionToken(accessToken);
        const orders = await adapter.getOrders();
        const list = Array.isArray(orders) ? orders : orders ? [orders] : [];
        return (
          list.find((o: any) => String(o?.order_id) === brokerOrderId) ?? null
        );
      }

      if (broker === Broker.UPSTOX) {
        const account = await this.prisma.tradingAccount.findUnique({
          where: { id: tradingAccountId },
        });
        const adapter = new UpstoxAdapter();
        adapter.setCredentials(
          account?.encryptedApiKey
            ? this.encryption.decrypt(account.encryptedApiKey)
            : '',
          account?.encryptedApiSecret
            ? this.encryption.decrypt(account.encryptedApiSecret)
            : '',
        );
        adapter.setAccessToken(accessToken);
        const orders = await adapter.getOrders();
        const list = Array.isArray(orders?.data) ? orders.data : [];
        return (
          list.find((o: any) => String(o?.order_id) === brokerOrderId) ?? null
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Unable to fetch placed order ${brokerOrderId} for ${broker}: ${err?.message}`,
      );
    }
    return null;
  }

  /**
   * When the broker adapter did not return a full order object in the
   * placement window (some brokers lag by a few hundred ms), we
   * fabricate a broker-shaped surrogate that reflects "order placed,
   * status open/complete depending on order type". The lifecycle
   * normalizer treats it identically to a poll-detected order. The
   * next master-watcher poll (every 3s) will supersede it with the
   * real broker payload via the signature-change gate.
   */
  private buildOptimisticOrder(
    dto: PlaceManualTradeDto,
    brokerOrderId: string,
    placementResponse: unknown,
    broker: Broker,
    instrument?: ResolvedInstrument | null,
  ): any {
    const nowIso = new Date().toISOString();
    // MARKET orders are assumed instantly filled so the lifecycle
    // manager delegates to CopyTradingService.handleTrade
    // immediately. LIMIT / SL / SL-M are optimistically treated as
    // OPEN until the master-watcher poll confirms a fill.
    const isMarket = dto.orderType === 'MARKET';

    if (broker === Broker.FYERS) {
      return {
        id: brokerOrderId,
        status: isMarket ? 2 /* Filled */ : 6 /* Pending */,
        symbol: dto.symbol,
        exchange: dto.exchange,
        side: dto.side === 'BUY' ? 1 : -1,
        qty: dto.quantity,
        filledQty: isMarket ? dto.quantity : 0,
        tradedPrice: isMarket ? dto.price ?? 0 : 0,
        limitPrice: dto.price ?? 0,
        stopPrice: dto.triggerPrice ?? 0,
        type: fyersOrderTypeCode(dto.orderType),
        productType: fyersProduct(dto.product),
        orderDateTime: nowIso,
        message: extractRejectionReason(placementResponse) ?? null,
      };
    }

    if (broker === Broker.ICICI_DIRECT) {
      // Breeze order-shaped surrogate (matches getOrders() field names the
      // ICICI lifecycle normalizer understands).
      return {
        order_id: brokerOrderId,
        status: isMarket ? 'Executed' : 'Ordered',
        stock_code: dto.symbol,
        exchange_code: dto.exchange,
        action: dto.side === 'BUY' ? 'Buy' : 'Sell',
        quantity: dto.quantity,
        pending_quantity: isMarket ? 0 : dto.quantity,
        price: dto.price ?? 0,
        average_price: isMarket ? dto.price ?? 0 : 0,
        stoploss: dto.triggerPrice ?? 0,
        order_type: iciciOrderType(dto.orderType),
        product: resolveIciciProduct(instrument),
        validity: (dto.validity ?? 'DAY').toLowerCase(),
        order_datetime: nowIso,
        message: extractRejectionReason(placementResponse) ?? null,
      };
    }

    if (broker === Broker.UPSTOX) {
      // Upstox order-shaped surrogate (matches getOrders() field names the
      // Upstox lifecycle normalizer understands).
      return {
        order_id: brokerOrderId,
        status: isMarket ? 'complete' : 'open',
        tradingsymbol: dto.symbol,
        exchange: dto.exchange,
        transaction_type: dto.side,
        quantity: dto.quantity,
        filled_quantity: isMarket ? dto.quantity : 0,
        average_price: isMarket ? dto.price ?? 0 : 0,
        price: dto.price ?? 0,
        trigger_price: dto.triggerPrice ?? 0,
        order_type: dto.orderType,
        product: dto.product === 'MIS' ? 'I' : 'D',
        order_timestamp: nowIso,
        status_message: extractRejectionReason(placementResponse) ?? null,
      };
    }

    // Default to Zerodha shape (matches ZerodhaImporter's canonical
    // key names — the lifecycle normalizer already understands them).
    return {
      order_id: brokerOrderId,
      status: isMarket ? 'COMPLETE' : 'OPEN',
      tradingsymbol: dto.symbol,
      exchange: dto.exchange,
      transaction_type: dto.side,
      quantity: dto.quantity,
      filled_quantity: isMarket ? dto.quantity : 0,
      average_price: isMarket ? dto.price ?? 0 : 0,
      price: dto.price ?? 0,
      trigger_price: dto.triggerPrice ?? 0,
      order_type: dto.orderType,
      product: dto.product,
      validity: dto.validity ?? 'DAY',
      order_timestamp: nowIso,
      exchange_update_timestamp: nowIso,
      status_message: extractRejectionReason(placementResponse) ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // ExecutionEventRecorder subscription — correlation & status
  // -------------------------------------------------------------------------

  private handleExecutionCommit(event: ExecutionEvent) {
    // Correlate purely on the master broker order id. `byBrokerOrderId`
    // only ever contains orders placed by THIS service, so an order-id
    // match IS a manual trade regardless of the event's tradeSource
    // (a Fyers fill is often detected by the post-placement watcher
    // reconciliation, which commits the fan-out as `BROKER_POLL`).
    if (!event.masterBrokerOrderId) return;

    const key = brokerOrderKey(event.broker, event.masterBrokerOrderId);
    const manualId = this.byBrokerOrderId.get(key);
    if (!manualId) return;

    const record = this.records.get(manualId);
    if (!record) return;

    if (TERMINAL_STATUSES.has(record.status)) {
      // Already finalised — duplicate/late ExecutionEvent, idempotent no-op.
      return;
    }

    const previousStatus = record.status;

    const followers: ManualTradeFollowerOutcome[] = event.followers.map((f) => ({
      followerId: f.followerId,
      followerEmail: f.followerEmail,
      broker: f.broker,
      status: f.status,
      failureType: f.failureType,
      reason: f.reason,
      followerSymbol: f.followerSymbol,
      quantity: f.quantity,
      brokerOrderId: extractBrokerOrderIdFromResponse(f.brokerResponse),
    }));

    const successful = followers.filter((f) => f.status === 'SUCCESS').length;
    const failed = followers.filter((f) => f.status === 'FAILED').length;
    const skipped = followers.filter((f) => f.status === 'SKIPPED').length;

    let status: ManualTradeStatus;
    if (event.outcome === 'NO_ACTIVE_STRATEGY' || event.outcome === 'NO_ENABLED_FOLLOWERS') {
      status = ManualTradeStatus.FAILED;
    } else if (event.outcome === 'ERROR') {
      status = ManualTradeStatus.FAILED;
    } else if (followers.length === 0) {
      status = ManualTradeStatus.FAILED;
    } else if (failed === 0 && skipped === 0) {
      status = ManualTradeStatus.COMPLETED;
    } else if (successful === 0) {
      status = ManualTradeStatus.FAILED;
    } else {
      status = ManualTradeStatus.PARTIAL;
    }

    record.executionEventId = event.id;
    record.followers = followers;
    record.followersFound = event.followersFound;
    record.successfulFollowers = successful;
    record.failedFollowers = failed;
    record.skippedFollowers = skipped;
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (event.outcome === 'ERROR' && event.errorReason) {
      record.rejectionReason = event.errorReason;
    }

    this.logger.debug(
      `Manual trade ${record.id} matched ExecutionEvent ${event.id} — ` +
        `brokerOrderId=${event.masterBrokerOrderId} tradeSource=${event.tradeSource} ` +
        `status ${previousStatus} → ${status} ` +
        `(success=${successful} failed=${failed} skipped=${skipped} outcome=${event.outcome})`,
    );
  }

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  private remember(record: ManualTradeRecord) {
    this.records.set(record.id, record);
    if (this.records.size > BUFFER_CAPACITY) {
      const oldest = Array.from(this.records.values()).sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : 1,
      )[0];
      if (oldest) {
        this.records.delete(oldest.id);
        if (oldest.brokerOrderId) {
          this.byBrokerOrderId.delete(
            brokerOrderKey(oldest.broker, oldest.brokerOrderId),
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Broker order builders (kept local — no duplicated broker logic, just
// argument shaping around the existing adapters)
// ---------------------------------------------------------------------------

function buildZerodhaOrder(dto: PlaceManualTradeDto) {
  const order: Record<string, unknown> = {
    exchange: dto.exchange,
    tradingsymbol: dto.symbol,
    transaction_type: dto.side,
    quantity: dto.quantity,
    product: dto.product,
    order_type: dto.orderType,
    validity: dto.validity ?? 'DAY',
  };
  if (dto.price !== undefined && (dto.orderType === 'LIMIT' || dto.orderType === 'SL')) {
    order.price = dto.price;
  }
  if (
    dto.triggerPrice !== undefined &&
    (dto.orderType === 'SL' || dto.orderType === 'SL-M')
  ) {
    order.trigger_price = dto.triggerPrice;
  }
  // Sprint 5.4.2 — Zerodha Market Protection. `AUTO` (or omitted)
  // means "let Kite use its default" and is expressed by NOT sending
  // the field. Every other selector serialises to an explicit
  // percentage (0 for NONE, 2/5/10 for the fixed steps).
  if (dto.orderType === 'MARKET' && dto.marketProtection) {
    const pct = marketProtectionPercent(dto.marketProtection);
    if (pct !== null) {
      order.market_protection = pct;
    }
  }
  return order;
}

function buildFyersOrder(dto: PlaceManualTradeDto) {
  return {
    symbol: dto.symbol,
    qty: dto.quantity,
    type: fyersOrderTypeCode(dto.orderType),
    side: dto.side === 'BUY' ? 1 : -1,
    productType: fyersProduct(dto.product),
    limitPrice: dto.price ?? 0,
    stopPrice: dto.triggerPrice ?? 0,
    disclosedQty: 0,
    validity: dto.validity ?? 'DAY',
    offlineOrder: false,
  };
}

function fyersOrderTypeCode(orderType: PlaceManualTradeDto['orderType']): number {
  switch (orderType) {
    case 'LIMIT':
      return 1;
    case 'MARKET':
      return 2;
    case 'SL':
      return 4;
    case 'SL-M':
      return 3;
    default:
      return 2;
  }
}

function fyersProduct(product: PlaceManualTradeDto['product']): string {
  switch (product) {
    case 'CNC':
      return 'CNC';
    case 'MIS':
      return 'INTRADAY';
    case 'NRML':
      return 'MARGIN';
    default:
      return 'INTRADAY';
  }
}

function extractZerodhaOrderId(response: unknown): string | null {
  if (!response) return null;
  if (typeof response === 'string' && response.length > 0) return response;
  if (typeof response === 'object') {
    const r = response as Record<string, unknown>;
    for (const key of ['order_id', 'orderId', 'orderid']) {
      const v = r[key];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number') return String(v);
    }
  }
  return null;
}

function extractFyersOrderId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  if (r.s !== 'ok') return null;
  const id = r.id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number') return String(id);
  return null;
}

// ---------------------------------------------------------------------------
// ICICI Direct (Breeze) order shaping — the Breeze place_order payload is now
// produced by the shared `buildIciciPlaceOrder` mapper (single source of
// truth). Only the lifecycle-surrogate order_type helper remains local.
// ---------------------------------------------------------------------------

function iciciOrderType(orderType: PlaceManualTradeDto['orderType']): string {
  switch (orderType) {
    case 'LIMIT':
      return 'limit';
    case 'SL':
    case 'SL-M':
      return 'stoploss';
    case 'MARKET':
    default:
      return 'market';
  }
}

function extractIciciOrderId(response: unknown): string | null {
  if (!response) return null;
  if (typeof response === 'string' && response.length > 0) return response;
  if (typeof response === 'object') {
    const r = response as Record<string, unknown>;
    for (const key of ['order_id', 'orderId', 'OrderId']) {
      const v = r[key];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number') return String(v);
    }
  }
  return null;
}

function extractUpstoxOrderId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, any>;
  const data = r.data ?? r;
  if (data && typeof data === 'object') {
    if (typeof data.order_id === 'string' && data.order_id.length > 0)
      return data.order_id;
    if (Array.isArray(data.order_ids) && data.order_ids.length > 0)
      return String(data.order_ids[0]);
  }
  return null;
}

function extractRejectionReason(response: unknown): string | null {
  if (!response) return null;
  if (typeof response === 'string') return response.trim() || null;
  if (typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  const candidates = [
    r.message,
    r.emsg,
    r.error,
    r.error_message,
    r.status_message,
    r.errorMessage,
    r.reason,
    r.description,
    (r.data as any)?.message,
    (r.data as any)?.emsg,
    (r.data as any)?.error,
    Array.isArray((r as any).errors) ? (r as any).errors?.[0]?.message : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

/**
 * Pull the fullest possible broker text out of an exception thrown by
 * a broker adapter (KiteConnect, Fyers) or a plain axios-style error.
 * Preserves the entire message verbatim — never truncated — so the UI
 * can render the exact broker response to the operator.
 */
function pickBrokerMessage(err: any): string | null {
  if (!err) return null;
  if (typeof err === 'string') return err.trim() || null;

  // Kite / axios-style errors expose the broker text under
  // response.data / data.message; direct throws carry it on `message`.
  const nested = extractRejectionReason(err);
  if (nested) return nested;

  const response = err.response ?? err.data;
  if (response) {
    const inner = extractRejectionReason(response);
    if (inner) return inner;
  }

  if (typeof err.message === 'string' && err.message.trim().length > 0) {
    return err.message.trim();
  }
  return null;
}

/**
 * Serialise a thrown adapter error into something safe to persist and
 * ship back through the JSON response. Retains ALL identifying fields
 * (name, message, error_type, code, status, broker payload) without
 * truncation so downstream tooling has the full context.
 */
function safeErrorSnapshot(err: any): unknown {
  if (!err || typeof err !== 'object') {
    return err ?? null;
  }
  const out: Record<string, unknown> = {};
  for (const key of [
    'name',
    'message',
    'error_type',
    'code',
    'status',
    'statusText',
  ]) {
    const v = err[key];
    if (v !== undefined && v !== null) out[key] = v;
  }
  const response = err.response ?? err.data;
  if (response && typeof response === 'object') {
    // Response payloads from HTTP clients often carry a `data` field
    // with the broker's raw JSON — persist it verbatim.
    const data = (response as any).data ?? response;
    try {
      out.brokerResponse = JSON.parse(JSON.stringify(data));
    } catch {
      out.brokerResponse = String(data);
    }
  }
  return out;
}

function extractBrokerOrderIdFromResponse(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  for (const key of ['order_id', 'orderId', 'orderid', 'id']) {
    const v = r[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function brokerOrderKey(broker: string, brokerOrderId: string): string {
  return `${broker}:${brokerOrderId}`;
}
