import { IsBoolean, IsNumber, IsOptional, IsPositive } from 'class-validator';

export class UpdateFollowerDto {
  @IsOptional() @IsNumber() @IsPositive() multiplier?: number;
  @IsOptional() @IsNumber() maximumLoss?: number;
  @IsOptional() @IsNumber() maximumDailyLoss?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
