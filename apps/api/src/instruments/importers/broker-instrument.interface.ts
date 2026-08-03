import { Broker } from '@prisma/client';

export interface ParsedInstrument {

  contractKey: string;

  exchange: string;

  segment: string;

  underlying: string;

  instrumentType: string;

  expiry: Date | null;

  strike: number | null;

  optionType: string | null;

  lotSize: number;

  tickSize: number;

  broker: Broker;

  brokerSymbol: string;

  brokerToken: string | null;

}

export interface ImportSummary {
  broker: Broker;
  downloaded: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}
