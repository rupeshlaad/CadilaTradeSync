import { Injectable } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { ParsedInstrument } from './importers/broker-instrument.interface';

export type ImportSaveOutcome = 'inserted' | 'updated';

@Injectable()
export class InstrumentImportService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async save(instrument: ParsedInstrument): Promise<ImportSaveOutcome> {

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

    // Detect insert vs update on the broker mapping side so the importer
    // can report an accurate summary. The Instrument row is upserted
    // above regardless (contractKey is shared across brokers), so mapping
    // presence is the correct signal for "did we add a new row?".
    const existingMapping = await this.prisma.instrumentBroker.findUnique({
      where: {
        broker_brokerSymbol: {
          broker: instrument.broker,
          brokerSymbol: instrument.brokerSymbol,
        },
      },
      select: { id: true },
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

    return existingMapping ? 'updated' : 'inserted';

  }
}