import { IsBoolean, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { Broker } from '@prisma/client';

export class CreateTradingAccountDto {
  @IsEnum(Broker)
  broker!: Broker;

  @IsString()
  @MinLength(1)
  platform!: string;

  @IsString()
  @MinLength(1)
  nickname!: string;

  @IsString()
  @MinLength(1)
  clientId!: string;

  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() apiSecret?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() totpSecret?: string;
  @IsOptional() @IsString() staticIpPrimary?: string;
  @IsOptional() @IsString() staticIpSecondary?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
