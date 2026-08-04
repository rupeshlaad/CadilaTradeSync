import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Sprint 5.4 — DTO for POST /admin/manual-trading/place.
 *
 * The global ValidationPipe (whitelist + forbidNonWhitelisted) is
 * already enabled in main.ts, so anything not listed here is stripped
 * / rejected before the controller sees the request.
 */
export class PlaceManualTradeDto {
  @IsString()
  @IsNotEmpty()
  masterAccountId!: string;

  @IsString()
  @IsNotEmpty()
  strategyId!: string;

  @IsString()
  @IsNotEmpty()
  exchange!: string;

  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @IsIn(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT', 'SL', 'SL-M'])
  orderType!: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

  @IsInt()
  @IsPositive()
  @Max(1_000_000)
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  quantity!: number;

  @IsIn(['CNC', 'MIS', 'NRML'])
  product!: 'CNC' | 'MIS' | 'NRML';

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Transform(({ value }) =>
    value === '' || value === undefined || value === null
      ? undefined
      : typeof value === 'string'
      ? Number(value)
      : value,
  )
  price?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Transform(({ value }) =>
    value === '' || value === undefined || value === null
      ? undefined
      : typeof value === 'string'
      ? Number(value)
      : value,
  )
  triggerPrice?: number;

  @IsOptional()
  @IsIn(['DAY', 'IOC'])
  validity?: 'DAY' | 'IOC';
}
