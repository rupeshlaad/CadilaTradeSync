import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { gunzipSync } from 'node:zlib';
import { Broker } from '@prisma/client';
import { InstrumentImportService } from '../instrument-import.service';
import { InstrumentStatsService } from '../instrument-stats.service';
import { ImportSummary, ParsedInstrument } from './broker-instrument.interface';

/**
 * Sprint 6.3 — Upstox instrument-master importer.
 *
 * Upstox publishes the full daily instrument master as gzipped JSON per
 * exchange (https://assets.upstox.com/market-quote/instruments/exchange/*.json.gz).
 * We import the NSE bundle (equity cash NSE_EQ + equity F&O NSE_FO) to match
 * the coverage of the Fyers importer (NSE_CM + NSE_FO). The gz is decompressed
 * with Node's built-in `zlib` (no new dependency / no lockfile change).
 *
 * The Upstox `instrument_key` (e.g. "NSE_EQ|INE002A01018") is persisted as the
 * broker token — it is the exact `instrument_token` the Upstox `/order/place`
 * API requires, so the copy engine / manual trade can place orders without a
 * second lookup. The canonical `contractKey` matches the Zerodha/Fyers
 * convention (`NSE|<symbol>` for equity) so cross-broker mapping links up.
 */
@Injectable()
export class UpstoxImporter {
  private readonly logger = new Logger('UpstoxImporter');

  private readonly files = [
    'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  ];

  constructor(
    private readonly importService: InstrumentImportService,
    private readonly stats: InstrumentStatsService,
  ) {}

  async import(): Promise<ImportSummary> {
    const startedAt = new Date();
    this.logger.log('Starting Upstox Import...');

    let downloaded = 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of this.files) {
      this.logger.log(`Downloading ${file}`);

      const response = await axios.get(file, { responseType: 'arraybuffer' });
      const json = gunzipSync(Buffer.from(response.data)).toString('utf-8');
      const rows: any[] = JSON.parse(json);

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
            `Failed to save Upstox row ${parsed.brokerSymbol}: ${
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
      broker: Broker.UPSTOX,
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

  private parseRow(row: any): ParsedInstrument | null {
    const segment = String(row?.segment ?? '').toUpperCase();
    const instrumentKey = row?.instrument_key;
    const tradingSymbol = row?.trading_symbol;

    if (!instrumentKey || !tradingSymbol) return null;

    const lotSize = Number(row?.lot_size ?? 1) || 1;
    const tickSize = Number(row?.tick_size ?? 0.05) || 0.05;

    // -----------------------------
    // NSE Cash Equity
    // -----------------------------
    if (segment === 'NSE_EQ') {
      // Trade only cash equity here (skip index/ETF-only rows are still valid
      // equity; keep them). Underlying = trading symbol to match Zerodha/Fyers.
      return {
        contractKey: `NSE|${tradingSymbol}`,
        exchange: 'NSE',
        segment: 'NSE',
        underlying: tradingSymbol,
        instrumentType: 'EQ',
        expiry: null,
        strike: null,
        optionType: null,
        lotSize,
        tickSize,
        broker: Broker.UPSTOX,
        brokerSymbol: tradingSymbol,
        brokerToken: instrumentKey,
      };
    }

    // -----------------------------
    // NSE Futures / Options
    // -----------------------------
    if (segment === 'NSE_FO') {
      const type = String(row?.instrument_type ?? '').toUpperCase();
      const optionType = type === 'CE' ? 'CE' : type === 'PE' ? 'PE' : null;
      const instrumentType = optionType ?? 'FUT';

      const expiry =
        row?.expiry != null && row.expiry !== ''
          ? new Date(Number(row.expiry))
          : null;
      const strike =
        row?.strike_price != null && row.strike_price !== ''
          ? Number(row.strike_price)
          : null;
      const underlying =
        row?.underlying_symbol ?? row?.asset_symbol ?? row?.name ?? tradingSymbol;

      const expiryKey = expiry ? expiry.toISOString().substring(0, 10) : '';
      const contractKey = `NFO|${underlying}|${expiryKey}|${strike ?? 0}|${instrumentType}`;

      return {
        contractKey,
        exchange: 'NFO',
        segment: 'NFO',
        underlying,
        instrumentType,
        expiry,
        strike,
        optionType,
        lotSize,
        tickSize,
        broker: Broker.UPSTOX,
        brokerSymbol: tradingSymbol,
        brokerToken: instrumentKey,
      };
    }

    // Index / other segments are not tradable instruments — skip.
    return null;
  }
}
