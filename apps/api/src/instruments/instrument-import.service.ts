import { Injectable } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { ParsedInstrument } from './importers/broker-instrument.interface';

@Injectable()
export class InstrumentImportService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async save(instrument: ParsedInstrument) {

    const dbInstrument = await this.prisma.instrument.upsert({

      where: {
        contractKey: instrument.contractKey,
      },

      update: {

        exchange: instrument.exchange,

        segment: instrument.segment,

        underlying: instrument.underlying,

        instrumentType: instrument.instrumentType,

        expiry: instrument.expiry,

        strike: instrument.strike,

        optionType: instrument.optionType,

        lotSize: instrument.lotSize,

        tickSize: instrument.tickSize,

      },

      create: {

        contractKey: instrument.contractKey,

        exchange: instrument.exchange,

        segment: instrument.segment,

        underlying: instrument.underlying,

        instrumentType: instrument.instrumentType,

        expiry: instrument.expiry,

        strike: instrument.strike,

        optionType: instrument.optionType,

        lotSize: instrument.lotSize,

        tickSize: instrument.tickSize,

      },

    });

    await this.prisma.instrumentBroker.upsert({

      where: {

        broker_brokerSymbol: {

          broker: instrument.broker,

          brokerSymbol: instrument.brokerSymbol,

        },

      },

      update: {

        brokerToken: instrument.brokerToken,

      },

      create: {

        instrumentId: dbInstrument.id,

        broker: instrument.broker,

        brokerSymbol: instrument.brokerSymbol,

        brokerToken: instrument.brokerToken,

      },

    });

  }
}