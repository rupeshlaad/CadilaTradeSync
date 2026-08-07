import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { Broker } from '@prisma/client';
import { InstrumentImportService } from '../instrument-import.service';
import { InstrumentStatsService } from '../instrument-stats.service';
import { ImportSummary, ParsedInstrument } from './broker-instrument.interface';
import { extractZipEntries } from './zip-reader';

/**
 * Sprint 6.2.4 — ICICI Direct (Breeze) instrument master importer.
 *
 * Breeze publishes a single public SecurityMaster.zip containing one
 * `<segment>ScripMaster.txt` CSV per exchange. This importer mirrors the
 * Zerodha/Fyers workflow exactly: download → parse → upsert via the shared
 * InstrumentImportService → record a summary in InstrumentStatsService. No
 * broker-specific storage path; the canonical Instrument + InstrumentBroker
 * tables are the single source of truth for every broker.
 */
@Injectable()
export class IciciImporter {
  private readonly logger = new Logger('IciciImporter');

  private readonly securityMasterUrl =
    'https://directlink.icicidirect.com/NewSecurityMaster/SecurityMaster.zip';

  // Breeze names each entry `<segment>ScripMaster.txt`. Map the file to the
  // CTS exchange/segment so downstream search/translate stay broker-agnostic.
  private readonly fileExchange: Array<{ match: RegExp; exchange: string; segment: string }> = [
    { match: /^FONSE/i, exchange: 'NFO', segment: 'NFO' },
    { match: /^FOBSE/i, exchange: 'BFO', segment: 'BFO' },
    { match: /^CDNSE/i, exchange: 'CDS', segment: 'CDS' },
    { match: /^NSE/i, exchange: 'NSE', segment: 'NSE' },
    { match: /^BSE/i, exchange: 'BSE', segment: 'BSE' },
    { match: /^MCX/i, exchange: 'MCX', segment: 'MCX' },
  ];

  constructor(
    private readonly importService: InstrumentImportService,
    private readonly stats: InstrumentStatsService,
  ) {}

  async import(): Promise<ImportSummary> {
    const startedAt = new Date();
    this.logger.log('Starting ICICI Direct (Breeze) Import...');

    const response = await axios.get<ArrayBuffer>(this.securityMasterUrl, {
      responseType: 'arraybuffer',
    });
    const entries = extractZipEntries(Buffer.from(response.data));
    this.logger.log(
      `Downloaded SecurityMaster.zip → ${entries.length} scrip files`,
    );

    let downloaded = 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const entry of entries) {
      const mapping = this.fileExchange.find((f) => f.match.test(entry.name));
      if (!mapping) {
        this.logger.log(`Skipping unmapped scrip file ${entry.name}`);
        continue;
      }

      let rows: any[] = [];
      try {
        rows = parse(entry.data.toString('utf-8'), {
          columns: true,
          skip_empty_lines: true,
          relax_column_count: true,
          trim: true,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to parse ${entry.name}: ${(err as Error).message}`,
        );
        continue;
      }

      downloaded += rows.length;
      this.logger.log(
        `Parsing ${entry.name} (${mapping.exchange}) : ${rows.length} rows`,
      );

      for (const row of rows) {
        const parsed = this.parseRow(row, mapping.exchange, mapping.segment);
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
            `Failed to save ICICI row ${parsed.brokerSymbol}: ${
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
      broker: Broker.ICICI_DIRECT,
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
    // Breeze headers are quoted and vary per segment; read defensively by
    // candidate names so a minor column reorder never breaks the import.
    const brokerSymbol = this.pick(row, ['ExchangeCode', 'ShortName', 'Symbol']);
    const brokerToken = this.pick(row, ['Token', 'ScripCode']);
    if (!brokerSymbol) return null;

    const optionTypeRaw = this.pick(row, ['OptionType', 'OptionTyp', 'Series']);
    const optionType =
      optionTypeRaw === 'CE' || optionTypeRaw === 'PE' ? optionTypeRaw : null;
    const isFno = exchange === 'NFO' || exchange === 'BFO' || exchange === 'CDS' || exchange === 'MCX';

    const expiry = this.parseDate(
      this.pick(row, ['ExpiryDate', 'Expiry', 'EXPIRY_DT']),
    );
    const strike = this.parseNumber(
      this.pick(row, ['StrikePrice', 'Strike', 'STRIKE']),
    );
    // Sprint 6.2.10 — for CASH equity the searchable underlying MUST be the
    // ticker (brokerSymbol, e.g. "TCS"), NOT the company name. Storing the
    // company name made the manual-trade ranker score cash equity only at the
    // brokerSymbol-prefix tier, so the NFO chain (underlying-exact) buried it
    // below the result cap. Derivatives keep their underlying resolution.
    const underlying = isFno
      ? this.pick(row, ['CompanyName', 'ShortName', 'Symbol']) ?? brokerSymbol
      : brokerSymbol;

    const instrumentType = isFno ? optionType ?? 'FUT' : 'EQ';
    const contractKey = isFno
      ? `${exchange}|${brokerSymbol}|${
          expiry ? expiry.toISOString().substring(0, 10) : ''
        }|${strike ?? ''}|${optionType ?? 'FUT'}`
      : `${exchange}|${brokerSymbol}`;

    return {
      contractKey,
      exchange,
      segment,
      underlying,
      instrumentType,
      expiry,
      strike,
      optionType,
      lotSize: this.parseNumber(this.pick(row, ['Lotsize', 'LotSize', 'LOT_SIZE'])) ?? 1,
      tickSize: this.parseNumber(this.pick(row, ['Ticksize', 'TickSize', 'TICK_SIZE'])) ?? 0.05,
      broker: Broker.ICICI_DIRECT,
      brokerSymbol: String(brokerSymbol),
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
