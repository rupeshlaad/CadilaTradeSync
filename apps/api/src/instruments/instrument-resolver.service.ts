import { Injectable, NotFoundException } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class InstrumentResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveByBrokerSymbol(broker: Broker, brokerSymbol: string) {
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

  async resolveByContractKey(contractKey: string) {
    return this.prisma.instrument.findUnique({
      where: {
        contractKey,
      },
      include: {
        brokers: true,
      },
    });
  }

  async getBrokerSymbol(instrumentId: string, broker: Broker) {
    return this.prisma.instrumentBroker.findFirst({
      where: {
        instrumentId,
        broker,
      },
    });
  }

  /**
   * Translate a broker-specific symbol from one broker to another via the
   * canonical Instrument row (contractKey is the join key). This is the
   * core building block for multi-broker copy trading: given a fill on
   * the master's broker, work out the exact symbol the child broker
   * needs to place an equivalent order.
   *
   * Throws NotFoundException when either side of the mapping is missing
   * (unknown source symbol, or the target broker has no mapping for
   * that instrument yet — e.g. importer hasn't run for that broker).
   */
  async translate(
    fromBroker: Broker,
    fromSymbol: string,
    toBroker: Broker,
  ) {
    const source = await this.resolveByBrokerSymbol(fromBroker, fromSymbol);
    if (!source) {
      throw new NotFoundException(
        `Instrument not found for ${fromBroker} symbol "${fromSymbol}"`,
      );
    }

    if (fromBroker === toBroker) {
      return {
        instrument: source.instrument,
        source: {
          broker: source.broker,
          brokerSymbol: source.brokerSymbol,
          brokerToken: source.brokerToken,
        },
        target: {
          broker: source.broker,
          brokerSymbol: source.brokerSymbol,
          brokerToken: source.brokerToken,
        },
      };
    }

    const target = await this.getBrokerSymbol(source.instrumentId, toBroker);
    if (!target) {
      throw new NotFoundException(
        `No ${toBroker} mapping for instrument "${source.instrument.contractKey}"`,
      );
    }

    return {
      instrument: source.instrument,
      source: {
        broker: source.broker,
        brokerSymbol: source.brokerSymbol,
        brokerToken: source.brokerToken,
      },
      target: {
        broker: target.broker,
        brokerSymbol: target.brokerSymbol,
        brokerToken: target.brokerToken,
      },
    };
  }
}
