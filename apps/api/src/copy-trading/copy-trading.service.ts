import { Injectable, Logger } from '@nestjs/common';
import { Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { InstrumentResolverService } from '../instruments/instrument-resolver.service';

import { TradeEvent } from './dto/trade-event.dto';
import { FyersAdapter } from '../brokers/fyers/fyers.adapter';

@Injectable()
export class CopyTradingService {
  private readonly logger = new Logger(CopyTradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly resolver: InstrumentResolverService,
  ) {}

  async handleTrade(event: TradeEvent) {

    this.logger.log(
      `MASTER TRADE : ${event.side} ${event.symbol} Qty:${event.quantity}`,
    );

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
      return;
    }

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

    if (followers.length === 0) {
      this.logger.warn('No followers subscribed.');
      return;
    }

    this.logger.log(
      `Followers Found : ${followers.length}`,
    );

    //-----------------------------------------
    // Execute
    //-----------------------------------------

    for (const follower of followers) {

      try {

        //-----------------------------------------
        // Only FYERS for MVP
        //-----------------------------------------

        if (follower.tradingAccount.broker !== Broker.FYERS) {

          this.logger.warn(
            `Skipping ${follower.followerUser.email} (${follower.tradingAccount.broker})`,
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

          continue;

        }

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

        const result = await adapter.placeOrder(order);

        if (result.s === 'ok') {
          this.logger.log(`SUCCESS -> ${JSON.stringify(result)}`);
        } else {
          this.logger.error(`BROKER ERROR -> ${JSON.stringify(result)}`);
        }

      } catch (e: any) {

        this.logger.error(
          `${follower.followerUser.email} : ${e.message}`,
        );

      }

    }

  }

}