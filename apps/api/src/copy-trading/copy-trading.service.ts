import { Injectable, Logger } from '@nestjs/common';
import { Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { InstrumentResolverService } from '../instruments/instrument-resolver.service';

import { TradeEvent } from './dto/trade-event.dto';
import { FyersAdapter } from '../brokers/fyers/fyers.adapter';
import {
  ExecutionEventRecorderService,
} from './execution-event.recorder';
import { classifyFailure } from './execution-event.recorder';

@Injectable()
export class CopyTradingService {
  private readonly logger = new Logger(CopyTradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly resolver: InstrumentResolverService,
    private readonly recorder: ExecutionEventRecorderService,
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
        where: {
          tradingAccountId: event.tradingAccountId,
          masterAccount: true,
          enabled: true,
          status: 'ACTIVE',
        },
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

          //-----------------------------------------
          // Only FYERS for MVP
          //-----------------------------------------

          if (follower.tradingAccount.broker !== Broker.FYERS) {

            this.logger.warn(
              `Skipping ${follower.followerUser.email} (${follower.tradingAccount.broker})`,
            );

            rec.skip(
              'BROKER_UNSUPPORTED',
              `Broker ${follower.tradingAccount.broker} is not supported for copy execution (Fyers only, MVP)`,
            );

            continue;
          }

          //-----------------------------------------
          // Broker Session
          //-----------------------------------------

          const session = await this.prisma.brokerSession.findFirst({
            where: {
              tradingAccountId: follower.tradingAccount.id,
              broker: Broker.FYERS,
            },
          });

          if (!session) {

            this.logger.warn(
              `No broker session for ${follower.followerUser.email}`,
            );

            rec.skip(
              'NO_BROKER_SESSION',
              'No broker session on follower trading account',
            );

            continue;
          }

          //-----------------------------------------
          // Adapter
          //-----------------------------------------

          const adapter = new FyersAdapter();

          adapter.setAccessToken(
            this.encryption.decrypt(
              session.encryptedAccessToken,
            ),
          );

          //-----------------------------------------
          // Qty
          //-----------------------------------------

          const qty = Math.round(
            event.quantity * follower.multiplier,
          );

          rec.setQuantity(qty);

          //-----------------------------------------
          // Symbol Resolution
          //-----------------------------------------

          const instrument = await this.resolver.resolveByBrokerSymbol(
            event.broker as Broker,
            event.symbol,
          );

          if (!instrument) {

            this.logger.error(
              `Instrument not found : ${event.symbol}`,
            );

            rec.fail(
              'INSTRUMENT_NOT_FOUND',
              `Instrument not found for ${event.broker} ${event.symbol}`,
            );

            continue;

          }

          const followerSymbol =
            await this.resolver.getBrokerSymbol(
              instrument.instrument.id,
              follower.tradingAccount.broker,
            );

          if (!followerSymbol) {

            this.logger.warn(
              `No mapping found for ${event.symbol} -> ${follower.tradingAccount.broker}`,
            );

            rec.fail(
              'SYMBOL_MAPPING_MISSING',
              `No InstrumentBroker mapping for ${event.symbol} -> ${follower.tradingAccount.broker}`,
            );

            continue;

          }

          rec.setBrokerSymbol(followerSymbol.brokerSymbol);

          //-----------------------------------------
          // FYERS Order
          //-----------------------------------------

          const order = {

            symbol: followerSymbol.brokerSymbol,

            qty,

            type: 2,

            side: event.side === 'BUY' ? 1 : -1,

            productType: 'INTRADAY',

            limitPrice: 0,

            stopPrice: 0,

            disclosedQty: 0,

            validity: 'DAY',

            offlineOrder: false,

          };

          this.logger.log(
            `Executing FYERS Order -> ${follower.followerUser.email}`,
          );

          this.logger.log(
            `MASTER SYMBOL  : ${event.symbol}`,
          );

          this.logger.log(
            `FOLLOWER SYMBOL: ${followerSymbol.brokerSymbol}`,
          );

          this.logger.log(
            `BROKER         : ${follower.tradingAccount.broker}`,
          );

          this.logger.log(
            JSON.stringify(order, null, 2),
          );

          rec.setStatus('EXECUTING');
          const result = await adapter.placeOrder(order);

          if (result.s === 'ok') {
            this.logger.log(`SUCCESS -> ${JSON.stringify(result)}`);
            rec.succeed(result);
          } else {
            this.logger.error(`BROKER ERROR -> ${JSON.stringify(result)}`);
            rec.fail(
              classifyFailure({
                message: (result as any)?.message,
                response: result,
              }),
              (result as any)?.message ??
                (typeof result === 'string'
                  ? result
                  : 'Broker returned non-ok response'),
              result,
            );
          }

        } catch (e: any) {

          this.logger.error(
            `${follower.followerUser.email} : ${e.message}`,
          );

          rec.fail(
            classifyFailure({ message: e?.message, response: e }),
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
