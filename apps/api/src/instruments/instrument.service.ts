import { Injectable } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class InstrumentService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async findByBrokerSymbol(
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

  async findTargetBrokerSymbol(
    targetBroker: Broker,
    contractKey: string,
  ) {
    return this.prisma.instrumentBroker.findFirst({
      where: {
        broker: targetBroker,
        instrument: {
          contractKey,
        },
      },
      include: {
        instrument: true,
      },
    });
  }
}