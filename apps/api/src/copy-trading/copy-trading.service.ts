import { Injectable, Logger } from '@nestjs/common';
import { Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { InstrumentTranslationService } from '../instruments/instrument-translation.service';

import { TradeEvent } from './dto/trade-event.dto';
import { ResolvedInstrument } from '../brokers/order-mapping/instrument-context';
import {
  ExecutionEventRecorderService,
} from './execution-event.recorder';
import { activeMasterStrategyWhere } from '../common/active-master-strategy';
import { FollowerExecutionService } from '../brokers/execution/follower-execution.service';
import { ExecutionResultCategory } from './execution-result-category';
import { currentManualTradeTrace } from '../observability/manual-trade-trace';

@Injectable()
export class CopyTradingService {
  private readonly logger = new Logger(CopyTradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly translation: InstrumentTranslationService,
    private readonly recorder: ExecutionEventRecorderService,
    private readonly followerExec: FollowerExecutionService,
  ) {}

  async handleTrade(event: TradeEvent) {

    this.logger.log(
      `MASTER TRADE : ${event.side} ${event.symbol} Qty:${event.quantity}`,
    );

    // Operational recorder — additive; does not influence execution. Committed
    // in the final `finally` so every real handleTrade invocation lands in the
    // admin Trade Monitor exactly once, whether it succeeds, is short-circuited
    // (no strategy / no followers) or throws.
    const master = await this.prisma.tradingAccount.findUnique({
      where: { id: event.tradingAccountId },
      select: { nickname: true },
    });

    const builder = this.recorder.begin({
      masterAccountId: event.tradingAccountId,
      masterAccountNickname: master?.nickname ?? null,
      broker: event.broker,
      symbol: event.symbol,
      side: event.side,
      quantity: event.quantity,
      price: event.price ?? null,
      productType: event.product,
      tradeSource: event.source ?? 'BROKER_POLL',
      orderId: event.orderId ?? null,
      timestamp: event.timestamp,
    });

    try {
      //-----------------------------------------
      // Find ACTIVE strategy
      //-----------------------------------------

      const strategy = await this.prisma.strategy.findFirst({
        where: activeMasterStrategyWhere(event.tradingAccountId),
      });

      if (!strategy) {
        this.logger.warn(
          `No ACTIVE strategy found for ${event.tradingAccountId}`,
        );
        builder.markNoActiveStrategy();
        return;
      }

      builder.setStrategy({ id: strategy.id, name: strategy.strategyName });

      //-----------------------------------------
      // Followers
      //-----------------------------------------

      const followers = await this.prisma.follower.findMany({
        where: {
          strategyId: strategy.id,
          enabled: true,
        },
        include: {
          followerUser: true,
          tradingAccount: true,
        },
      });

      builder.setFollowersFound(followers.length);

      if (followers.length === 0) {
        this.logger.warn('No followers subscribed.');
        builder.markNoEnabledFollowers();
        return;
      }

      this.logger.log(
        `Followers Found : ${followers.length}`,
      );

      //-----------------------------------------
      // Execute
      //-----------------------------------------

      for (const follower of followers) {

        const rec = builder.addFollower({
          followerId: follower.id,
          followerName:
            follower.followerUser.name || follower.followerUser.email,
          followerEmail: follower.followerUser.email,
          followerAccountId: follower.tradingAccount.id,
          broker: follower.tradingAccount.broker,
        });

        try {

          const followerBroker = follower.tradingAccount.broker;

          //-----------------------------------------
          // Qty
          //-----------------------------------------

          const qty = Math.round(
            event.quantity * follower.multiplier,
          );

          rec.setQuantity(qty);

          //-----------------------------------------
          // Instrument translation — SINGLE canonical path
          // (InstrumentTranslationService). Same service the Translation UI
          // uses via InstrumentResolverService.translate. Normalization +
          // deterministic lookup live INSIDE the service; the copy engine does
          // no symbol manipulation and no exchange-constrained lookup here.
          //-----------------------------------------

          const translated = await this.translation.translate({
            sourceBroker: event.broker as Broker,
            sourceSymbol: event.symbol,
            targetBroker: followerBroker,
            exchange: event.exchange || null,
            correlationId: currentManualTradeTrace()?.correlationId ?? null,
          });

          if (!translated.found) {

            this.logger.error(
              `Instrument translation failed [${translated.stage}] : ` +
                `${event.broker} ${event.symbol} -> ${followerBroker} — ${translated.reason}`,
            );

            rec.fail(
              translated.stage === 'TARGET_NOT_FOUND'
                ? ExecutionResultCategory.SYMBOL_MAPPING_FAILED
                : ExecutionResultCategory.INSTRUMENT_NOT_FOUND,
              translated.reason,
            );

            continue;

          }

          rec.setBrokerSymbol(translated.targetSymbol);

          this.logger.log(
            `Executing ${followerBroker} Order -> ${follower.followerUser.email}`,
          );
          this.logger.log(`MASTER SYMBOL  : ${event.symbol}`);
          this.logger.log(`FOLLOWER SYMBOL: ${translated.targetSymbol}`);
          this.logger.log(`BROKER         : ${followerBroker}`);

          rec.setStatus('EXECUTING');

          const resolvedInstrument: ResolvedInstrument = {
            contractKey: translated.contractKey,
            exchange: translated.exchange,
            segment: translated.segment,
            instrumentType: translated.instrumentType,
            optionType: translated.optionType,
            strike: translated.strike,
            expiry: translated.expiry,
            underlying: translated.underlying,
          };

          //-----------------------------------------
          // Dynamic broker execution via the EXISTING Broker Factory
          // (BrokerService.getAdapterForAccount, wrapped by
          // FollowerExecutionService). It receives the ALREADY-translated
          // broker instrument and performs NO lookup / symbol manipulation.
          //-----------------------------------------

          const result = await this.followerExec.place({
            followerAccountId: follower.tradingAccount.id,
            broker: followerBroker,
            side: event.side,
            quantity: qty,
            brokerSymbol: translated.targetSymbol,
            brokerToken: translated.token,
            exchange: translated.exchange,
            instrument: resolvedInstrument,
            product: event.product,
            followerId: follower.id,
            correlationId: currentManualTradeTrace()?.correlationId ?? null,
          });

          this.logger.log(JSON.stringify(result.orderRequest, null, 2));

          if (result.success) {
            this.logger.log(`SUCCESS -> ${JSON.stringify(result.rawResponse)}`);
          } else {
            this.logger.error(
              `BROKER ERROR [${result.category}] -> ${JSON.stringify(result.rawResponse)}`,
            );
          }

          rec.recordStandardResult(result);

        } catch (e: any) {

          this.logger.error(
            `${follower.followerUser.email} : ${e.message}`,
          );

          rec.fail(
            ExecutionResultCategory.UNKNOWN_BROKER_ERROR,
            e?.message ?? 'Unhandled follower execution error',
            { name: e?.name, message: e?.message },
          );

        }

      }

    } catch (e: any) {
      this.logger.error(
        `handleTrade failed for ${event.tradingAccountId}: ${e?.message}`,
      );
      builder.markTopLevelError(e?.message ?? 'Unhandled error in handleTrade');
      throw e;
    } finally {
      builder.commit();
    }

  }

}
