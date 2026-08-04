import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, MinLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Broker } from '@prisma/client';

export class SearchInstrumentsDto {
  /** Free-text query — matched against brokerSymbol (prefix) and underlying (contains), case-insensitive. */
  @IsString()
  q!: string;

  /** Restrict to a single broker's symbol universe. If omitted, both brokers are searched. */
  @IsOptional()
  @IsEnum(Broker)
  broker?: Broker;

  /** e.g. NSE, BSE, NFO, BFO */
  @IsOptional()
  @IsString()
  exchange?: string;

  /** e.g. NSE, NFO */
  @IsOptional()
  @IsString()
  segment?: string;

  /** e.g. EQ, CE, PE, FUT */
  @IsOptional()
  @IsString()
  instrumentType?: string;

  /** Optional cap on the number of matches returned (default 25, max 100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class LookupInstrumentDto {
  @IsEnum(Broker)
  broker!: Broker;

  @IsString()
  symbol!: string;
}

export class TranslateInstrumentDto {
  @IsEnum(Broker)
  fromBroker!: Broker;

  @IsString()
  fromSymbol!: string;

  @IsEnum(Broker)
  toBroker!: Broker;
}

export class ResolveByContractKeyDto {
  @IsString()
  contractKey!: string;
}

/**
 * Sprint 5.4.1 — Manual Trading instrument autocomplete.
 *
 * Broker-scoped, relevance-ranked search over the InstrumentBroker
 * join table so the manual-trading UI can offer a typeahead picker
 * that always yields a valid broker-symbol mapping (which is the
 * exact string the master broker adapter needs at placement time).
 *
 * The query intentionally requires both `broker` and `q` so the API
 * cannot be called speculatively — every result corresponds to an
 * actual, orderable symbol on the caller's chosen master broker.
 */
export class ManualInstrumentSearchDto {
  /** Broker whose symbol universe should be searched. */
  @IsEnum(Broker)
  broker!: Broker;

  /** Free-text query — minimum 2 characters. */
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  q!: string;

  /** Result cap (default 20, max 50). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
