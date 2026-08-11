import { Injectable, Logger } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

/**
 * Sprint 6.2.5 — Instrument integrity validation.
 *
 * Verifies the canonical Instrument ↔ InstrumentBroker invariants and repairs
 * the repairable ones. This is broker-agnostic: the same checks cover Zerodha,
 * Fyers, ICICI Direct and Shoonya identically.
 *
 * Invariants:
 *   • canonical            = number of Instrument rows
 *   • brokerMappings       = number of InstrumentBroker rows
 *   • union-of-brokers     = every InstrumentBroker points at a real Instrument
 *   • no orphan Instrument  = every Instrument has ≥1 broker mapping
 *   • no duplicate mapping  = (broker, brokerSymbol, exchange) is unique
 *                             (Sprint 6.2.8 — the same brokerSymbol legitimately
 *                              lists on multiple exchanges, e.g. TCS on NSE and
 *                              BSE, so exchange is part of the identity)
 */

export interface IntegrityCount {
  canonical: number;
  brokerMappings: number;
  perBroker: Record<string, number>;
  perBrokerSum: number;
}

export interface IntegrityIssues {
  duplicateMappings: number;
  missingCanonicalMappings: number; // mapping rows whose Instrument is gone
  orphanInstruments: number; // Instrument rows with zero broker mappings
}

export interface IntegrityReport {
  counts: IntegrityCount;
  issues: IntegrityIssues;
  invariants: {
    canonicalEqualsUnion: boolean;
    brokerMappingsEqualsSum: boolean;
  };
  healthy: boolean;
  checkedAt: string;
}

export interface IntegrityFixResult {
  before: IntegrityReport;
  fixed: {
    duplicateMappingsRemoved: number;
    orphanMappingsRemoved: number;
    orphanInstrumentsRemoved: number;
  };
  after: IntegrityReport;
}

@Injectable()
export class InstrumentIntegrityService {
  private readonly logger = new Logger('InstrumentIntegrityService');

  constructor(private readonly prisma: PrismaService) {}

  async report(): Promise<IntegrityReport> {
    const [canonical, brokerMappings] = await Promise.all([
      this.prisma.instrument.count(),
      this.prisma.instrumentBroker.count(),
    ]);

    const perBroker: Record<string, number> = {};
    let perBrokerSum = 0;
    for (const b of Object.values(Broker)) {
      const c = await this.prisma.instrumentBroker.count({ where: { broker: b } });
      perBroker[b] = c;
      perBrokerSum += c;
    }

    const [duplicateMappings, missingCanonicalMappings, orphanInstruments] =
      await Promise.all([
        this.countDuplicateMappings(),
        this.countMappingsWithMissingInstrument(),
        this.prisma.instrument.count({ where: { brokers: { none: {} } } }),
      ]);

    const invariants = {
      canonicalEqualsUnion: orphanInstruments === 0,
      brokerMappingsEqualsSum: brokerMappings === perBrokerSum,
    };

    return {
      counts: { canonical, brokerMappings, perBroker, perBrokerSum },
      issues: { duplicateMappings, missingCanonicalMappings, orphanInstruments },
      invariants,
      healthy:
        duplicateMappings === 0 &&
        missingCanonicalMappings === 0 &&
        orphanInstruments === 0 &&
        invariants.canonicalEqualsUnion &&
        invariants.brokerMappingsEqualsSum,
      checkedAt: new Date().toISOString(),
    };
  }

  async fix(): Promise<IntegrityFixResult> {
    const before = await this.report();

    const duplicateMappingsRemoved = await this.removeDuplicateMappings();
    const orphanMappingsRemoved = await this.removeMappingsWithMissingInstrument();
    const orphanInstrumentsRemoved = await this.removeOrphanInstruments();

    if (
      duplicateMappingsRemoved ||
      orphanMappingsRemoved ||
      orphanInstrumentsRemoved
    ) {
      this.logger.log(
        `Integrity fix: removed ${duplicateMappingsRemoved} duplicate mapping(s), ` +
          `${orphanMappingsRemoved} orphan mapping(s), ` +
          `${orphanInstrumentsRemoved} orphan instrument(s)`,
      );
    }

    const after = await this.report();
    return {
      before,
      fixed: {
        duplicateMappingsRemoved,
        orphanMappingsRemoved,
        orphanInstrumentsRemoved,
      },
      after,
    };
  }

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  private async countDuplicateMappings(): Promise<number> {
    // Sprint 6.2.8 — uniqueness is (broker, brokerSymbol, exchange). A shared
    // brokerSymbol across exchanges (e.g. TCS on NSE and BSE) is NOT a
    // duplicate; only rows identical on all three columns are.
    const rows = await this.prisma.$queryRawUnsafe<Array<{ extra: bigint }>>(
      `SELECT COALESCE(SUM(c - 1), 0)::bigint AS extra
         FROM (
           SELECT COUNT(*) AS c
             FROM "instrument_brokers"
            GROUP BY broker, "brokerSymbol", exchange
           HAVING COUNT(*) > 1
         ) d`,
    );
    return Number(rows?.[0]?.extra ?? 0);
  }

  private async countMappingsWithMissingInstrument(): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n
         FROM "instrument_brokers" b
         LEFT JOIN "instruments" i ON i.id = b."instrumentId"
        WHERE i.id IS NULL`,
    );
    return Number(rows?.[0]?.n ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Repair
  // ---------------------------------------------------------------------------

  private async removeDuplicateMappings(): Promise<number> {
    // Sprint 6.2.8 — a duplicate is a row identical on
    // (broker, brokerSymbol, exchange). Keep the earliest such row and delete
    // the rest. Rows that share (broker, brokerSymbol) but differ on exchange
    // (e.g. ZERODHA/TCS/NSE vs ZERODHA/TCS/BSE) are LEGITIMATE distinct
    // listings and MUST NOT be deleted.
    const res = await this.prisma.$executeRawUnsafe(
      `DELETE FROM "instrument_brokers" a
        USING "instrument_brokers" b
       WHERE a.broker = b.broker
         AND a."brokerSymbol" = b."brokerSymbol"
         AND a.exchange = b.exchange
         AND (
           a."createdAt" > b."createdAt"
           OR (a."createdAt" = b."createdAt" AND a.id > b.id)
         )`,
    );
    return Number(res ?? 0);
  }

  private async removeMappingsWithMissingInstrument(): Promise<number> {
    const res = await this.prisma.$executeRawUnsafe(
      `DELETE FROM "instrument_brokers" b
        WHERE NOT EXISTS (
          SELECT 1 FROM "instruments" i WHERE i.id = b."instrumentId"
        )`,
    );
    return Number(res ?? 0);
  }

  private async removeOrphanInstruments(): Promise<number> {
    const res = await this.prisma.$executeRawUnsafe(
      `DELETE FROM "instruments" i
        WHERE NOT EXISTS (
          SELECT 1 FROM "instrument_brokers" b WHERE b."instrumentId" = i.id
        )`,
    );
    return Number(res ?? 0);
  }
}
