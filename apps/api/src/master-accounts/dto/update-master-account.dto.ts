import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { Broker } from '@prisma/client';

export class UpdateMasterAccountDto {
  @IsOptional() @IsEnum(Broker) broker?: Broker;
  @IsOptional() @IsString() platform?: string;
  @IsOptional() @IsString() nickname?: string;
  @IsOptional() @IsString() clientId?: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() apiSecret?: string;
  @IsOptional() @IsString() vendorCode?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() totpSecret?: string;
  @IsOptional() @IsString() staticIpPrimary?: string;
  @IsOptional() @IsString() staticIpSecondary?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
