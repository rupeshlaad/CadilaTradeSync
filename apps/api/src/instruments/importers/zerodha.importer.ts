import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { Broker } from '@prisma/client';
import { InstrumentImportService } from '../instrument-import.service';
import { ParsedInstrument } from './broker-instrument.interface';
import { PrismaService } from '../../prisma/prisma.module';

@Injectable()
export class ZerodhaImporter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importService: InstrumentImportService,
  ) {}

  async import() {
    console.log('Downloading Zerodha Instruments...');

    const response = await axios.get(
      'https://api.kite.trade/instruments',
      {
        responseType: 'text',
      },
    );

    const rows: any[] = parse(response.data, {
      columns: true,
      skip_empty_lines: true,
    });

    console.log(`Downloaded ${rows.length} instruments`);

    let imported = 0;

    for (const row of rows) {

      const contractKey = this.buildContractKey(row);

      if (!contractKey) {
        continue;
      }

      const parsed: ParsedInstrument = {

        contractKey,

        exchange: row.exchange,

        segment: row.segment,

        underlying:
          row.name && row.name.trim() !== ''
            ? row.name
            : row.tradingsymbol,

        instrumentType: row.instrument_type,

        expiry:
          row.expiry && row.expiry !== ''
            ? new Date(row.expiry)
            : null,

        strike:
          row.strike && row.strike !== ''
            ? Number(row.strike)
            : null,

        optionType:
          row.instrument_type === 'CE'
            ? 'CE'
            : row.instrument_type === 'PE'
            ? 'PE'
            : null,

        lotSize: Number(row.lot_size || 1),

        tickSize: Number(row.tick_size || 0.05),

        broker: Broker.ZERODHA,

        brokerSymbol: row.tradingsymbol,

        brokerToken: row.instrument_token ?? null,

      };

      await this.importService.save(parsed);

      imported++;

      if (imported % 5000 === 0) {
        console.log(`${imported} imported...`);
      }

    }

    console.log(`Completed : ${imported}`);

  }

  private buildContractKey(row: any): string | null {

    // ---------- Cash Equity ----------

    if (
      row.exchange === 'NSE' &&
      row.instrument_type === 'EQ'
    ) {
      return `NSE|${row.tradingsymbol}`;
    }

    if (
      row.exchange === 'BSE' &&
      row.instrument_type === 'EQ'
    ) {
      return `BSE|${row.tradingsymbol}`;
    }

    // ---------- Futures / Options ----------

    if (
      row.exchange === 'NFO' ||
      row.exchange === 'BFO'
    ) {

      const optionType =
        row.instrument_type === 'CE'
          ? 'CE'
          : row.instrument_type === 'PE'
          ? 'PE'
          : 'FUT';

      return `${row.exchange}|${row.name}|${row.expiry}|${row.strike}|${optionType}`;
    }

    return null;
  }

}