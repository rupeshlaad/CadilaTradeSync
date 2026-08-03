import { Injectable } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class AdminDbService {

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async summary() {

    const [
      users,
      tradingAccounts,
      strategies,
      followers,
      subscriptions,
      instruments,
      instrumentBrokers,
      brokerSessions,
    ] = await Promise.all([

      this.prisma.user.count(),

      this.prisma.tradingAccount.count(),

      this.prisma.strategy.count(),

      this.prisma.follower.count(),

      this.prisma.subscription.count(),

      this.prisma.instrument.count(),

      this.prisma.instrumentBroker.count(),

      this.prisma.brokerSession.count(),

    ]);

    return {

      users,

      tradingAccounts,

      strategies,

      followers,

      subscriptions,

      instruments,

      instrumentBrokers,

      brokerSessions,

    };

  }

  async brokerStats() {

    const stats = await this.prisma.instrumentBroker.groupBy({

      by: ['broker'],

      _count: {

        broker: true,

      },

    });

    return stats.map(s => ({

      broker: s.broker,

      instruments: s._count.broker,

    }));

  }

  async exchangeStats() {

    const stats = await this.prisma.instrument.groupBy({

      by: ['exchange'],

      _count: {

        exchange: true,

      },

    });

    return stats.map(s => ({

      exchange: s.exchange,

      instruments: s._count.exchange,

    }));

  }

  async search(symbol: string) {

    return this.prisma.instrument.findMany({

      where: {

        OR: [

          {
            underlying: {
              contains: symbol,
              mode: 'insensitive',
            },
          },

          {
            contractKey: {
              contains: symbol,
              mode: 'insensitive',
            },
          },

        ],

      },

      include: {

        brokers: true,

      },

      take: 100,

      orderBy: {

        underlying: 'asc',

      },

    });

  }

  async orphanInstruments() {

    return this.prisma.instrument.findMany({

      where: {

        brokers: {

          none: {},

        },

      },

      take: 500,

      orderBy: {

        exchange: 'asc',

      },

    });

  }

  async instrument(contractKey: string) {

    return this.prisma.instrument.findUnique({

      where: {
        contractKey,
      },

      include: {
        brokers: true,
      },

    });

  }

  async missingBrokerMappings(broker: Broker) {

    return this.prisma.instrument.findMany({

      where: {

        brokers: {

          none: {

            broker,

          },

        },

      },

      select: {

        contractKey: true,

        exchange: true,

        segment: true,

        underlying: true,

        instrumentType: true,

        expiry: true,

        strike: true,

        optionType: true,

      },

      take: 500,

      orderBy: {

        contractKey: 'asc',

      },

    });

  }

}