import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
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
