import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { StrategyStatus, Visibility } from '@prisma/client';

export class UpdateStrategyDto {
  @IsOptional() @IsString() strategyName?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(Visibility) visibility?: Visibility;
  @IsOptional() @IsBoolean() masterAccount?: boolean;
  @IsOptional() @IsInt() @Min(1) baseQuantity?: number;
  @IsOptional() @IsInt() @Min(0) maxFollowers?: number;
  @IsOptional() @IsEnum(StrategyStatus) status?: StrategyStatus;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
