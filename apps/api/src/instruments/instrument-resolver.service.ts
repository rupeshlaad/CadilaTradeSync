import { Injectable } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class InstrumentResolverService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async resolveByBrokerSymbol(
    broker: Broker,
    brokerSymbol: string,
  ) {
    return this.prisma.instrumentBroker.findUnique({
      where: {
        broker_brokerSymbol: {
          broker,
          brokerSymbol,
        },
      },
      include: {
        instrument: true,
      },
    });
  }

  async resolveByContractKey(
    contractKey: string,
  ) {
    return this.prisma.instrument.findUnique({
      where: {
        contractKey,
      },
      include: {
        brokers: true,
      },
    });
  }

  async getBrokerSymbol(
    instrumentId: string,
    broker: Broker,
  ) {
    return this.prisma.instrumentBroker.findFirst({
      where: {
        instrumentId,
        broker,
      },
    });
  }
}