import { IsNumber, IsOptional, IsString, IsPositive } from 'class-validator';

export class SubscribeDto {
  @IsString()
  strategyId!: string;

  @IsString()
  tradingAccountId!: string;

  @IsNumber()
  @IsPositive()
  multiplier!: number;

  @IsOptional() @IsNumber() maximumLoss?: number;
  @IsOptional() @IsNumber() maximumDailyLoss?: number;
}
