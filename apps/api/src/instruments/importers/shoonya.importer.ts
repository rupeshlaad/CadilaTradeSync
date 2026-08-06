import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { Broker } from '@prisma/client';
import { InstrumentImportService } from '../instrument-import.service';
import { InstrumentStatsService } from '../instrument-stats.service';
import { ImportSummary, ParsedInstrument } from './broker-instrument.interface';
import { extractZipEntries } from './zip-reader';

/**
 * Sprint 6.2.4 — Shoonya (Finvasia Noren) instrument master importer.
 *
 * Shoonya publishes one public `<EXCH>_symbols.txt.zip` per exchange. Each
 * archive holds a single CSV with a header row. This importer mirrors the
 * Zerodha/Fyers/ICICI workflow exactly: download → parse → upsert via the
 * shared InstrumentImportService → record a summary. No broker-specific
 * storage; the canonical Instrument + InstrumentBroker tables serve every
 * broker identically.
 */
@Injectable()
export class ShoonyaImporter {
  private readonly logger = new Logger('ShoonyaImporter');

  private readonly base = 'https://api.shoonya.com';

  // Exchanges Shoonya exposes a symbol master for. NSE/BSE (cash),
  // NFO/BFO (equity F&O), CDS (currency), MCX (commodity).
  private readonly exchanges: Array<{ exch: string; exchange: string; segment: string }> = [
    { exch: 'NSE', exchange: 'NSE', segment: 'NSE' },
    { exch: 'BSE', exchange: 'BSE', segment: 'BSE' },
    { exch: 'NFO', exchange: 'NFO', segment: 'NFO' },
    { exch: 'BFO', exchange: 'BFO', segment: 'BFO' },
    { exch: 'CDS', exchange: 'CDS', segment: 'CDS' },
    { exch: 'MCX', exchange: 'MCX', segment: 'MCX' },
  ];

  constructor(
    private readonly importService: InstrumentImportService,
    private readonly stats: InstrumentStatsService,
  ) {}

  async import(): Promise<ImportSummary> {
    const startedAt = new Date();
    this.logger.log('Starting Shoonya (Noren) Import...');

    let downloaded = 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const ex of this.exchanges) {
      const url = `${this.base}/${ex.exch}_symbols.txt.zip`;
      let rows: any[] = [];
      try {
        this.logger.log(`Downloading ${url}`);
        const response = await axios.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
        });
        const entries = extractZipEntries(Buffer.from(response.data));
        const csv = entries.find((e) => /\.txt$|\.csv$/i.test(e.name)) ?? entries[0];
        if (!csv) {
          this.logger.warn(`No CSV entry in ${url}`);
          continue;
        }
        rows = parse(csv.data.toString('utf-8'), {
          columns: true,
          skip_empty_lines: true,
          relax_column_count: true,
          trim: true,
        });
      } catch (err) {
        // A single exchange being unavailable must not abort the whole import.
        this.logger.warn(
          `Failed to download/parse ${ex.exch} symbols: ${(err as Error).message}`,
        );
        continue;
      }

      downloaded += rows.length;
      this.logger.log(`Parsing ${ex.exch} : ${rows.length} rows`);

      for (const row of rows) {
        const parsed = this.parseRow(row, ex.exchange, ex.segment);
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
            `Failed to save Shoonya row ${parsed.brokerSymbol}: ${
              (err as Error).message
            }`,
          );
        }
        processed++;
        if (processed % 5000 === 0) this.logger.log(`Processed : ${processed}`);
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
      broker: Broker.SHOONYA,
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

  private parseRow(
    row: Record<string, any>,
    exchange: string,
    segment: string,
  ): ParsedInstrument | null {
    // Noren symbol files carry: Exchange, Token, LotSize, Symbol,
    // TradingSymbol, [Expiry, Instrument, OptionType, StrikePrice], TickSize.
    const tradingSymbol = this.pick(row, ['TradingSymbol', 'Tsym', 'Symbol']);
    const symbol = this.pick(row, ['Symbol', 'TradingSymbol']);
    const brokerToken = this.pick(row, ['Token', 'token']);
    if (!tradingSymbol || !symbol) return null;

    const optionTypeRaw = this.pick(row, ['OptionType', 'Optiontype', 'OptType']);
    const optionType =
      optionTypeRaw === 'CE' || optionTypeRaw === 'PE' ? optionTypeRaw : null;
    const isFno = exchange === 'NFO' || exchange === 'BFO' || exchange === 'CDS' || exchange === 'MCX';

    const expiry = this.parseDate(this.pick(row, ['Expiry', 'ExpiryDate']));
    const strike = this.parseNumber(this.pick(row, ['StrikePrice', 'Strike']));

    const instrumentType = isFno
      ? optionType ?? 'FUT'
      : this.pick(row, ['Instrument']) === 'INDEX'
      ? 'IDX'
      : 'EQ';

    const contractKey = isFno
      ? `${exchange}|${symbol}|${
          expiry ? expiry.toISOString().substring(0, 10) : ''
        }|${strike ?? ''}|${optionType ?? 'FUT'}`
      : `${exchange}|${symbol}`;

    return {
      contractKey,
      exchange,
      segment,
      underlying: symbol,
      instrumentType,
      expiry,
      strike,
      optionType,
      lotSize: this.parseNumber(this.pick(row, ['LotSize', 'Lotsize'])) ?? 1,
      tickSize: this.parseNumber(this.pick(row, ['TickSize', 'Ticksize'])) ?? 0.05,
      broker: Broker.SHOONYA,
      brokerSymbol: String(tradingSymbol),
      brokerToken: brokerToken != null ? String(brokerToken) : null,
    };
  }

  private pick(row: Record<string, any>, keys: string[]): string | null {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
    return null;
  }

  private parseNumber(v: string | null): number | null {
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private parseDate(v: string | null): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
