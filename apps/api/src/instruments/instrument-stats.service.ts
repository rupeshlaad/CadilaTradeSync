import { Injectable } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { ImportSummary } from './importers/broker-instrument.interface';

/**
 * Tracks the most-recent import outcome per broker in-process. This is
 * intentionally in-memory (no schema change): the numbers reported by
 * /admin/instruments/stats always reflect the live DB counts, and the
 * lastRefresh timestamps/summaries reset when the API process restarts.
 */
@Injectable()
export class InstrumentStatsService {
  private readonly summaries = new Map<Broker, ImportSummary>();

  constructor(private readonly prisma: PrismaService) {}

  record(summary: ImportSummary) {
    this.summaries.set(summary.broker, summary);
  }

  getSummary(broker: Broker): ImportSummary | null {
    return this.summaries.get(broker) ?? null;
  }

  getAllSummaries(): Record<string, ImportSummary> {
    const out: Record<string, ImportSummary> = {};
    for (const [broker, summary] of this.summaries.entries()) {
      out[broker] = summary;
    }
    return out;
  }

  async snapshot() {
    const [canonical, brokerMappings, zerodha, fyers] = await Promise.all([
      this.prisma.instrument.count(),
      this.prisma.instrumentBroker.count(),
      this.prisma.instrumentBroker.count({ where: { broker: Broker.ZERODHA } }),
      this.prisma.instrumentBroker.count({ where: { broker: Broker.FYERS } }),
    ]);

    const summaries = this.getAllSummaries();

    // Overall lastRefresh = latest finishedAt across recorded imports.
    let overall: string | null = null;
    for (const s of Object.values(summaries)) {
      if (!overall || s.finishedAt > overall) overall = s.finishedAt;
    }

    return {
      counts: {
        canonical,
        brokerMappings,
        zerodha,
        fyers,
      },
      lastRefresh: {
        overall,
        zerodha: summaries[Broker.ZERODHA]?.finishedAt ?? null,
        fyers: summaries[Broker.FYERS]?.finishedAt ?? null,
      },
      lastSummaries: summaries,
    };
  }
}
