import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { Broker } from '@prisma/client';
import { InstrumentImportService } from '../instrument-import.service';
import { InstrumentStatsService } from '../instrument-stats.service';
import { ImportSummary, ParsedInstrument } from './broker-instrument.interface';

@Injectable()
export class FyersImporter {
  private readonly logger = new Logger('FyersImporter');

  private readonly files = [
    'https://public.fyers.in/sym_details/NSE_CM.csv',
    'https://public.fyers.in/sym_details/NSE_FO.csv',
  ];

  constructor(
    private readonly importService: InstrumentImportService,
    private readonly stats: InstrumentStatsService,
  ) {}

  async import(): Promise<ImportSummary> {
    const startedAt = new Date();
    this.logger.log('Starting Fyers Import...');

    let downloaded = 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of this.files) {
      this.logger.log(`Downloading ${file}`);

      const response = await axios.get(file, { responseType: 'text' });

      const rows: any[] = parse(response.data, {
        skip_empty_lines: true,
      });

      this.logger.log(`Downloaded : ${rows.length} rows from ${file}`);
      downloaded += rows.length;

      for (const row of rows) {
        const parsed = this.parseRow(row);

        if (!parsed) {
          skipped++;
          continue;
        }

        try {
          const outcome = await this.importService.save(parsed);
          if (outcome === 'inserted') inserted++;
          else updated++;
        } catch (err) {
          failed++;
          this.logger.warn(
            `Failed to save Fyers row ${parsed.brokerSymbol}: ${
              (err as Error).message
            }`,
          );
        }

        processed++;
        if (processed % 5000 === 0) {
          this.logger.log(`Processed : ${processed}`);
        }
      }
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    this.logger.log('Completed');
    this.logger.log(`Inserted : ${inserted}`);
    this.logger.log(`Updated  : ${updated}`);
    this.logger.log(`Skipped  : ${skipped}`);
    this.logger.log(`Failed   : ${failed}`);
    this.logger.log(`Duration : ${Math.round(durationMs / 1000)} sec`);

    const summary: ImportSummary = {
      broker: Broker.FYERS,
      downloaded,
      inserted,
      updated,
      skipped,
      failed,
      durationMs,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };

    this.stats.record(summary);
    return summary;
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

    const expiry = row[8] ? new Date(Number(row[8]) * 1000) : null;

    const symbol = row[13];

    const strike = Number(row[15]);

    let optionType: string | null = null;

    if (brokerSymbol.endsWith('CE')) {
      optionType = 'CE';
    } else if (brokerSymbol.endsWith('PE')) {
      optionType = 'PE';
    }

    const contractKey = `${
      brokerSymbol.startsWith('NSE:') ? 'NFO' : 'BFO'
    }|${symbol}|${expiry?.toISOString().substring(0, 10)}|${strike}|${
      optionType ?? 'FUT'
    }`;

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
