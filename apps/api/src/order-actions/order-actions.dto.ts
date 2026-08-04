import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Sprint 5.5.1 — DTOs for the Order Actions admin API.
 *
 * The global ValidationPipe (whitelist + forbidNonWhitelisted) is
 * already enabled in main.ts; unknown keys are stripped/rejected
 * before the controller sees them.
 */

/**
 * Modify an eligible master order. Every field is optional — the
 * service applies the DTO on top of the currently-tracked position
 * values so a caller can patch just the quantity (or just the
 * price / trigger price / order type) without re-declaring the
 * whole payload.
 */
export class ModifyOrderDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(1_000_000)
  @Transform(({ value }) =>
    value === '' || value === undefined || value === null
      ? undefined
      : typeof value === 'string'
      ? Number(value)
      : value,
  )
  quantity?: number;

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
  @IsIn(['MARKET', 'LIMIT', 'SL', 'SL-M'])
  orderType?: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ExitOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
