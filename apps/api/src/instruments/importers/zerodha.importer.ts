import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { Broker } from '@prisma/client';
import { InstrumentImportService } from '../instrument-import.service';
import { InstrumentStatsService } from '../instrument-stats.service';
import { ImportSummary, ParsedInstrument } from './broker-instrument.interface';
import { PrismaService } from '../../prisma/prisma.module';

@Injectable()
export class ZerodhaImporter {
  private readonly logger = new Logger('ZerodhaImporter');

  constructor(
    private readonly prisma: PrismaService,
    private readonly importService: InstrumentImportService,
    private readonly stats: InstrumentStatsService,
  ) {}

  async import(): Promise<ImportSummary> {
    const startedAt = new Date();
    this.logger.log('Starting Zerodha Import...');

    const response = await axios.get('https://api.kite.trade/instruments', {
      responseType: 'text',
    });

    const rows: any[] = parse(response.data, {
      columns: true,
      skip_empty_lines: true,
    });

    const downloaded = rows.length;
    this.logger.log(`Downloaded : ${downloaded}`);

    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      const contractKey = this.buildContractKey(row);

      if (!contractKey) {
        skipped++;
        continue;
      }

      const parsed: ParsedInstrument = {
        contractKey,
        exchange: row.exchange,
        segment: row.segment,
        underlying:
          row.name && row.name.trim() !== '' ? row.name : row.tradingsymbol,
        instrumentType: row.instrument_type,
        expiry:
          row.expiry && row.expiry !== '' ? new Date(row.expiry) : null,
        strike:
          row.strike && row.strike !== '' ? Number(row.strike) : null,
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

      try {
        const outcome = await this.importService.save(parsed);
        if (outcome === 'inserted') inserted++;
        else updated++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `Failed to save Zerodha row ${parsed.brokerSymbol}: ${
            (err as Error).message
          }`,
        );
      }

      processed++;
      if (processed % 5000 === 0) {
        this.logger.log(`Processed : ${processed}`);
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
      broker: Broker.ZERODHA,
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

  private buildContractKey(row: any): string | null {
    // ---------- Cash Equity ----------

    if (row.exchange === 'NSE' && row.instrument_type === 'EQ') {
      return `NSE|${row.tradingsymbol}`;
    }

    if (row.exchange === 'BSE' && row.instrument_type === 'EQ') {
      return `BSE|${row.tradingsymbol}`;
    }

    // ---------- Futures / Options ----------

    if (row.exchange === 'NFO' || row.exchange === 'BFO') {
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
