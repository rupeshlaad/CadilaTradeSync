import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { gunzipSync } from 'node:zlib';
import { Broker } from '@prisma/client';
import { InstrumentImportService } from '../instrument-import.service';
import { InstrumentStatsService } from '../instrument-stats.service';
import { ImportSummary, ParsedInstrument } from './broker-instrument.interface';

/**
 * Sprint 6.3.1 — Upstox instrument-master importer (full segment coverage).
 *
 * Upstox publishes the daily instrument master as gzipped JSON per exchange
 * (https://assets.upstox.com/market-quote/instruments/exchange/<EX>.json.gz).
 * We import every officially-supported segment the CTS Instrument /
 * InstrumentBroker model already represents (same exchange codes the Zerodha /
 * Shoonya importers use — NSE, NFO, CDS, BSE, BFO, MCX):
 *
 *   NSE.json.gz →  NSE_EQ → NSE (cash)     · NSE_FO → NFO (equity F&O)
 *                  NSE_CD → CDS (currency)
 *   BSE.json.gz →  BSE_EQ → BSE (cash)     · BSE_FO → BFO (equity F&O)
 *   MCX.json.gz →  MCX_FO → MCX (commodity F&O)
 *
 * The gz is decompressed with Node's built-in `zlib` (no new dependency). The
 * Upstox `instrument_key` (e.g. "NSE_EQ|INE002A01018") is persisted as the
 * broker token — it is the exact `instrument_token` the Upstox V3
 * `/order/place` API needs, so the copy engine / manual trade place orders
 * without a second lookup. The canonical `contractKey` matches the
 * Zerodha/Fyers convention so cross-broker mapping links up.
 */

interface SegmentMap {
  exchange: string;
  segment: string;
  kind: 'EQ' | 'FO';
}

// Upstox `segment` value → CTS exchange/segment + instrument kind.
const SEGMENT_MAP: Record<string, SegmentMap> = {
  NSE_EQ: { exchange: 'NSE', segment: 'NSE', kind: 'EQ' },
  NSE_FO: { exchange: 'NFO', segment: 'NFO', kind: 'FO' },
  NSE_CD: { exchange: 'CDS', segment: 'CDS', kind: 'FO' },
  BSE_EQ: { exchange: 'BSE', segment: 'BSE', kind: 'EQ' },
  BSE_FO: { exchange: 'BFO', segment: 'BFO', kind: 'FO' },
  MCX_FO: { exchange: 'MCX', segment: 'MCX', kind: 'FO' },
};

@Injectable()
export class UpstoxImporter {
  private readonly logger = new Logger('UpstoxImporter');

  private readonly files = [
    'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
    'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
    'https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz',
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

      let rows: any[];
      try {
        const response = await axios.get(file, { responseType: 'arraybuffer' });
        const json = gunzipSync(Buffer.from(response.data)).toString('utf-8');
        rows = JSON.parse(json);
      } catch (err) {
        // A single exchange file being unavailable must not abort the others.
        this.logger.warn(
          `Failed to download/parse ${file}: ${(err as Error).message}`,
        );
        continue;
      }

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
    const map = SEGMENT_MAP[segment];
    if (!map) return null; // Index / unsupported segments are skipped.

    const instrumentKey = row?.instrument_key;
    const tradingSymbol = row?.trading_symbol;
    if (!instrumentKey || !tradingSymbol) return null;

    const lotSize = Number(row?.lot_size ?? 1) || 1;
    const tickSize = Number(row?.tick_size ?? 0.05) || 0.05;

    // -----------------------------
    // Cash Equity (NSE / BSE)
    // -----------------------------
    if (map.kind === 'EQ') {
      return {
        contractKey: `${map.exchange}|${tradingSymbol}`,
        exchange: map.exchange,
        segment: map.segment,
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
    // Derivatives (NFO / BFO / CDS / MCX): FUT / CE / PE
    // -----------------------------
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
    const contractKey = `${map.exchange}|${underlying}|${expiryKey}|${
      strike ?? 0
    }|${instrumentType}`;

    return {
      contractKey,
      exchange: map.exchange,
      segment: map.segment,
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
}
