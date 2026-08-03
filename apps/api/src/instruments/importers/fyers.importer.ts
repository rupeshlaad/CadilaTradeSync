import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { Broker } from '@prisma/client';
import { InstrumentImportService } from '../instrument-import.service';
import { ParsedInstrument } from './broker-instrument.interface';

@Injectable()
export class FyersImporter {

  private readonly files = [
    'https://public.fyers.in/sym_details/NSE_CM.csv',
    'https://public.fyers.in/sym_details/NSE_FO.csv',
  ];

  constructor(
    private readonly importService: InstrumentImportService,
  ) {}

  async import() {

    let total = 0;

    for (const file of this.files) {

      console.log(`Downloading ${file}`);

      const response = await axios.get(file, {
        responseType: 'text',
      });

      const rows: any[] = parse(response.data, {
        skip_empty_lines: true,
      });

      console.log(`${rows.length} rows`);

      for (const row of rows) {

        const parsed = this.parseRow(row);

        if (!parsed) {
          continue;
        }

        await this.importService.save(parsed);

      }

      total += rows.length;

    }

    console.log(`FYERS TOTAL : ${total}`);

  }

  private parseRow(row: any[]): ParsedInstrument | null {

    const brokerSymbol = row[9];

    if (!brokerSymbol) {
      return null;
    }

    // -----------------------------
    // NSE Cash
    // -----------------------------

    if (brokerSymbol.endsWith('-EQ')) {

      const symbol = row[13];

      return {

        contractKey: `NSE|${symbol}`,

        exchange: 'NSE',

        segment: 'NSE',

        underlying: symbol,

        instrumentType: 'EQ',

        expiry: null,

        strike: null,

        optionType: null,

        lotSize: 1,

        tickSize: Number(row[4]),

        broker: Broker.FYERS,

        brokerSymbol,

        brokerToken: row[12],

      };

    }

    // -----------------------------
    // Futures / Options
    // -----------------------------

    const expiry =
      row[8]
        ? new Date(Number(row[8]) * 1000)
        : null;

    const symbol = row[13];

    const strike =
      Number(row[15]);

    let optionType: string | null = null;

    if (brokerSymbol.endsWith("CE")) {
      optionType = "CE";
    } else if (brokerSymbol.endsWith("PE")) {
      optionType = "PE";
    }

    const contractKey =
      `${brokerSymbol.startsWith("NSE:") ? "NFO" : "BFO"}|${symbol}|${expiry?.toISOString().substring(0,10)}|${strike}|${optionType ?? "FUT"}`;

    return {

      contractKey,

      exchange: 'NFO',

      segment: 'NFO',

      underlying: symbol,

      instrumentType: optionType ?? 'FUT',

      expiry,

      strike,

      optionType,

      lotSize: Number(row[14]),

      tickSize: Number(row[4]),

      broker: Broker.FYERS,

      brokerSymbol,

      brokerToken: row[12],

    };

  }

}